import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UsageMonitor } from "./usage-monitor.js";
import { Logger } from "../utils/logger.js";

// Stub fetch globally
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Mock fs (used by both Logger and UsageMonitor for credential reads)
vi.mock("fs", () => {
  const mockStream = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  return {
    default: {
      mkdirSync: vi.fn(),
      createWriteStream: vi.fn(() => mockStream),
      existsSync: () => false,
      readFileSync: () => { throw new Error("not found"); },
    },
  };
});

vi.mock("node:child_process", () => ({
  execSync: () => { throw new Error("no keychain"); },
  // execFile is callback-style: (cmd, args, opts, callback) => void
  // promisify wraps it into an async function
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      (callback as (err: Error) => void)(new Error("no keychain"));
    }
  }),
}));

// Also mock child_process (without node: prefix) since oauth-token.ts imports from "child_process"
vi.mock("child_process", () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      (callback as (err: Error) => void)(new Error("no keychain"));
    }
  }),
}));

const testLogger = new Logger("/tmp/test-logs", "usage-monitor-test");

function makeMonitor(overrides?: { pollIntervalMs?: number }) {
  return new UsageMonitor({
    pollIntervalMs: overrides?.pollIntervalMs ?? 60_000,
    onWarning: () => {},
    onCritical: () => {},
    logger: testLogger,
  });
}

function makeApiResponse(fiveHourUtil: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      five_hour: { utilization: fiveHourUtil, resets_at: "2026-01-01T00:00:00Z" },
      seven_day: { utilization: 1.0, resets_at: "2026-01-07T00:00:00Z" },
    }),
  };
}

function make429Response() {
  return { ok: false, status: 429, statusText: "Too Many Requests" };
}

/**
 * poll() does internal sleep() calls for retry backoff (1s, 2s, 4s).
 * With fake timers we need to advance time for those sleeps to resolve.
 * We run the poll in parallel with timer advancement.
 */
async function pollWithFakeTimers(monitor: UsageMonitor): Promise<void> {
  const pollPromise = monitor.poll();
  // Advance past all retry backoff sleeps (1s + 2s + 4s = 7s total)
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  await pollPromise;
}

describe("UsageMonitor staleness tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    fetchMock.mockReset();
  });

  it("starts with zero consecutive failures and not stale", () => {
    const monitor = makeMonitor();
    expect(monitor.getConsecutiveFailures()).toBe(0);
    expect(monitor.getStaleDurationMs()).toBe(0);
    expect(monitor.isDataStale()).toBe(false);
  });

  it("records successful poll and resets staleness", async () => {
    const monitor = makeMonitor();
    fetchMock.mockResolvedValue(makeApiResponse(5.0));

    await monitor.poll();

    expect(monitor.getConsecutiveFailures()).toBe(0);
    expect(monitor.isDataStale()).toBe(false);
  });

  it("tracks consecutive failures on 429 responses (no retry)", async () => {
    const monitor = makeMonitor();
    fetchMock.mockResolvedValue(make429Response());

    // 429 no longer retries — returns immediately with failure
    await monitor.poll();

    expect(monitor.getConsecutiveFailures()).toBe(1);
    // Should only have made 1 fetch call (no retries on 429)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resets consecutive failures after a successful poll", async () => {
    const monitor = makeMonitor();

    // First poll: all retries fail with 429
    fetchMock.mockResolvedValue(make429Response());
    await pollWithFakeTimers(monitor);
    expect(monitor.getConsecutiveFailures()).toBe(1);

    // Second poll: success
    fetchMock.mockResolvedValue(makeApiResponse(10.0));
    await monitor.poll();
    expect(monitor.getConsecutiveFailures()).toBe(0);
  });

  it("reports stale after USAGE_STALE_THRESHOLD_MS without successful poll", async () => {
    const monitor = makeMonitor();
    fetchMock.mockResolvedValue(makeApiResponse(5.0));

    await monitor.poll();
    expect(monitor.isDataStale()).toBe(false);

    // Advance time past 30 min stale threshold (USAGE_STALE_THRESHOLD_MS)
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);

    expect(monitor.isDataStale()).toBe(true);
    expect(monitor.getStaleDurationMs()).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  it("clears stale status on successful poll", async () => {
    const monitor = makeMonitor();
    fetchMock.mockResolvedValue(makeApiResponse(5.0));

    await monitor.poll();
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(monitor.isDataStale()).toBe(true);

    await monitor.poll();
    expect(monitor.isDataStale()).toBe(false);
  });

  it("accumulates consecutive failures across multiple polls", async () => {
    const monitor = makeMonitor();
    fetchMock.mockResolvedValue(make429Response());

    await pollWithFakeTimers(monitor);
    await pollWithFakeTimers(monitor);
    await pollWithFakeTimers(monitor);

    expect(monitor.getConsecutiveFailures()).toBe(3);
  });

  it("tracks failure on network errors", async () => {
    const monitor = makeMonitor();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await pollWithFakeTimers(monitor);

    expect(monitor.getConsecutiveFailures()).toBe(1);
  });

  it("tracks failure when no OAuth token is available", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const monitor = makeMonitor();

    await monitor.poll();

    expect(monitor.getConsecutiveFailures()).toBe(1);
  });
});

