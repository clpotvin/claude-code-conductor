import { describe, expect, it } from "vitest";

import { ConductorExitError } from "./types.js";

describe("ConductorExitError", () => {
  it("is an instance of Error", () => {
    const err = new ConductorExitError(2, "escalation");
    expect(err).toBeInstanceOf(Error);
  });

  it("carries exitCode and reason properties", () => {
    const err = new ConductorExitError(2, "usage limit reached");
    expect(err.exitCode).toBe(2);
    expect(err.reason).toBe("usage limit reached");
  });

  it("sets name to ConductorExitError", () => {
    const err = new ConductorExitError(1, "test");
    expect(err.name).toBe("ConductorExitError");
  });

  it("formats message with exit code and reason", () => {
    const err = new ConductorExitError(2, "escalation required");
    expect(err.message).toBe(
      "Conductor exit (code 2): escalation required",
    );
  });

  it("can be caught by standard try/catch", () => {
    let caught: unknown;
    try {
      throw new ConductorExitError(2, "test error");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConductorExitError);
    expect((caught as ConductorExitError).exitCode).toBe(2);
  });

  it("can be distinguished from generic errors", () => {
    const errors: Error[] = [
      new Error("generic"),
      new ConductorExitError(1, "conductor"),
    ];
    const conductorErrors = errors.filter(
      (e) => e instanceof ConductorExitError,
    );
    expect(conductorErrors).toHaveLength(1);
    expect((conductorErrors[0] as ConductorExitError).reason).toBe(
      "conductor",
    );
  });

  it("has a stack trace", () => {
    const err = new ConductorExitError(2, "has stack");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("ConductorExitError");
  });
});
