// ============================================================
// Orchestrator State Types
// ============================================================

export interface OrchestratorState {
  status: OrchestratorStatus;
  feature: string;
  project_path: string;
  branch: string;
  base_commit_sha: string | null;
  current_cycle: number;
  max_cycles: number;
  concurrency: number;
  started_at: string;
  updated_at: string;
  paused_at: string | null;
  resume_after: string | null;
  usage: UsageSnapshot;
  codex_metrics: CodexUsageMetrics | null;
  completed_task_ids: string[];
  failed_task_ids: string[];
  active_session_ids: string[];
  cycle_history: CycleRecord[];
}

export type OrchestratorStatus =
  | "initializing"
  | "questioning"
  | "planning"
  | "executing"
  | "reviewing"
  | "flow_tracing"
  | "checkpointing"
  | "paused"
  | "completed"
  | "failed"
  | "escalated";

export interface CycleRecord {
  cycle: number;
  plan_version: number;
  tasks_completed: number;
  tasks_failed: number;
  codex_plan_approved: boolean;
  codex_code_approved: boolean;
  plan_discussion_rounds: number;
  code_review_rounds: number;
  duration_ms: number;
  started_at: string;
  completed_at: string;
  flow_tracing?: FlowTracingSummary;
}

export interface FlowTracingSummary {
  flows_traced: number;
  total_findings: number;
  critical_findings: number;
  high_findings: number;
  duration_ms: number;
}

// ============================================================
// Task Types
// ============================================================

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  depends_on: string[];
  blocks: string[];
  result_summary: string | null;
  files_changed: string[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

// ============================================================
// Session Types
// ============================================================

export interface SessionStatus {
  session_id: string;
  state: SessionState;
  current_task: string | null;
  tasks_completed: string[];
  progress: string;
  updated_at: string;
}

export type SessionState = "starting" | "working" | "idle" | "pausing" | "paused" | "done" | "failed";

export interface ResumeInfo {
  session_id: string;
  current_task_id: string | null;
  task_progress: string;
  files_modified: string[];
  last_commit: string | null;
  context_notes: string;
  created_at: string;
}

// ============================================================
// Message Types
// ============================================================

export interface Message {
  id: string;
  from: string;
  type: MessageType;
  to?: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export type MessageType =
  | "status"
  | "question"
  | "answer"
  | "broadcast"
  | "wind_down"
  | "task_completed"
  | "error"
  | "escalation";

export interface WindDownMessage extends Message {
  type: "wind_down";
  metadata: {
    reason: "usage_limit" | "cycle_limit" | "user_requested";
    resets_at?: string;
  };
}

// ============================================================
// Usage Types
// ============================================================

export interface UsageSnapshot {
  five_hour: number; // 0.0 - 1.0
  seven_day: number; // 0.0 - 1.0
  five_hour_resets_at: string | null;
  seven_day_resets_at: string | null;
  last_checked: string;
}

export interface UsageApiResponse {
  five_hour: {
    utilization: number;
    resets_at: string;
  };
  seven_day: {
    utilization: number;
    resets_at: string;
  };
}

export interface OAuthCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
}

// ============================================================
// Codex Types
// ============================================================

export type CodexVerdict = "APPROVE" | "NEEDS_DISCUSSION" | "MAJOR_CONCERNS" | "NEEDS_FIXES" | "MAJOR_PROBLEMS" | "NO_VERDICT" | "ERROR" | "RATE_LIMITED";

export interface CodexJsonResponse {
  review_performed: true;
  verdict: "APPROVE" | "NEEDS_DISCUSSION" | "MAJOR_CONCERNS" | "NEEDS_FIXES" | "MAJOR_PROBLEMS";
  issues: { description: string; severity: "minor" | "major" | "critical" }[];
  summary: string;
}

export interface CodexUsageMetrics {
  invocations: number;
  successes: number;
  invalid_responses: number;
  presumed_rate_limits: number;
  last_presumed_rate_limit_at: string | null;
}

export interface CodexReviewResult {
  verdict: CodexVerdict;
  raw_output: string;
  issues: string[];
  file_path: string;
}

// ============================================================
// Planner Types
// ============================================================

export interface PlannerOutput {
  plan_markdown: string;
  tasks: TaskDefinition[];
}

export interface TaskDefinition {
  subject: string;
  description: string;
  depends_on_subjects: string[];
  estimated_complexity: "small" | "medium" | "large";
}

// ============================================================
// CLI Types
// ============================================================

export interface CLIOptions {
  project: string;
  feature: string;
  concurrency: number;
  maxCycles: number;
  usageThreshold: number;
  skipCodex: boolean;
  skipFlowReview: boolean;
  dryRun: boolean;
  resume: boolean;
  verbose: boolean;
  contextFile: string | null;
  currentBranch: boolean;
}

// ============================================================
// Worker Spawn Types
// ============================================================

export interface WorkerConfig {
  sessionId: string;
  projectDir: string;
  orchestratorDir: string;
  mcpServerPath: string;
  systemPromptAddendum: string;
  allowedTools: string[];
  maxTurns: number;
}

// ============================================================
// Event Types (for orchestrator event loop)
// ============================================================

export type OrchestratorEvent =
  | { type: "task_completed"; taskId: string; sessionId: string; summary: string }
  | { type: "task_failed"; taskId: string; sessionId: string; error: string }
  | { type: "session_idle"; sessionId: string }
  | { type: "session_done"; sessionId: string }
  | { type: "session_failed"; sessionId: string; error: string }
  | { type: "usage_warning"; utilization: number }
  | { type: "usage_critical"; utilization: number; resets_at: string }
  | { type: "all_tasks_complete" }
  | { type: "escalation_needed"; reason: string; details: string };

// ============================================================
// Flow-Tracing Review Types
// ============================================================

export type FlowFindingSeverity = "critical" | "high" | "medium" | "low";

export interface FlowSpec {
  id: string;
  name: string;
  description: string;
  entry_points: string[];
  actors: ActorType[];
  edge_cases: string[];
}

export type ActorType = string;

export interface FlowFinding {
  flow_id: string;
  severity: FlowFindingSeverity;
  actor: ActorType;
  title: string;
  description: string;
  file_path: string;
  line_number?: number;
  cross_boundary: boolean;
  edge_case?: string;
}

export interface FlowConfig {
  /** Layer definitions for the tracing methodology (what to check at each layer) */
  layers: {
    name: string;
    checks: string[];
  }[];

  /** Actor types relevant to this project */
  actor_types: string[];

  /** Edge cases to always check */
  edge_cases: string[];

  /** Example flows to guide the extraction prompt */
  example_flows: {
    id: string;
    name: string;
    description: string;
    entry_points: string[];
    actors: string[];
    edge_cases: string[];
  }[];
}

export interface FlowTracingReport {
  generated_at: string;
  flows_traced: number;
  findings: FlowFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
    cross_boundary_count: number;
  };
}