describe("UsageMonitor rate tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    fetchMock.mockReset();
  });

  it("returns null rate with insufficient data (< 2 samples)", async () => {
    const monitor = makeMonitor();
    fetchMock.mockResolvedValue(makeApiResponse(5.0));

    await monitor.poll();
    expect(monitor.getUsageRatePerMinute()).toBeNull();
  });

  it("calculates usage rate from two samples", async () => {
    const monitor = makeMonitor();

    // First poll: 5%
    fetchMock.mockResolvedValue(makeApiResponse(5.0));
    await monitor.poll();

    // Advance 5 minutes
    vi.advanceTimersByTime(5 * 60 * 1000);

    // Second poll: 8% (3% increase over 5 minutes = 0.6%/min)
    fetchMock.mockResolvedValue(makeApiResponse(8.0));
    await monitor.poll();

    const rate = monitor.getUsageRatePerMinute();
    expect(rate).not.toBeNull();
    // 3% over 5 min = 0.6%/min = 0.006 as fraction
    expect(rate!).toBeCloseTo(0.006, 4);
  });

  it("calculates running average across multiple samples", async () => {
    const monitor = makeMonitor();

    // Sample 1: 10%
    fetchMock.mockResolvedValue(makeApiResponse(10.0));
    await monitor.poll();

    // 5 min later, 13% (+3%)
    vi.advanceTimersByTime(5 * 60 * 1000);
    fetchMock.mockResolvedValue(makeApiResponse(13.0));
    await monitor.poll();

    // 5 min later, 20% (+7%)
    vi.advanceTimersByTime(5 * 60 * 1000);
    fetchMock.mockResolvedValue(makeApiResponse(20.0));
    await monitor.poll();

    const rate = monitor.getUsageRatePerMinute();
    expect(rate).not.toBeNull();
    // 10% increase over 10 min = 1%/min = 0.01 as fraction
    expect(rate!).toBeCloseTo(0.01, 4);
  });

  it("estimates minutes until threshold", async () => {
    const monitor = makeMonitor(); // default threshold 0.80

    // 20%
    fetchMock.mockResolvedValue(makeApiResponse(20.0));
    await monitor.poll();

    // 5 min later, 25% (+5%, so 1%/min)
    vi.advanceTimersByTime(5 * 60 * 1000);
    fetchMock.mockResolvedValue(makeApiResponse(25.0));
    await monitor.poll();

    // At 25%, threshold at 80%, rate 1%/min → 55 min
    const eta = monitor.estimateMinutesUntilThreshold();
    expect(eta).not.toBeNull();
    expect(eta!).toBeCloseTo(55, 0);
  });

  it("returns 0 minutes when already past threshold", async () => {
    const monitor = makeMonitor();

    fetchMock.mockResolvedValue(makeApiResponse(80.0));
    await monitor.poll();

    vi.advanceTimersByTime(5 * 60 * 1000);
    fetchMock.mockResolvedValue(makeApiResponse(85.0));
    await monitor.poll();

    const eta = monitor.estimateMinutesUntilThreshold();
    expect(eta).toBe(0);
  });

  it("resets rate history on window reset (usage drops)", async () => {
    const monitor = makeMonitor();

    fetchMock.mockResolvedValue(makeApiResponse(50.0));
    await monitor.poll();

    vi.advanceTimersByTime(5 * 60 * 1000);
    fetchMock.mockResolvedValue(makeApiResponse(55.0));
    await monitor.poll();

    expect(monitor.getUsageRatePerMinute()).not.toBeNull();

    // Usage drops significantly — window reset
    vi.advanceTimersByTime(5 * 60 * 1000);
    fetchMock.mockResolvedValue(makeApiResponse(5.0));
    await monitor.poll();

    // Rate should be null — history was cleared, only 1 sample
    expect(monitor.getUsageRatePerMinute()).toBeNull();
  });

  it("isThresholdPredicted returns true when ETA < poll interval", async () => {
    const monitor = makeMonitor({ pollIntervalMs: 300_000 }); // 5 min polls

    // 70%
    fetchMock.mockResolvedValue(makeApiResponse(70.0));
    await monitor.poll();

    // 5 min later, 78% (+8%, so 1.6%/min) — threshold 80% is only 1.25 min away
    vi.advanceTimersByTime(5 * 60 * 1000);
    fetchMock.mockResolvedValue(makeApiResponse(78.0));
    await monitor.poll();

    expect(monitor.isThresholdPredicted()).toBe(true);
  });

  it("isThresholdPredicted returns false when ETA > poll interval", async () => {
    const monitor = makeMonitor({ pollIntervalMs: 300_000 });

    // 20%
    fetchMock.mockResolvedValue(makeApiResponse(20.0));
    await monitor.poll();

    // 5 min later, 22% — slow rate, far from threshold
    vi.advanceTimersByTime(5 * 60 * 1000);
    fetchMock.mockResolvedValue(makeApiResponse(22.0));
    await monitor.poll();

    expect(monitor.isThresholdPredicted()).toBe(false);
  });

  it("getRateSummary returns readable string", async () => {
    const monitor = makeMonitor();

    fetchMock.mockResolvedValue(makeApiResponse(10.0));
    await monitor.poll();

    vi.advanceTimersByTime(5 * 60 * 1000);
    fetchMock.mockResolvedValue(makeApiResponse(15.0));
    await monitor.poll();

    const summary = monitor.getRateSummary();
    expect(summary).toContain("rate:");
    expect(summary).toContain("%/min");
    expect(summary).toContain("ETA");
  });
});

