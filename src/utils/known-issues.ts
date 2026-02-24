import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getKnownIssuesPath } from "./constants.js";
import type { KnownIssue } from "./types.js";

/**
 * Load known issues from .orchestrator/known-issues.json.
 * Returns empty array if file doesn't exist.
 */
export async function loadKnownIssues(projectDir: string): Promise<KnownIssue[]> {
  const issuesPath = getKnownIssuesPath(projectDir);
  try {
    const contents = await fs.readFile(issuesPath, "utf-8");
    return JSON.parse(contents) as KnownIssue[];
  } catch {
    return [];
  }
}

/**
 * Save known issues to .orchestrator/known-issues.json.
 */
export async function saveKnownIssues(projectDir: string, issues: KnownIssue[]): Promise<void> {
  const issuesPath = getKnownIssuesPath(projectDir);
  await fs.mkdir(path.dirname(issuesPath), { recursive: true });
  await fs.writeFile(issuesPath, JSON.stringify(issues, null, 2), "utf-8");
}

/**
 * Add findings to the known issues registry. Deduplicates by file_path + description prefix.
 * Returns the updated list.
 */
export async function addKnownIssues(
  projectDir: string,
  newIssues: Omit<KnownIssue, "id" | "addressed" | "addressed_in_cycle">[],
): Promise<KnownIssue[]> {
  const existing = await loadKnownIssues(projectDir);

  // Build a set of dedup keys from existing issues
  const dedupKeys = new Set(
    existing.map((issue) => buildDedupKey(issue.file_path, issue.description)),
  );

  const toAdd: KnownIssue[] = [];
  for (const newIssue of newIssues) {
    const key = buildDedupKey(newIssue.file_path, newIssue.description);
    if (!dedupKeys.has(key)) {
      dedupKeys.add(key);
      toAdd.push({
        ...newIssue,
        id: randomUUID(),
        addressed: false,
        addressed_in_cycle: undefined,
      });
    }
  }

  const updated = [...existing, ...toAdd];
  await saveKnownIssues(projectDir, updated);
  return updated;
}

/**
 * Mark issues as addressed in a given cycle.
 */
export async function markIssuesAddressed(
  projectDir: string,
  issueIds: string[],
  cycle: number,
): Promise<void> {
  const issues = await loadKnownIssues(projectDir);
  const idSet = new Set(issueIds);

  for (const issue of issues) {
    if (idSet.has(issue.id)) {
      issue.addressed = true;
      issue.addressed_in_cycle = cycle;
    }
  }

  await saveKnownIssues(projectDir, issues);
}

/**
 * Get only unresolved issues.
 */
export async function getUnresolvedIssues(projectDir: string): Promise<KnownIssue[]> {
  const issues = await loadKnownIssues(projectDir);
  return issues.filter((issue) => !issue.addressed);
}

/**
 * Build a deduplication key from file_path and the first 80 characters of the description.
 */
function buildDedupKey(filePath: string | undefined, description: string): string {
  const prefix = description.slice(0, 80).toLowerCase().trim();
  return `${filePath ?? ""}::${prefix}`;
}
