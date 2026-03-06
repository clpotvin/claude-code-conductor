import type { UsageSnapshot } from "./types.js";

export interface CodexUsageReading {
  snapshot: UsageSnapshot;
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  timestamp: string;
}

interface TokenCountEnvelope {
  timestamp?: unknown;
  payload?: {
    type?: unknown;
    rate_limits?: {
      limit_id?: unknown;
      limit_name?: unknown;
      plan_type?: unknown;
      primary?: {
        used_percent?: unknown;
        resets_at?: unknown;
      };
      secondary?: {
        used_percent?: unknown;
        resets_at?: unknown;
      };
    } | null;
  };
}

export function parseCodexUsageLine(line: string): CodexUsageReading | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: TokenCountEnvelope;
  try {
    parsed = JSON.parse(trimmed) as TokenCountEnvelope;
  } catch {
    return null;
  }

  if (parsed.payload?.type !== "token_count" || !parsed.payload.rate_limits) {
    return null;
  }

  const primary = toUtilization(parsed.payload.rate_limits.primary?.used_percent);
  const secondary = toUtilization(parsed.payload.rate_limits.secondary?.used_percent);
  if (primary === null && secondary === null) {
    return null;
  }

  const timestamp = typeof parsed.timestamp === "string"
    ? parsed.timestamp
    : new Date().toISOString();

  const rawSnapshot: UsageSnapshot = {
    five_hour: primary ?? 0,
    seven_day: secondary ?? 0,
    five_hour_resets_at: toIsoTimestamp(parsed.payload.rate_limits.primary?.resets_at),
    seven_day_resets_at: toIsoTimestamp(parsed.payload.rate_limits.secondary?.resets_at),
    last_checked: timestamp,
  };

  return {
    snapshot: normalizeExpiredWindows(rawSnapshot),
    limitId: typeof parsed.payload.rate_limits.limit_id === "string"
      ? parsed.payload.rate_limits.limit_id
      : null,
    limitName: typeof parsed.payload.rate_limits.limit_name === "string"
      ? parsed.payload.rate_limits.limit_name
      : null,
    planType: typeof parsed.payload.rate_limits.plan_type === "string"
      ? parsed.payload.rate_limits.plan_type
      : null,
    timestamp,
  };
}

export function parseCodexUsageJsonl(contents: string): CodexUsageReading | null {
  const readings: CodexUsageReading[] = [];

  for (const line of contents.split(/\r?\n/)) {
    const reading = parseCodexUsageLine(line);
    if (reading) {
      readings.push(reading);
    }
  }

  return pickPreferredCodexUsage(readings);
}

export function pickPreferredCodexUsage(readings: CodexUsageReading[]): CodexUsageReading | null {
  if (readings.length === 0) {
    return null;
  }

  const preferred = readings.filter((reading) => isPreferredLimitId(reading.limitId));
  const pool = preferred.length > 0 ? preferred : readings;

  return pool.reduce((latest, reading) => {
    if (!latest) {
      return reading;
    }

    return new Date(reading.timestamp).getTime() >= new Date(latest.timestamp).getTime()
      ? reading
      : latest;
  }, null as CodexUsageReading | null);
}

function isPreferredLimitId(limitId: string | null): boolean {
  return limitId === null || limitId === "codex";
}

function toUtilization(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value / 100;
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function normalizeExpiredWindows(snapshot: UsageSnapshot): UsageSnapshot {
  const now = Date.now();

  return {
    five_hour: isExpired(snapshot.five_hour_resets_at, now) ? 0 : snapshot.five_hour,
    seven_day: isExpired(snapshot.seven_day_resets_at, now) ? 0 : snapshot.seven_day,
    five_hour_resets_at: isExpired(snapshot.five_hour_resets_at, now) ? null : snapshot.five_hour_resets_at,
    seven_day_resets_at: isExpired(snapshot.seven_day_resets_at, now) ? null : snapshot.seven_day_resets_at,
    last_checked: snapshot.last_checked,
  };
}

function isExpired(timestamp: string | null, now: number): boolean {
  if (!timestamp) {
    return false;
  }

  const value = new Date(timestamp).getTime();
  if (Number.isNaN(value)) {
    return false;
  }

  return value <= now;
}