describe("UsageMonitor adaptive polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    fetchMock.mockReset();
  });

  it("start() schedules polling and stop() clears it", async () => {
    const monitor = makeMonitor({ pollIntervalMs: 1000 });
    fetchMock.mockResolvedValue(makeApiResponse(5.0));

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    monitor.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start a second poller if already running", async () => {
    const monitor = makeMonitor();
    fetchMock.mockResolvedValue(makeApiResponse(5.0));

    monitor.start();
    monitor.start(); // Should warn but not create another
    await vi.advanceTimersByTimeAsync(0);

    monitor.stop();
  });

  it("stop() during in-flight poll prevents re-arming", async () => {
    const monitor = makeMonitor({ pollIntervalMs: 1000 });
    // First poll hangs (never resolves immediately)
    let resolveFirst!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

    monitor.start();
    // stop() while first poll is still in flight
    monitor.stop();

    // Now resolve the in-flight poll
    resolveFirst(makeApiResponse(5.0));
    await vi.advanceTimersByTimeAsync(0);

    // No further polls should fire (scheduleNextPoll checks running flag)
    fetchMock.mockResolvedValue(makeApiResponse(5.0));
    await vi.advanceTimersByTimeAsync(5000);
    // Only the initial call happened; no re-arm after stop
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("UsageMonitor waitForReset (H23 - bounded iterations)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    fetchMock.mockReset();
  });

  it("exits after MAX_WAIT_ITERATIONS when utilization never drops", async () => {
    const monitor = makeMonitor();

    // Set initial usage above the resume threshold (50%)
    fetchMock.mockResolvedValue(makeApiResponse(85.0));
    await monitor.poll();

    // Mock the reset time to be in the past so we skip the initial sleep
    const usage = monitor.getUsage();
    // Force five_hour_resets_at to be in the past
    (monitor as unknown as { currentUsage: { five_hour_resets_at: string } }).currentUsage.five_hour_resets_at =
      new Date(Date.now() - 1000).toISOString();

    // Every poll returns high utilization (never drops below 50%)
    fetchMock.mockResolvedValue(makeApiResponse(85.0));

    // Run waitForReset in parallel with timer advancement
    const waitPromise = monitor.waitForReset();

    // Advance through all 60 iterations (each waits 60s)
    // Plus initial poll + verification polls
    for (let i = 0; i < 65; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    await waitPromise;

    // The function should have exited (not hung forever)
    // It should have polled multiple times but bounded by MAX_WAIT_ITERATIONS (60)
    // fetchMock is called: 1 (initial poll to set currentUsage) + 1 (poll at start of waitForReset)
    // + up to 60 iterations of polling = max 62 calls
    const totalCalls = fetchMock.mock.calls.length;
    expect(totalCalls).toBeLessThanOrEqual(65); // Bounded
    expect(totalCalls).toBeGreaterThan(1); // Did actually poll
  });

  it("returns immediately when no reset time is available", async () => {
    const monitor = makeMonitor();
    // No usage data fetched yet — five_hour_resets_at is null
    fetchMock.mockResolvedValue(makeApiResponse(5.0));

    const waitPromise = monitor.waitForReset();
    await vi.advanceTimersByTimeAsync(0);
    await waitPromise;

    // Should have polled once and returned
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exits normally when utilization drops below threshold", async () => {
    const monitor = makeMonitor();

    // Set initial high usage
    fetchMock.mockResolvedValue(makeApiResponse(85.0));
    await monitor.poll();

    // Set reset time in the past
    (monitor as unknown as { currentUsage: { five_hour_resets_at: string } }).currentUsage.five_hour_resets_at =
      new Date(Date.now() - 1000).toISOString();

    // First verification poll: still high
    // Second verification poll: dropped below 50%
    fetchMock
      .mockResolvedValueOnce(makeApiResponse(60.0))
      .mockResolvedValueOnce(makeApiResponse(40.0));

    const waitPromise = monitor.waitForReset();

    // Advance past initial poll
    await vi.advanceTimersByTimeAsync(0);
    // Advance past first 60s wait
    await vi.advanceTimersByTimeAsync(60_000);
    // Advance past second poll
    await vi.advanceTimersByTimeAsync(0);

    await waitPromise;

    // Should have completed without reaching MAX_WAIT_ITERATIONS
    // 1 (initial poll) + 1 (verification) + 1 (60% still high) + 1 (40% below threshold) = 4
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("source code contains H23 fix with MAX_WAIT_ITERATIONS = 60", async () => {
    const realFs = await vi.importActual<{ default: typeof import("fs/promises") }>("fs/promises");
    const pathMod = await vi.importActual<typeof import("path")>("path");
    const { fileURLToPath } = await vi.importActual<typeof import("url")>("url");
    const thisDir = pathMod.dirname(fileURLToPath(import.meta.url));
    const source = await realFs.default.readFile(
      pathMod.join(thisDir, "usage-monitor.ts"),
      "utf-8",
    );

    // H23: Must have iteration bound
    expect(source).toContain("MAX_WAIT_ITERATIONS");
    expect(source).toContain("MAX_WAIT_ITERATIONS = 60");

    // H23: Must break on exceeding max iterations
    expect(source).toContain("iterations >= MAX_WAIT_ITERATIONS");
    expect(source).toContain("break");

    // H23: Must have iteration counter
    expect(source).toContain("iterations++");

    // H23: Comment referencing the fix
    expect(source).toContain("H23");
  });
});
