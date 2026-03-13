/**
 * Tests for prompt-compactor.ts fixes:
 *
 * - H27: replaceSection() uses line-anchored matching
 * - H28: Tier 4 compaction agent input is size-bounded and sanitized
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// ============================================================
// H27: replaceSection line-anchored matching
// ============================================================

describe("replaceSection line-anchored matching (H27)", () => {
  it("prompt-compactor uses line-anchored regex for replaceSection", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/prompt-compactor.ts"),
      "utf-8",
    );
    // Should use escapeRegex + RegExp with 'm' flag for line anchoring
    expect(source).toContain("escapeRegex(sectionHeader)");
    expect(source).toContain('"m"');
    // Should NOT use simple indexOf for header matching in replaceSection
    const replaceSectionFn = source.substring(
      source.indexOf("function replaceSection"),
      source.indexOf("function countFindingLines"),
    );
    expect(replaceSectionFn).not.toContain("prompt.indexOf(sectionHeader)");
    expect(replaceSectionFn).toContain("headerPattern.exec(prompt)");
  });

  it("contains an escapeRegex helper", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/prompt-compactor.ts"),
      "utf-8",
    );
    expect(source).toContain("function escapeRegex(str: string): string");
    // Should escape special regex characters
    expect(source).toContain("\\\\$&");
  });
});

// ============================================================
// H28: Compaction agent input bounds
// ============================================================

describe("compaction agent input sanitization (H28)", () => {
  it("applyTier4 truncates large prompts before sending to agent", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/prompt-compactor.ts"),
      "utf-8",
    );
    // Should have a MAX_COMPACTION_INPUT_CHARS limit
    expect(source).toContain("MAX_COMPACTION_INPUT_CHARS");
    // Should truncate the prompt
    expect(source).toContain("sanitizedPrompt.substring(0, MAX_COMPACTION_INPUT_CHARS)");
  });

  it("applyTier4 strips role markers from prompt", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/prompt-compactor.ts"),
      "utf-8",
    );
    // Should strip Human:/Assistant:/System: markers
    expect(source).toContain("Human|Assistant|System");
    expect(source).toContain("[role-marker]");
  });

  it("uses sanitizedPrompt not raw prompt in compaction agent", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/prompt-compactor.ts"),
      "utf-8",
    );
    // In applyTier4, find the systemPrompt array construction
    const tier4Section = source.substring(
      source.indexOf("async function applyTier4"),
    );
    // The prompt appended to systemPrompt should be sanitizedPrompt, not prompt
    expect(tier4Section).toContain("sanitizedPrompt,");
    // Verify it's used in the array
    const joinSection = tier4Section.substring(
      tier4Section.indexOf("Here is the prompt to compact:"),
      tier4Section.indexOf("].join"),
    );
    expect(joinSection).toContain("sanitizedPrompt");
    expect(joinSection).not.toMatch(/^\s*prompt,$/m);
  });
});
