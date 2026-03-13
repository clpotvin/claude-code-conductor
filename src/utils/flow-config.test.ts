/**
 * Tests for flow-config.ts fixes:
 *
 * - console.warn replaced with process.stderr.write
 * - loadFlowConfig returns defaults for missing/invalid config
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { loadFlowConfig, DEFAULT_FLOW_CONFIG } from "./flow-config.js";

describe("loadFlowConfig", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns default config when no config file exists", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-config-test-"));
    const config = await loadFlowConfig(tempDir);
    expect(config).toEqual(DEFAULT_FLOW_CONFIG);
  });

  it("loads valid config from .conductor/flow-config.json", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-config-test-"));
    await fs.mkdir(path.join(tempDir, ".conductor"), { recursive: true });

    const customConfig = {
      layers: [
        { name: "Custom Layer", checks: ["Check 1"] },
      ],
      actor_types: ["user", "admin"],
      edge_cases: ["Edge 1"],
      example_flows: [],
    };
    await fs.writeFile(
      path.join(tempDir, ".conductor", "flow-config.json"),
      JSON.stringify(customConfig),
    );

    const config = await loadFlowConfig(tempDir);
    expect(config.layers).toEqual(customConfig.layers);
    expect(config.actor_types).toEqual(customConfig.actor_types);
  });

  it("uses default values for missing keys in partial config", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-config-test-"));
    await fs.mkdir(path.join(tempDir, ".conductor"), { recursive: true });

    // Only provide layers, missing other keys
    const partialConfig = {
      layers: [{ name: "Only Layer", checks: ["only check"] }],
    };
    // Spy on stderr to verify warning
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await fs.writeFile(
      path.join(tempDir, ".conductor", "flow-config.json"),
      JSON.stringify(partialConfig),
    );

    const config = await loadFlowConfig(tempDir);
    expect(config.layers).toEqual(partialConfig.layers);
    // Missing keys should use defaults
    expect(config.actor_types).toEqual(DEFAULT_FLOW_CONFIG.actor_types);
    expect(config.edge_cases).toEqual(DEFAULT_FLOW_CONFIG.edge_cases);
    expect(config.example_flows).toEqual(DEFAULT_FLOW_CONFIG.example_flows);

    // Should have warned about missing keys
    expect(stderrSpy).toHaveBeenCalled();
    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes("actor_types"))).toBe(true);

    stderrSpy.mockRestore();
  });

  it("returns defaults for malformed JSON", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-config-test-"));
    await fs.mkdir(path.join(tempDir, ".conductor"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, ".conductor", "flow-config.json"),
      "NOT VALID JSON {{{",
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const config = await loadFlowConfig(tempDir);
    expect(config).toEqual(DEFAULT_FLOW_CONFIG);

    // Should have logged a warning via stderr
    expect(stderrSpy).toHaveBeenCalled();
    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes("Failed to load"))).toBe(true);

    stderrSpy.mockRestore();
  });
});

// ============================================================
// Source verification: console.warn replaced
// ============================================================

describe("flow-config console.warn replacement", () => {
  it("flow-config.ts does not call console.warn()", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/flow-config.ts"),
      "utf-8",
    );
    // Strip comment lines to check only actual code
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly).not.toContain("console.warn(");
  });

  it("flow-config.ts uses process.stderr.write instead", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/flow-config.ts"),
      "utf-8",
    );
    expect(source).toContain("process.stderr.write");
  });
});
