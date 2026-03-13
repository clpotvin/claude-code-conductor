import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { OAuthCredentials } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Read the OAuth access token. Tries multiple sources in order:
 * 1. CLAUDE_CODE_OAUTH_TOKEN env var (explicit override / CI)
 * 2. ~/.claude/.credentials.json file (Linux / macOS)
 * 3. macOS Keychain (macOS only)
 *
 * Returns null if no token can be found.
 *
 * Uses async I/O throughout to avoid blocking the event loop (H22/H24).
 */
export async function readOAuthToken(): Promise<string | null> {
  // 1. Environment variable (works everywhere)
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) {
    return envToken;
  }

  // 2. Credentials file (Linux, or macOS if file exists)
  try {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");

    // Use async fs.access + fs.readFile instead of sync equivalents
    await fs.access(credPath);
    const raw = await fs.readFile(credPath, "utf-8");
    const creds = JSON.parse(raw) as OAuthCredentials;

    if (creds.claudeAiOauth?.accessToken) {
      if (creds.claudeAiOauth.expiresAt && Date.now() > creds.claudeAiOauth.expiresAt) {
        // Token expired, try other sources
      } else {
        return creds.claudeAiOauth.accessToken;
      }
    }
  } catch {
    // File doesn't exist or can't be parsed — continue to next source
  }

  // 3. macOS Keychain (async execFile instead of execSync)
  if (process.platform === "darwin") {
    try {
      const { stdout: keychainResult } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf-8", timeout: 5000 },
      );

      const trimmed = keychainResult.trim();
      if (trimmed) {
        const creds = JSON.parse(trimmed) as OAuthCredentials;
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
