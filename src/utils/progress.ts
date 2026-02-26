import fs from "node:fs/promises";
import { getProgressLogPath } from "./constants.js";

/**
 * Append a progress entry to `.conductor/progress.jsonl`.
 *
 * Each line is a JSON object with timestamp, phase, and detail.
 * This file is designed to be tailed by external processes
 * (e.g., the /conduct slash command or `conduct status`).
 */
export async function logProgress(
  projectDir: string,
  phase: string,
  detail: string,
): Promise<void> {
  const entry = {
    timestamp: new Date().toISOString(),
    phase,
    detail,
  };

  const logPath = getProgressLogPath(projectDir);

  try {
    await fs.appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Best effort — don't crash the orchestrator for progress logging
  }
}
