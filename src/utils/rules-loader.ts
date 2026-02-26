import fs from "node:fs/promises";
import { getRulesPath, getWorkerRulesPath } from "./constants.js";

/**
 * Load project-specific worker rules from `.conductor/rules.md`
 * or `.conductor/worker-rules.md`. Returns empty string if neither exists.
 */
export async function loadWorkerRules(projectDir: string): Promise<string> {
  // Try rules.md first, then worker-rules.md
  const paths = [getRulesPath(projectDir), getWorkerRulesPath(projectDir)];

  for (const filePath of paths) {
    try {
      const contents = await fs.readFile(filePath, "utf-8");
      return contents;
    } catch {
      // File doesn't exist, try next
    }
  }

  return "";
}
