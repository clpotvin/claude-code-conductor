import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensureGitignore } from "./gitignore.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitignore-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("ensureGitignore", () => {
  it("creates .gitignore if it does not exist", async () => {
    await ensureGitignore(tempDir);

    const content = await fs.readFile(path.join(tempDir, ".gitignore"), "utf-8");
    expect(content).toContain(".conductor/");
    expect(content).toContain(".codex-reviews/");
    expect(content).toContain(".codex/");
    expect(content).toContain("# Claude Code Conductor");
  });

  it("appends missing entries to existing .gitignore", async () => {
    await fs.writeFile(path.join(tempDir, ".gitignore"), "node_modules/\ndist/\n");

    await ensureGitignore(tempDir);

    const content = await fs.readFile(path.join(tempDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain("dist/");
    expect(content).toContain(".conductor/");
    expect(content).toContain(".codex-reviews/");
    expect(content).toContain(".codex/");
  });

  it("does not duplicate entries that already exist", async () => {
    await fs.writeFile(
      path.join(tempDir, ".gitignore"),
      "node_modules/\n.conductor/\n.codex-reviews/\n.codex/\n",
    );

    await ensureGitignore(tempDir);

    const content = await fs.readFile(path.join(tempDir, ".gitignore"), "utf-8");
    const conductorMatches = content.match(/\.conductor\//g);
    expect(conductorMatches).toHaveLength(1);
  });

  it("only appends entries that are missing", async () => {
    await fs.writeFile(
      path.join(tempDir, ".gitignore"),
      ".conductor/\n",
    );

    await ensureGitignore(tempDir);

    const content = await fs.readFile(path.join(tempDir, ".gitignore"), "utf-8");
    // .conductor/ already there, should not be duplicated
    const conductorMatches = content.match(/\.conductor\//g);
    expect(conductorMatches).toHaveLength(1);
    // .codex-reviews/ and .codex/ should be added
    expect(content).toContain(".codex-reviews/");
    expect(content).toContain(".codex/");
  });

  it("handles .gitignore without trailing newline", async () => {
    await fs.writeFile(path.join(tempDir, ".gitignore"), "node_modules/");

    await ensureGitignore(tempDir);

    const content = await fs.readFile(path.join(tempDir, ".gitignore"), "utf-8");
    // Should not mash entries onto the same line as node_modules/
    expect(content).not.toContain("node_modules/.conductor/");
    expect(content).toContain("node_modules/\n");
    expect(content).toContain(".conductor/");
  });

  it("is idempotent — second call changes nothing", async () => {
    await ensureGitignore(tempDir);
    const first = await fs.readFile(path.join(tempDir, ".gitignore"), "utf-8");

    await ensureGitignore(tempDir);
    const second = await fs.readFile(path.join(tempDir, ".gitignore"), "utf-8");

    expect(second).toBe(first);
  });
});
