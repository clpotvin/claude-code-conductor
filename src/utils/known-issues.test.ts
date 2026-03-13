/**
 * Tests for known-issues.ts — H34 fix (file locking) and loadKnownIssues hardening.
 *
 * Verifies:
 * - loadKnownIssues handles corrupt JSON gracefully
 * - loadKnownIssues handles non-array JSON gracefully
 * - addKnownIssues and markIssuesAddressed use file locking
 * - Concurrent addKnownIssues calls don't lose data
 * - saveKnownIssues uses secure file permissions
 */

import { describe, expect, it, afterEach, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  loadKnownIssues,
  saveKnownIssues,
  addKnownIssues,
  markIssuesAddressed,
  getUnresolvedIssues,
} from "./known-issues.js";

let tempDir: string;
let conductorDir: string;

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `known-issues-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  conductorDir = path.join(tempDir, ".conductor");
  await fs.mkdir(conductorDir, { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ============================================================
// loadKnownIssues
// ============================================================

describe("loadKnownIssues", () => {
  it("returns empty array when file does not exist", async () => {
    const result = await loadKnownIssues(tempDir);
    expect(result).toEqual([]);
  });

  it("returns parsed array from valid JSON", async () => {
    const issues = [
      {
        id: "abc-123",
        description: "Test issue",
        severity: "high",
        source: "codex_review",
        found_in_cycle: 1,
        addressed: false,
      },
    ];
    const issuesPath = path.join(conductorDir, "known-issues.json");
    await fs.writeFile(issuesPath, JSON.stringify(issues));
    const result = await loadKnownIssues(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("abc-123");
  });

  it("returns empty array for corrupt JSON (SyntaxError)", async () => {
    const issuesPath = path.join(conductorDir, "known-issues.json");
    await fs.writeFile(issuesPath, "{not valid json[[[");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await loadKnownIssues(tempDir);
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("Error loading");
    warnSpy.mockRestore();
  });

  it("returns empty array when JSON is not an array", async () => {
    const issuesPath = path.join(conductorDir, "known-issues.json");
    await fs.writeFile(issuesPath, '{"not": "an array"}');
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await loadKnownIssues(tempDir);
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("Expected array");
    warnSpy.mockRestore();
  });

  it("returns empty array for empty file", async () => {
    const issuesPath = path.join(conductorDir, "known-issues.json");
    await fs.writeFile(issuesPath, "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await loadKnownIssues(tempDir);
    expect(result).toEqual([]);
    warnSpy.mockRestore();
  });
});

// ============================================================
// addKnownIssues
// ============================================================

describe("addKnownIssues", () => {
  it("adds issues to empty registry", async () => {
    const result = await addKnownIssues(tempDir, [
      {
        description: "Test finding",
        severity: "high",
        source: "codex_review",
        found_in_cycle: 1,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("Test finding");
    expect(result[0]!.id).toBeTruthy();
    expect(result[0]!.addressed).toBe(false);
  });

  it("deduplicates by file_path + description prefix", async () => {
    await addKnownIssues(tempDir, [
      {
        description: "Duplicate issue",
        severity: "high",
        source: "codex_review",
        file_path: "src/foo.ts",
        found_in_cycle: 1,
      },
    ]);

    const result = await addKnownIssues(tempDir, [
      {
        description: "Duplicate issue",
        severity: "medium",
        source: "flow_tracing",
        file_path: "src/foo.ts",
        found_in_cycle: 2,
      },
    ]);

    // Should not add the duplicate
    expect(result).toHaveLength(1);
  });

  it("handles concurrent calls without data loss (H34)", async () => {
    // Run multiple addKnownIssues calls concurrently
    const promises = Array.from({ length: 5 }, (_, i) =>
      addKnownIssues(tempDir, [
        {
          description: `Concurrent issue ${i}`,
          severity: "high",
          source: "codex_review",
          file_path: `src/file-${i}.ts`,
          found_in_cycle: 1,
        },
      ]),
    );

    await Promise.all(promises);

    // All 5 issues should be present (locking prevents data loss)
    const loaded = await loadKnownIssues(tempDir);
    expect(loaded).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(loaded.some((issue) => issue.description === `Concurrent issue ${i}`)).toBe(true);
    }
  });
});

// ============================================================
// markIssuesAddressed
// ============================================================

describe("markIssuesAddressed", () => {
  it("marks specified issues as addressed", async () => {
    const added = await addKnownIssues(tempDir, [
      {
        description: "Issue 1",
        severity: "high",
        source: "codex_review",
        found_in_cycle: 1,
      },
      {
        description: "Issue 2",
        severity: "medium",
        source: "flow_tracing",
        found_in_cycle: 1,
      },
    ]);

    await markIssuesAddressed(tempDir, [added[0]!.id], 2);

    const loaded = await loadKnownIssues(tempDir);
    expect(loaded[0]!.addressed).toBe(true);
    expect(loaded[0]!.addressed_in_cycle).toBe(2);
    expect(loaded[1]!.addressed).toBe(false);
  });
});

// ============================================================
// getUnresolvedIssues
// ============================================================

describe("getUnresolvedIssues", () => {
  it("returns only unaddressed issues", async () => {
    const added = await addKnownIssues(tempDir, [
      {
        description: "Resolved issue",
        severity: "high",
        source: "codex_review",
        found_in_cycle: 1,
      },
      {
        description: "Unresolved issue",
        severity: "medium",
        source: "flow_tracing",
        found_in_cycle: 1,
      },
    ]);

    await markIssuesAddressed(tempDir, [added[0]!.id], 2);

    const unresolved = await getUnresolvedIssues(tempDir);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.description).toBe("Unresolved issue");
  });
});

// ============================================================
// saveKnownIssues (secure permissions)
// ============================================================

describe("saveKnownIssues", () => {
  it("creates file with secure permissions", async () => {
    await saveKnownIssues(tempDir, []);
    const issuesPath = path.join(conductorDir, "known-issues.json");
    const stat = await fs.stat(issuesPath);
    // Check file mode is 0o600 (owner rw only)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
