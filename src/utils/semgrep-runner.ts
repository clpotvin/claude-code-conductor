import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SemgrepFinding } from "./types.js";
import { SEMGREP_DEFAULT_CONFIGS } from "./constants.js";

const execFileAsync = promisify(execFile);

interface SemgrepJsonOutput {
  results: SemgrepResult[];
  errors: unknown[];
}

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra: {
    message: string;
    severity: string;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Check whether semgrep is installed on the system.
 */
async function isSemgrepInstalled(): Promise<boolean> {
  try {
    await execFileAsync("which", ["semgrep"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map semgrep severity strings to our SemgrepFinding severity enum.
 */
function mapSeverity(severity: string): SemgrepFinding["severity"] {
  const upper = severity.toUpperCase();
  if (upper === "ERROR") return "ERROR";
  if (upper === "WARNING") return "WARNING";
  return "INFO";
}

/**
 * Run semgrep on a list of files. Returns structured findings.
 * If semgrep is not installed, warns and returns empty array.
 */
export async function runSemgrep(
  files: string[],
  projectDir: string,
  configs?: string[],
): Promise<SemgrepFinding[]> {
  if (files.length === 0) {
    return [];
  }

  const installed = await isSemgrepInstalled();
  if (!installed) {
    console.warn("semgrep is not installed; skipping static analysis. Install with: pip install semgrep");
    return [];
  }

  const configsToUse = configs ?? SEMGREP_DEFAULT_CONFIGS;

  // Build args: semgrep --json --config=<config> <files...>
  const args: string[] = ["--json"];
  for (const config of configsToUse) {
    args.push(`--config=${config}`);
  }
  args.push(...files);

  try {
    const { stdout } = await execFileAsync("semgrep", args, {
      cwd: projectDir,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      timeout: 120_000, // 2 minutes
    });

    const output: SemgrepJsonOutput = JSON.parse(stdout);

    return output.results.map((result) => ({
      rule_id: result.check_id,
      severity: mapSeverity(result.extra.severity),
      message: result.extra.message,
      file_path: result.path,
      line_start: result.start.line,
      line_end: result.end.line,
    }));
  } catch (error: unknown) {
    // Semgrep exits with code 1 when it finds issues but still produces valid JSON on stdout
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = (error as { stdout: string }).stdout;
      if (stdout) {
        try {
          const output: SemgrepJsonOutput = JSON.parse(stdout);
          return output.results.map((result) => ({
            rule_id: result.check_id,
            severity: mapSeverity(result.extra.severity),
            message: result.extra.message,
            file_path: result.path,
            line_start: result.start.line,
            line_end: result.end.line,
          }));
        } catch {
          // JSON parse failed on stdout, fall through to warning
        }
      }
    }

    console.warn("semgrep execution failed:", error instanceof Error ? error.message : String(error));
    return [];
  }
}
