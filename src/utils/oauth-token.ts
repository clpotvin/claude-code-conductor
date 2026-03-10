import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import type { OAuthCredentials } from "./types.js";

/**
 * Read the OAuth access token. Tries multiple sources in order:
 * 1. CLAUDE_CODE_OAUTH_TOKEN env var (explicit override / CI)
 * 2. ~/.claude/.credentials.json file (Linux / macOS)
 * 3. macOS Keychain (macOS only)
 *
 * Returns null if no token can be found.
 */
export function readOAuthToken(): string | null {
  // 1. Environment variable (works everywhere)
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) {
    return envToken;
  }

  // 2. Credentials file (Linux, or macOS if file exists)
  try {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");

    if (fs.existsSync(credPath)) {
      const raw = fs.readFileSync(credPath, "utf-8");
      const creds = JSON.parse(raw) as OAuthCredentials;

      if (creds.claudeAiOauth?.accessToken) {
        if (creds.claudeAiOauth.expiresAt && Date.now() > creds.claudeAiOauth.expiresAt) {
          // Token expired, try other sources
        } else {
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
        const creds = JSON.parse(keychainResult) as OAuthCredentials;
        if (creds.claudeAiOauth?.accessToken) {
          if (creds.claudeAiOauth.expiresAt && Date.now() > creds.claudeAiOauth.expiresAt) {
            return null;
          }
          return creds.claudeAiOauth.accessToken;
        }
      }
    } catch {
      // Could not read from Keychain
    }
  }

  return null;
}
