import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCodexUsageJsonl, parseCodexUsageLine } from "./codex-usage.js";

describe("parseCodexUsageLine", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses Codex token-count rate limits into a normalized snapshot", () => {
    const primaryResetsAt = 4102445641;
    const secondaryResetsAt = 4103050441;
    const reading = parseCodexUsageLine(
      JSON.stringify({
        timestamp: "2026-03-05T22:32:30.887Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            plan_type: "plus",
            primary: {
              used_percent: 4.0,
              resets_at: primaryResetsAt,
            },
            secondary: {
              used_percent: 11.0,
              resets_at: secondaryResetsAt,
            },
          },
        },
      }),
    );

    expect(reading).toMatchObject({
      limitId: "codex",
      planType: "plus",
      snapshot: {
        five_hour: 0.04,
        seven_day: 0.11,
        five_hour_resets_at: new Date(primaryResetsAt * 1000).toISOString(),
        seven_day_resets_at: new Date(secondaryResetsAt * 1000).toISOString(),
        last_checked: "2026-03-05T22:32:30.887Z",
      },
    });
  });

  it("zeros out expired windows from stale snapshots", () => {
    const primaryResetsAt = 1772766841;
    const secondaryResetsAt = 4103050441;
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-03-07T00:00:00.000Z").getTime());

    const reading = parseCodexUsageLine(
      JSON.stringify({
        timestamp: "2026-03-05T22:32:30.887Z",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: {
              used_percent: 88,
              resets_at: primaryResetsAt,
            },
            secondary: {
              used_percent: 11,
              resets_at: secondaryResetsAt,
            },
          },
        },
      }),
    );

    expect(reading?.snapshot).toMatchObject({
      five_hour: 0,
      five_hour_resets_at: null,
      seven_day: 0.11,
      seven_day_resets_at: new Date(secondaryResetsAt * 1000).toISOString(),
    });
  });
});

describe("parseCodexUsageJsonl", () => {
  it("prefers the generic codex bucket when multiple limit ids are present", () => {
    const futurePrimary = 4102445641;
    const futureSecondary = 4103050441;
    const reading = parseCodexUsageJsonl([
      JSON.stringify({
        timestamp: "2026-03-01T23:25:36.105Z",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex_bengalfox",
            primary: { used_percent: 40, resets_at: futurePrimary + 60 },
            secondary: { used_percent: 0, resets_at: futureSecondary + 60 },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-01T23:25:28.544Z",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 5, resets_at: futurePrimary },
            secondary: { used_percent: 3, resets_at: futureSecondary },
          },
        },
      }),
    ].join("\n"));

    expect(reading?.limitId).toBe("codex");
    expect(reading?.snapshot.five_hour).toBe(0.05);
  });

  it("falls back to the latest non-generic limit when no codex bucket exists", () => {
    const futurePrimary = 4102445641;
    const futureSecondary = 4103050441;
    const reading = parseCodexUsageJsonl([
      JSON.stringify({
        timestamp: "2026-03-01T23:20:28.786Z",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex_bengalfox",
            primary: { used_percent: 12, resets_at: futurePrimary + 60 },
            secondary: { used_percent: 6, resets_at: futureSecondary + 60 },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-01T23:20:20.745Z",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex_mini",
            primary: { used_percent: 2, resets_at: futurePrimary },
            secondary: { used_percent: 1, resets_at: futureSecondary },
          },
        },
      }),
    ].join("\n"));

    expect(reading).toMatchObject({
      limitId: "codex_bengalfox",
      snapshot: {
        five_hour: 0.12,
        seven_day: 0.06,
      },
    });
  });
});
