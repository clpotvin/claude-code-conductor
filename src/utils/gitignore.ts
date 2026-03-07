import fs from "node:fs/promises";
import path from "node:path";

/**
 * Patterns that the conductor creates in the target project and should
 * not be committed to source control.
 */
const CONDUCTOR_GITIGNORE_ENTRIES = [
  ".conductor/",
  ".codex-reviews/",
  ".codex/",
];

/**
 * Ensure conductor-related directories are listed in the project's .gitignore.
 * If the .gitignore doesn't exist, creates one. If entries are already present,
 * does nothing. Appends missing entries with a descriptive comment block.
 */
export async function ensureGitignore(projectDir: string): Promise<void> {
  const gitignorePath = path.join(projectDir, ".gitignore");

  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // File doesn't exist yet — will create it
  }

  // Parse existing lines (trim whitespace, ignore comments for matching)
  const existingLines = new Set(
    existing.split("\n").map((line) => line.trim()),
  );

  const missing = CONDUCTOR_GITIGNORE_ENTRIES.filter(
    (entry) => !existingLines.has(entry),
  );

  if (missing.length === 0) return;

  // Build the block to append
  const block = [
    "",
    "# Claude Code Conductor (C3) — generated state, not source code",
    ...missing,
    "",
  ].join("\n");

  // Ensure we start on a new line if the file doesn't end with one
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";

  await fs.writeFile(gitignorePath, existing + separator + block, "utf-8");
}
