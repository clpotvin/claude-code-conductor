import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  DEFAULT_USAGE_THRESHOLD,
  DEFAULT_CRITICAL_THRESHOLD,
  DEFAULT_USAGE_POLL_INTERVAL_MS,
  USAGE_API_URL,
  USAGE_API_BETA_HEADER,
  RESUME_UTILIZATION_THRESHOLD,
} from "../utils/constants.js";
import type {
  UsageSnapshot,
  UsageApiResponse,
  OAuthCredentials,
} from "../utils/types.js";
import { Logger } from "../utils/logger.js";

const DEFAULT_SNAPSHOT: UsageSnapshot = {
  five_hour: 0,
  seven_day: 0,
  five_hour_resets_at: null,
  seven_day_resets_at: null,
  last_checked: new Date().toISOString(),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class UsageMonitor {
  private threshold: number;
  private criticalThreshold: number;
  private pollIntervalMs: number;
  private intervalHandle: NodeJS.Timeout | null = null;
  private currentUsage: UsageSnapshot;
  private onWarning: (utilization: number) => void;
  private onCritical: (utilization: number, resetsAt: string) => void;
  private logger: Logger;

  constructor(options: {
    threshold?: number;
    criticalThreshold?: number;
    pollIntervalMs?: number;
    onWarning: (utilization: number) => void;
    onCritical: (utilization: number, resetsAt: string) => void;
    logger?: Logger;
  }) {
    this.threshold = options.threshold ?? DEFAULT_USAGE_THRESHOLD;
    this.criticalThreshold = options.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_USAGE_POLL_INTERVAL_MS;
    this.onWarning = options.onWarning;
    this.onCritical = options.onCritical;
    this.currentUsage = { ...DEFAULT_SNAPSHOT };
    this.logger = options.logger ?? new Logger(path.join(os.tmpdir(), "orchestrator-logs"), "usage-monitor");
  }

  /**
   * Start polling the usage endpoint at the configured interval.
   */
  start(): void {
    if (this.intervalHandle) {
      this.logger.warn("UsageMonitor is already running");
      return;
    }

    this.logger.info(
      `Starting usage monitor (poll every ${this.pollIntervalMs / 1000}s, ` +
      `warn at ${(this.threshold * 100).toFixed(0)}%, critical at ${(this.criticalThreshold * 100).toFixed(0)}%)`
    );

    // Do an immediate poll, then schedule recurring
    void this.pollAndNotify();

    this.intervalHandle = setInterval(() => {
      void this.pollAndNotify();
    }, this.pollIntervalMs);

    // Allow the process to exit even if the interval is running
    this.intervalHandle.unref();
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info("Usage monitor stopped");
    }
  }

  /**
   * Get the current usage snapshot (cached from the last poll).
   */
  getUsage(): UsageSnapshot {
    return { ...this.currentUsage };
  }

  /**
   * Check if the wind-down threshold has been reached on the 5-hour window.
   */
  isWindDownNeeded(): boolean {
    return this.currentUsage.five_hour >= this.threshold;
  }

  /**
   * Check if the critical threshold has been exceeded on the 5-hour window.
   */
  isCritical(): boolean {
    return this.currentUsage.five_hour >= this.criticalThreshold;
  }

  /**
   * Get the reset time for the 5-hour window, if known.
   */
  getResetTime(): string | null {
    return this.currentUsage.five_hour_resets_at;
  }

  /**
   * Wait for the usage window to reset. Sleeps until `resets_at`,
   * then polls to verify utilization dropped below the resume threshold.
   * Will keep sleeping in 60-second intervals if still above threshold.
   */
  async waitForReset(): Promise<void> {
    const resetsAt = this.currentUsage.five_hour_resets_at;

    if (!resetsAt) {
      this.logger.warn("No reset time available; polling once and returning");
      await this.poll();
      return;
    }

    const resetTime = new Date(resetsAt).getTime();
    const now = Date.now();

    if (resetTime > now) {
      const waitMs = resetTime - now;
      const waitMin = Math.ceil(waitMs / 60_000);
      this.logger.info(`Waiting ${waitMin} minute(s) for usage window to reset at ${resetsAt}`);
      await sleep(waitMs);
    }

    // Poll to verify utilization has dropped
    this.logger.info("Reset time reached, verifying utilization...");
    let snapshot = await this.poll();

    // Keep waiting in 60s increments if still above the resume threshold
    while (snapshot.five_hour >= RESUME_UTILIZATION_THRESHOLD) {
      this.logger.warn(
        `Utilization still at ${(snapshot.five_hour * 100).toFixed(1)}% ` +
        `(need < ${(RESUME_UTILIZATION_THRESHOLD * 100).toFixed(0)}%). Waiting 60s...`
      );
      await sleep(60_000);
      snapshot = await this.poll();
    }

    this.logger.info(
      `Utilization dropped to ${(snapshot.five_hour * 100).toFixed(1)}%. Ready to resume.`
    );
  }

  /**
   * Force a poll right now. Useful before making decisions.
   * Returns the fresh UsageSnapshot.
   */
  async poll(): Promise<UsageSnapshot> {
    try {
      const token = this.readOAuthToken();
      if (!token) {
        this.logger.warn("No OAuth token found; returning last known usage");
        return this.getUsage();
      }

      const response = await fetch(USAGE_API_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": USAGE_API_BETA_HEADER,
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Usage API returned ${response.status} ${response.statusText}; returning last known usage`
        );
        return this.getUsage();
      }

      const data = (await response.json()) as UsageApiResponse;

      // API returns utilization as percentage (e.g. 5.0 = 5%).
      // Internally we use 0-1 range (0.05 = 5%) so thresholds like 0.80 work correctly.
      this.currentUsage = {
        five_hour: data.five_hour.utilization / 100,
        seven_day: data.seven_day.utilization / 100,
        five_hour_resets_at: data.five_hour.resets_at,
        seven_day_resets_at: data.seven_day.resets_at,
        last_checked: new Date().toISOString(),
      };

      this.logger.debug(
        `Usage: 5h=${(this.currentUsage.five_hour * 100).toFixed(1)}% ` +
        `7d=${(this.currentUsage.seven_day * 100).toFixed(1)}%`
      );

      return this.getUsage();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to poll usage API: ${message}`);
      return this.getUsage();
    }
  }

  /**
   * Internal: poll and fire callbacks if thresholds are exceeded.
   */
  private async pollAndNotify(): Promise<void> {
    await this.poll();

    if (this.isCritical()) {
      const resetsAt = this.currentUsage.five_hour_resets_at ?? "unknown";
      this.logger.warn(
        `CRITICAL: 5h utilization at ${(this.currentUsage.five_hour * 100).toFixed(1)}% (resets at ${resetsAt})`
      );
      this.onCritical(this.currentUsage.five_hour, resetsAt);
    } else if (this.isWindDownNeeded()) {
      this.logger.warn(
        `WARNING: 5h utilization at ${(this.currentUsage.five_hour * 100).toFixed(1)}% — approaching limit`
      );
      this.onWarning(this.currentUsage.five_hour);
    }
  }

  /**
   * Read the OAuth access token. Tries multiple sources in order:
   * 1. CLAUDE_CODE_OAUTH_TOKEN env var (explicit override / CI)
   * 2. ~/.claude/.credentials.json file (Linux)
   * 3. macOS Keychain (macOS)
   *
   * Returns null if no token can be found.
   */
  private readOAuthToken(): string | null {
    // 1. Environment variable (works everywhere)
    const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (envToken) {
      this.logger.debug("Using OAuth token from CLAUDE_CODE_OAUTH_TOKEN env var");
      return envToken;
    }

    // 2. Credentials file (Linux, or macOS if file exists)
    try {
      const credPath = path.join(os.homedir(), ".claude", ".credentials.json");

      if (fs.existsSync(credPath)) {
        const raw = fs.readFileSync(credPath, "utf-8");
        const creds = JSON.parse(raw) as OAuthCredentials;

        if (creds.claudeAiOauth?.accessToken) {
          // Check if the token has expired
          if (creds.claudeAiOauth.expiresAt && Date.now() > creds.claudeAiOauth.expiresAt) {
            this.logger.debug("Token from credentials file has expired, trying other sources");
          } else {
            this.logger.debug("Using OAuth token from credentials file");
            return creds.claudeAiOauth.accessToken;
          }
        }
      }
    } catch {
      // File doesn't exist or can't be parsed — continue to next source
    }

    // 3. macOS Keychain
    if (process.platform === "darwin") {
      try {
        const keychainResult = execSync(
          'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
          { encoding: "utf-8", timeout: 5000 },
        ).trim();

        if (keychainResult) {
          // The keychain entry stores JSON with the same structure as the file
          const creds = JSON.parse(keychainResult) as OAuthCredentials;
          if (creds.claudeAiOauth?.accessToken) {
            if (creds.claudeAiOauth.expiresAt && Date.now() > creds.claudeAiOauth.expiresAt) {
              this.logger.warn("OAuth token from Keychain has expired");
              return null;
            }
            this.logger.debug("Using OAuth token from macOS Keychain");
            return creds.claudeAiOauth.accessToken;
          }
        }
      } catch {
        this.logger.debug("Could not read OAuth token from macOS Keychain");
      }
    }

    this.logger.warn("No OAuth token found from any source (env, file, or Keychain)");
    return null;
  }
}
