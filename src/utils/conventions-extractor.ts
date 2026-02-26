import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectConventions } from "./types.js";
import { getConventionsPath, CONVENTIONS_EXTRACTION_MAX_TURNS } from "./constants.js";
import { queryWithTimeout } from "./sdk-timeout.js";

const DEFAULT_CONVENTIONS: ProjectConventions = {
  auth_patterns: [],
  validation_patterns: [],
  error_handling_patterns: [],
  test_patterns: [],
  directory_structure: [],
  naming_conventions: [],
  key_libraries: [],
  security_invariants: [],
};

const EXTRACTION_PROMPT = `You are a codebase conventions extractor. Your job is to analyze this project and extract its conventions into a structured JSON object.

Follow these steps carefully:

1. **Read project config files**: Read CLAUDE.md, README.md, package.json, and tsconfig.json if they exist in the current directory.

2. **Search for auth patterns**: Use Grep to search for patterns like "auth", "middleware", "session", "jwt", "token", "passport", "guard". Note what auth frameworks/patterns are used and how they are applied.

3. **Search for validation patterns**: Use Grep to search for "zod", "joi", "validate", "schema", "yup", "class-validator", "ajv". Note validation libraries and how input validation is structured.

4. **Search for error handling patterns**: Use Grep to search for "catch", "Error", "error.handler", "ErrorBoundary", "try {", "throw new". Note how errors are structured, logged, and propagated.

5. **Search for test patterns**: Use Glob to find test files (e.g., **/*.test.ts, **/*.spec.ts, **/__tests__/**). Use Grep to check for test framework imports ("vitest", "jest", "mocha", "chai"). Note test file naming conventions and frameworks.

6. **Check directory structure**: Use Bash with "ls -la" at the project root, and "ls" on src/ or similar top-level directories. Note the directory organization pattern (e.g., feature-based, layer-based).

7. **Check naming conventions**: Look at a few source files to determine naming patterns for files (kebab-case, camelCase, PascalCase), exports, types, and interfaces.

8. **Identify key libraries**: Read package.json dependencies to identify important libraries and their purposes.

9. **Identify security invariants**: Based on what you find, note any security patterns that must be maintained (e.g., "all API routes require auth middleware", "all user input is validated with zod").

After completing your analysis, output EXACTLY one JSON block in this format:

\`\`\`json
{
  "auth_patterns": ["description of each auth pattern found"],
  "validation_patterns": ["description of each validation pattern found"],
  "error_handling_patterns": ["description of each error handling pattern found"],
  "test_patterns": ["description of each test pattern found"],
  "directory_structure": ["description of directory organization"],
  "naming_conventions": ["description of naming conventions"],
  "key_libraries": [{"name": "library-name", "purpose": "what it's used for"}],
  "security_invariants": ["security rule that must be maintained"]
}
\`\`\`

If you find no examples for a category, use an empty array. Be specific and cite actual file paths or patterns you found. Do NOT guess -- only report what you actually find in the codebase.`;

/**
 * Extract project conventions by spawning a read-only SDK agent.
 * Results are cached to .conductor/conventions.json.
 * If cached and less than 1 hour old, returns cached version.
 */
export async function extractConventions(projectDir: string): Promise<ProjectConventions> {
  const conventionsPath = getConventionsPath(projectDir);

  // Check cache (< 1 hour old)
  try {
    const stat = await fs.stat(conventionsPath);
    const age = Date.now() - stat.mtimeMs;
    if (age < 3_600_000) {
      const cached = JSON.parse(await fs.readFile(conventionsPath, "utf-8"));
      return cached as ProjectConventions;
    }
  } catch {
    // No cache or unreadable -- proceed with extraction
  }

  // Spawn read-only agent to extract conventions
  let resultText = "";

  try {
    resultText = await queryWithTimeout(
      EXTRACTION_PROMPT,
      { allowedTools: ["Read", "Glob", "Grep", "Bash"], cwd: projectDir, maxTurns: CONVENTIONS_EXTRACTION_MAX_TURNS },
      5 * 60 * 1000, // 5 min
      "conventions-extraction",
    );
  } catch (error) {
    console.warn("Conventions extraction agent failed:", error);
    return { ...DEFAULT_CONVENTIONS };
  }

  // Parse the JSON output from the agent's response
  const conventions = parseConventionsOutput(resultText);

  // Ensure the directory exists and save cache
  try {
    await fs.mkdir(path.dirname(conventionsPath), { recursive: true });
    await fs.writeFile(conventionsPath, JSON.stringify(conventions, null, 2), "utf-8");
  } catch (error) {
    console.warn("Failed to cache conventions:", error);
  }

  return conventions;
}

/**
 * Parse the agent's output to extract the ProjectConventions JSON block.
 */
function parseConventionsOutput(text: string): ProjectConventions {
  if (!text) {
    return { ...DEFAULT_CONVENTIONS };
  }

  // Try to find a JSON code block
  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  const jsonText = jsonBlockMatch ? jsonBlockMatch[1] : text;

  try {
    const parsed = JSON.parse(jsonText.trim());

    // Validate the structure and fill in missing fields
    return {
      auth_patterns: Array.isArray(parsed.auth_patterns) ? parsed.auth_patterns : [],
      validation_patterns: Array.isArray(parsed.validation_patterns) ? parsed.validation_patterns : [],
      error_handling_patterns: Array.isArray(parsed.error_handling_patterns) ? parsed.error_handling_patterns : [],
      test_patterns: Array.isArray(parsed.test_patterns) ? parsed.test_patterns : [],
      directory_structure: Array.isArray(parsed.directory_structure) ? parsed.directory_structure : [],
      naming_conventions: Array.isArray(parsed.naming_conventions) ? parsed.naming_conventions : [],
      key_libraries: Array.isArray(parsed.key_libraries) ? parsed.key_libraries : [],
      security_invariants: Array.isArray(parsed.security_invariants) ? parsed.security_invariants : [],
    };
  } catch {
    console.warn("Failed to parse conventions JSON from agent output; using defaults.");
    return { ...DEFAULT_CONVENTIONS };
  }
}
