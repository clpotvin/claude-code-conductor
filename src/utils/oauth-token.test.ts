import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readOAuthToken } from "./oauth-token.js";

// The oauth-token module uses:
// - fs from "fs/promises" (async)
// - execFile from "child_process" (promisified to async via util.promisify)
// We mock the modules to test the async I/O paths (H22/H24 fixes).

vi.mock("fs/promises", () => ({
  default: {
    access: vi.fn(),
    readFile: vi.fn(),
  },
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

// We need promisify to return a function that returns promises
// so the module's execFileAsync works correctly
vi.mock("util", () => ({
  promisify: () => {
    // Return a mock async function for execFileAsync
    return vi.fn().mockRejectedValue(new Error("no keychain"));
  },
}));

describe("readOAuthToken (H22/H24 - async I/O verification)", () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it("returns env var token when CLAUDE_CODE_OAUTH_TOKEN is set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token-123";
    const token = await readOAuthToken();
    expect(token).toBe("env-token-123");
  });

  it("returns null when no token sources are available", async () => {
    // No env var set, fs.access mock will reject, keychain mock will reject
    const token = await readOAuthToken();
    expect(token).toBeNull();
  });

  it("is an async function that returns a Promise", () => {
    // H22/H24: The function must be async (not using execSync/readFileSync)
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test";
    const result = readOAuthToken();
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("readOAuthToken source code verification (H22/H24)", () => {
  it("source code uses async fs.readFile (not readFileSync)", async () => {
    const realFs = await vi.importActual<{ default: typeof import("fs/promises") }>("fs/promises");
    const pathMod = await vi.importActual<typeof import("path")>("path");
    const { fileURLToPath } = await vi.importActual<typeof import("url")>("url");
    const thisDir = pathMod.dirname(fileURLToPath(import.meta.url));
    const source = await realFs.default.readFile(
      pathMod.join(thisDir, "oauth-token.ts"),
      "utf-8",
    );

    // Must NOT contain sync I/O function calls (not counting comments)
    // Remove comments before checking for sync calls
    const sourceNoComments = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sourceNoComments).not.toContain("readFileSync");
    expect(sourceNoComments).not.toContain("execSync(");
    expect(sourceNoComments).not.toContain("accessSync");

    // Must contain async I/O
    expect(source).toContain("fs.readFile");
    expect(source).toContain("fs.access");
    expect(source).toContain("execFileAsync");

    // Must import from async-compatible modules
    expect(source).toContain('from "fs/promises"');
  });
});
