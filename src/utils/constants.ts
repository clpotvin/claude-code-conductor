import path from "path";

// ============================================================
// Directory & File Names
// ============================================================

export const ORCHESTRATOR_DIR = ".orchestrator";
export const TASKS_DIR = "tasks";
export const MESSAGES_DIR = "messages";
export const SESSIONS_DIR = "sessions";
export const CODEX_REVIEWS_DIR = "codex-reviews";
export const FLOW_TRACING_DIR = "flow-tracing";
export const CONTRACTS_DIR = "contracts";
export const DECISIONS_FILE = "decisions.jsonl";
export const CONVENTIONS_FILE = "conventions.json";
export const KNOWN_ISSUES_FILE = "known-issues.json";
export const RULES_FILE = "rules.md";
export const WORKER_RULES_FILE = "worker-rules.md";
export const LOGS_DIR = "logs";

export const STATE_FILE = "state.json";
export const SESSION_STATUS_FILE = "status.json";
export const RESUME_INFO_FILE = "resume-info.json";
export const RESULT_FILE = "result.json";
export const ESCALATION_FILE = "escalation.json";
export const PAUSE_SIGNAL_FILE = "pause.signal";

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_MAX_CYCLES = 5;
export const DEFAULT_USAGE_THRESHOLD = 0.80;
export const DEFAULT_CRITICAL_THRESHOLD = 0.90;
export const DEFAULT_USAGE_POLL_INTERVAL_MS = 30_000; // 30 seconds
export const DEFAULT_WORKER_MAX_TURNS = 100;
export const DEFAULT_WORKER_POLL_INTERVAL_MS = 5_000; // 5 seconds (orchestrator checks workers)
export const FLOW_TRACING_WORKER_MAX_TURNS = 50;
export const MAX_FLOW_TRACING_WORKERS = 3;
export const SENTINEL_POLL_INTERVAL_MS = 15_000; // 15 seconds
export const SENTINEL_WORKER_MAX_TURNS = 200;
export const CONVENTIONS_EXTRACTION_MAX_TURNS = 20;
export const INCREMENTAL_REVIEW_MAX_TURNS = 15;
export const MAX_SEMGREP_RETRIES = 2;

// ============================================================
// Semgrep Configuration
// ============================================================

export const SEMGREP_DEFAULT_CONFIGS = [
  "p/typescript",
  "p/owasp-top-ten",
  "p/cwe-top-25",
];

export const SEMGREP_SEVERITY_BLOCK_THRESHOLD = "ERROR"; // block task completion on ERROR findings

// ============================================================
// Limits
// ============================================================

export const MAX_PLAN_DISCUSSION_ROUNDS = 5;
export const MAX_CODE_REVIEW_ROUNDS = 5;
export const FLOW_TASK_PREFIX = "flow-";
export const MAX_DISAGREEMENT_ROUNDS = 2; // escalate to user after this
export const WIND_DOWN_GRACE_PERIOD_MS = 120_000; // 2 minutes for clean exit
export const RESUME_UTILIZATION_THRESHOLD = 0.50; // resume when usage drops below this

// ============================================================
// Usage API
// ============================================================

export const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_API_BETA_HEADER = "oauth-2025-04-20";
export const CREDENTIALS_PATH_LINUX = "~/.claude/.credentials.json";
export const CREDENTIALS_PATH_MACOS = "~/.claude/.credentials.json";

// ============================================================
// Worker Configuration
// ============================================================

export const WORKER_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Task", // so workers can use subagents
  "mcp__coordinator__read_updates",
  "mcp__coordinator__post_update",
  "mcp__coordinator__get_tasks",
  "mcp__coordinator__claim_task",
  "mcp__coordinator__complete_task",
  "mcp__coordinator__get_session_status",
  "mcp__coordinator__register_contract",
  "mcp__coordinator__get_contracts",
  "mcp__coordinator__record_decision",
  "mcp__coordinator__get_decisions",
  "mcp__coordinator__run_tests",
  "mcp__codex__*", // optional Codex MCP for real-time consultation
];

// ============================================================
// Flow-Tracing Worker Configuration (read-only)
// ============================================================

export const FLOW_TRACING_READ_ONLY_TOOLS = [
  "Read",
  "Bash",
  "Glob",
  "Grep",
  "Task", // so flow workers can use subagents for deeper investigation
];

// ============================================================
// Git
// ============================================================

export const BRANCH_PREFIX = "orchestrate/";
export const COMMIT_PREFIX_TASK = "[task-";
export const GIT_CHECKPOINT_PREFIX = "checkpoint-";

// ============================================================
// Helpers
// ============================================================

export function getOrchestratorDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR);
}

export function getTasksDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, TASKS_DIR);
}

export function getMessagesDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, MESSAGES_DIR);
}

export function getSessionsDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, SESSIONS_DIR);
}

export function getSessionDir(projectDir: string, sessionId: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, SESSIONS_DIR, sessionId);
}

export function getCodexReviewsDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, CODEX_REVIEWS_DIR);
}

export function getLogsDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, LOGS_DIR);
}

export function getStatePath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, STATE_FILE);
}

export function getTaskPath(projectDir: string, taskId: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, TASKS_DIR, `${taskId}.json`);
}

export function getMessagePath(projectDir: string, sessionId: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, MESSAGES_DIR, `${sessionId}.jsonl`);
}

export function getPlanPath(projectDir: string, version: number): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, `plan-v${version}.md`);
}

export function getEscalationPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, ESCALATION_FILE);
}

export function getPauseSignalPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, PAUSE_SIGNAL_FILE);
}

export function getFlowTracingDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, FLOW_TRACING_DIR);
}

export function getFlowTracingReportPath(projectDir: string, cycle: number): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, FLOW_TRACING_DIR, `report-cycle-${cycle}.json`);
}

export function getContractsDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, CONTRACTS_DIR);
}

export function getDecisionsPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, DECISIONS_FILE);
}

export function getConventionsPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, CONVENTIONS_FILE);
}

export function getKnownIssuesPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, KNOWN_ISSUES_FILE);
}

export function getRulesPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, RULES_FILE);
}

export function getWorkerRulesPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, WORKER_RULES_FILE);
}
