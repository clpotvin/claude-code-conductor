/**
 * Tests for cli.ts fixes:
 *
 * - H31: Signal handlers release process lock before calling process.exit
 * - Resume command uses DEFAULT_USAGE_THRESHOLD constant
 * - ConductorExitError handling in catch blocks
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

describe("CLI signal handler fixes (H31)", () => {
  it("start command signal handler releases lock before exit", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    // Find the start command's shutdown function
    const startSection = source.substring(
      source.indexOf('.command("start")'),
      source.indexOf('.command("status")'),
    );

    // Should release lock before process.exit(0)
    const shutdownFn = startSection.substring(
      startSection.indexOf("const shutdown = async"),
      startSection.indexOf("process.on('SIGINT'"),
    );
    expect(shutdownFn).toContain("releaseLock");
    // Should call releaseLock before process.exit(0)
    const releaseLockIndex = shutdownFn.indexOf("await releaseLock()");
    const processExitIndex = shutdownFn.indexOf("process.exit(0)");
    expect(releaseLockIndex).toBeLessThan(processExitIndex);
    expect(releaseLockIndex).toBeGreaterThan(0);
  });

  it("resume command signal handler releases lock before exit", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    // Find the resume command's shutdown function
    const resumeSection = source.substring(
      source.indexOf('.command("resume")'),
      source.indexOf('.command("pause")'),
    );

    // Should release lock before process.exit(0)
    const shutdownFn = resumeSection.substring(
      resumeSection.indexOf("const shutdown = async"),
      resumeSection.indexOf("process.on('SIGINT'"),
    );
    expect(shutdownFn).toContain("releaseLock");
    const releaseLockIndex = shutdownFn.indexOf("await releaseLock()");
    const processExitIndex = shutdownFn.indexOf("process.exit(0)");
    expect(releaseLockIndex).toBeLessThan(processExitIndex);
    expect(releaseLockIndex).toBeGreaterThan(0);
  });
});

describe("CLI resume usageThreshold", () => {
  it("resume command uses DEFAULT_USAGE_THRESHOLD constant as fallback", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    // Should import DEFAULT_USAGE_THRESHOLD
    expect(source).toContain("DEFAULT_USAGE_THRESHOLD");
    // Should use the constant in resume command
    const resumeSection = source.substring(
      source.indexOf('.command("resume")'),
      source.indexOf('.command("pause")'),
    );
    expect(resumeSection).toContain("DEFAULT_USAGE_THRESHOLD");
    // Should NOT have hardcoded 0.8 for usageThreshold in resume
    expect(resumeSection).not.toContain("usageThreshold: 0.8");
  });

  it("resume command uses saved state.usage_threshold when no CLI override", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    const resumeSection = source.substring(
      source.indexOf('.command("resume")'),
      source.indexOf('.command("pause")'),
    );
    // Should reference state.usage_threshold to recover the saved threshold
    expect(resumeSection).toContain("state.usage_threshold");
    // The fallback chain should be: CLI flag > saved state > DEFAULT
    // i.e. state.usage_threshold ?? DEFAULT_USAGE_THRESHOLD
    expect(resumeSection).toContain("state.usage_threshold ?? DEFAULT_USAGE_THRESHOLD");
  });

  it("resume command accepts --usage-threshold CLI option", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    const resumeSection = source.substring(
      source.indexOf('.command("resume")'),
      source.indexOf('.command("pause")'),
    );
    // Resume command should define the --usage-threshold option
    expect(resumeSection).toContain("--usage-threshold");
    // Should use opts.usageThreshold to check for CLI override
    expect(resumeSection).toContain("opts.usageThreshold");
    // Should parseFloat the CLI value
    expect(resumeSection).toContain("parseFloat(opts.usageThreshold");
  });

  it("resume command validates usageThreshold bounds", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    const resumeSection = source.substring(
      source.indexOf('.command("resume")'),
      source.indexOf('.command("pause")'),
    );
    // Should call validateBounds for usageThreshold
    expect(resumeSection).toContain('validateBounds("usageThreshold"');
  });
});

describe("CLI ConductorExitError handling", () => {
  it("start command catches ConductorExitError", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    const startSection = source.substring(
      source.indexOf('.command("start")'),
      source.indexOf('.command("status")'),
    );
    expect(startSection).toContain("ConductorExitError");
    expect(startSection).toContain("err.exitCode");
  });

  it("resume command catches ConductorExitError", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    const resumeSection = source.substring(
      source.indexOf('.command("resume")'),
      source.indexOf('.command("pause")'),
    );
    expect(resumeSection).toContain("ConductorExitError");
    expect(resumeSection).toContain("err.exitCode");
  });

  it("imports ConductorExitError from types", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    expect(source).toContain("ConductorExitError");
    // Should be imported from types
    expect(source).toMatch(/import.*ConductorExitError.*from.*types/);
  });
});

describe("CLI type safety", () => {
  it("releaseLock is set to undefined not null after release", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli.ts"),
      "utf-8",
    );
    // Should use undefined, not null
    // The signal handler should set releaseLock = undefined after releasing
    expect(source).toContain("releaseLock = undefined");
    // Should NOT have releaseLock = null anywhere
    expect(source).not.toContain("releaseLock = null");
  });
});

describe("CLI start command stores usageThreshold in state", () => {
  it("orchestrator passes usageThreshold to state.initialize()", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/orchestrator.ts"),
      "utf-8",
    );
    // Both initialize() call sites should pass usageThreshold
    const initCalls = source.split("state.initialize(");
    // Should be at least 2 calls (currentBranch mode + normal mode)
    expect(initCalls.length).toBeGreaterThanOrEqual(3); // 1 for first part + 2 for calls
    // Both should include usageThreshold in the options
    for (let i = 1; i < initCalls.length; i++) {
      const callBlock = initCalls[i].substring(0, 500);
      expect(callBlock).toContain("usageThreshold");
    }
  });
});

describe("usage_threshold in OrchestratorState type and schema", () => {
  it("OrchestratorState type includes optional usage_threshold field", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/types.ts"),
      "utf-8",
    );
    const stateInterface = source.substring(
      source.indexOf("export interface OrchestratorState"),
      source.indexOf("export type OrchestratorStatus"),
    );
    // Should have usage_threshold as optional field
    expect(stateInterface).toContain("usage_threshold?: number");
  });

  it("Zod schema includes optional usage_threshold field", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/state-schema.ts"),
      "utf-8",
    );
    // Should have usage_threshold in the schema
    expect(source).toContain("usage_threshold:");
    // Should be optional
    expect(source).toContain("usage_threshold: z.number()");
    expect(source).toMatch(/usage_threshold:.*\.optional\(\)/);
  });

  it("state-manager initialize() accepts usageThreshold option", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/state-manager.ts"),
      "utf-8",
    );
    const initMethod = source.substring(
      source.indexOf("async initialize("),
      source.indexOf("async load(") !== -1
        ? source.indexOf("async load(")
        : source.indexOf("async save("),
    );
    // Should accept usageThreshold in options
    expect(initMethod).toContain("usageThreshold?: number");
    // Should store it in state
    expect(initMethod).toContain("usage_threshold: options.usageThreshold");
  });

  it("Zod schema validates usage_threshold is between 0.1 and 1.0", async () => {
    const { OrchestratorStateSchema } = await import("./utils/state-schema.js");

    // Valid state with usage_threshold
    const validState = {
      status: "paused",
      feature: "test",
      project_path: "/tmp/test",
      branch: "conduct/test",
      worker_runtime: "claude",
      base_commit_sha: null,
      current_cycle: 1,
      max_cycles: 5,
      concurrency: 2,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      paused_at: null,
      resume_after: null,
      usage: {
        five_hour: 0.5,
        seven_day: 0.3,
        five_hour_resets_at: null,
        seven_day_resets_at: null,
        last_checked: new Date().toISOString(),
      },
      claude_usage: null,
      codex_usage: null,
      codex_metrics: null,
      active_session_ids: [],
      cycle_history: [],
      progress: "",
      usage_threshold: 0.7,
    };

    // Valid with usage_threshold
    const resultWithThreshold = OrchestratorStateSchema.safeParse(validState);
    expect(resultWithThreshold.success).toBe(true);
    if (resultWithThreshold.success) {
      expect(resultWithThreshold.data.usage_threshold).toBe(0.7);
    }

    // Valid without usage_threshold (optional)
    const { usage_threshold: _, ...stateWithout } = validState;
    const resultWithout = OrchestratorStateSchema.safeParse(stateWithout);
    expect(resultWithout.success).toBe(true);

    // Invalid: below 0.1
    const invalidLow = { ...validState, usage_threshold: 0.05 };
    const resultLow = OrchestratorStateSchema.safeParse(invalidLow);
    expect(resultLow.success).toBe(false);

    // Invalid: above 1.0
    const invalidHigh = { ...validState, usage_threshold: 1.5 };
    const resultHigh = OrchestratorStateSchema.safeParse(invalidHigh);
    expect(resultHigh.success).toBe(false);
  });
});
