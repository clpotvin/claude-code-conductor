import fs from "node:fs/promises";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  OrchestratorEvent,
  Message,
  SessionStatus,
  ProjectConventions,
  ThreatModel,
} from "../utils/types.js";
import {
  WORKER_ALLOWED_TOOLS,
  DEFAULT_WORKER_MAX_TURNS,
  MESSAGES_DIR,
  SESSIONS_DIR,
  SESSION_STATUS_FILE,
  SENTINEL_WORKER_MAX_TURNS,
  FLOW_TRACING_READ_ONLY_TOOLS,
} from "../utils/constants.js";
import { getWorkerPrompt } from "../worker-prompt.js";
import type { Logger } from "../utils/logger.js";

// ============================================================
// Worker Handle
// ============================================================

interface WorkerHandle {
  sessionId: string;
  promise: Promise<void>;
  events: OrchestratorEvent[];
  startedAt: string;
}

// ============================================================
// Worker Manager
// ============================================================

/**
 * Manages spawning and monitoring headless Claude Code worker
 * sessions via the Agent SDK. Each worker runs as a background
 * async task that picks up tasks from the coordination server.
 */
export class WorkerManager {
  private activeWorkers: Map<string, WorkerHandle> = new Map();

  private workerContext: {
    qaContext?: string;
    conventions?: ProjectConventions;
    projectRules?: string;
    featureDescription?: string;
    threatModelSummary?: string;
  } = {};

  constructor(
    private projectDir: string,
    private orchestratorDir: string,
    private mcpServerPath: string,
    private logger: Logger,
  ) {}

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Set shared context that will be injected into all worker prompts.
   * Call this after planning/conventions extraction, before spawning workers.
   */
  setWorkerContext(context: {
    qaContext?: string;
    conventions?: ProjectConventions;
    projectRules?: string;
    featureDescription?: string;
    threatModelSummary?: string;
  }): void {
    this.workerContext = context;
  }

  /**
   * Spawn a new worker session.
   *
   * Creates the session directory, writes initial status, and launches
   * the SDK query in a background async task.
   */
  async spawnWorker(sessionId: string): Promise<void> {
    if (this.activeWorkers.has(sessionId)) {
      this.logger.warn(`Worker ${sessionId} is already active; skipping spawn`);
      return;
    }

    this.logger.info(`Spawning worker: ${sessionId}`);

    // Create session directory
    const sessionDir = path.join(
      this.orchestratorDir,
      SESSIONS_DIR,
      sessionId,
    );
    await fs.mkdir(sessionDir, { recursive: true });

    // Write initial status
    const initialStatus: SessionStatus = {
      session_id: sessionId,
      state: "starting",
      current_task: null,
      tasks_completed: [],
      progress: "Worker session starting...",
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(sessionDir, SESSION_STATUS_FILE),
      JSON.stringify(initialStatus, null, 2) + "\n",
      "utf-8",
    );

    // Build the worker handle
    const handle: WorkerHandle = {
      sessionId,
      promise: Promise.resolve(), // will be replaced below
      events: [],
      startedAt: new Date().toISOString(),
    };

    // Launch the worker as a background async task
    handle.promise = this.runWorker(sessionId, handle);

    this.activeWorkers.set(sessionId, handle);
  }

  /**
   * Spawn a read-only security sentinel worker that monitors completed tasks
   * and scans for security issues in real-time during execution.
   */
  async spawnSentinelWorker(): Promise<void> {
    const sentinelId = "sentinel-security";

    if (this.activeWorkers.has(sentinelId)) {
      this.logger.warn("Security sentinel is already running");
      return;
    }

    this.logger.info("Spawning security sentinel worker...");

    // Create session directory
    const sessionDir = path.join(
      this.orchestratorDir,
      SESSIONS_DIR,
      sentinelId,
    );
    await fs.mkdir(sessionDir, { recursive: true });

    // Write initial status
    const initialStatus: SessionStatus = {
      session_id: sentinelId,
      state: "starting",
      current_task: null,
      tasks_completed: [],
      progress: "Security sentinel starting...",
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(sessionDir, SESSION_STATUS_FILE),
      JSON.stringify(initialStatus, null, 2) + "\n",
      "utf-8",
    );

    const sentinelPrompt = this.buildSentinelPrompt();

    const handle: WorkerHandle = {
      sessionId: sentinelId,
      promise: Promise.resolve(),
      events: [],
      startedAt: new Date().toISOString(),
    };

    // Launch with read-only tools and sentinel prompt
    handle.promise = this.runSentinelWorker(sentinelId, handle, sentinelPrompt);
    this.activeWorkers.set(sentinelId, handle);
  }

  /**
   * Get the list of active worker session IDs.
   */
  getActiveWorkers(): string[] {
    return Array.from(this.activeWorkers.keys());
  }

  /**
   * Check if a specific worker is still running.
   *
   * A worker is considered active if its handle is in the map.
   * Once the background task resolves (success or error), the
   * handle is removed.
   */
  isWorkerActive(sessionId: string): boolean {
    return this.activeWorkers.has(sessionId);
  }

  /**
   * Send a wind-down signal to all workers.
   *
   * Writes a wind_down message to the orchestrator's shared message
   * file so that all workers will pick it up on their next
   * `read_updates` call.
   */
  async signalWindDown(reason: string, resetsAt?: string): Promise<void> {
    this.logger.info(`Sending wind-down signal to all workers: ${reason}`);

    const messagesDir = path.join(this.orchestratorDir, MESSAGES_DIR);
    await fs.mkdir(messagesDir, { recursive: true });

    const message: Message = {
      id: `orchestrator-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      from: "orchestrator",
      type: "wind_down",
      content: `Wind down: ${reason}. Please finish your current task, commit your work, and exit cleanly.`,
      metadata: {
        reason: reason as "usage_limit" | "cycle_limit" | "user_requested",
        ...(resetsAt ? { resets_at: resetsAt } : {}),
      },
      timestamp: new Date().toISOString(),
    };

    // Write to the orchestrator message file, which all workers will read
    const messagePath = path.join(messagesDir, "orchestrator.jsonl");
    await fs.appendFile(
      messagePath,
      JSON.stringify(message) + "\n",
      "utf-8",
    );

    this.logger.debug(`Wind-down message written to ${messagePath}`);
  }

  /**
   * Wait for all workers to finish, with a timeout.
   *
   * If the timeout expires before all workers complete, the remaining
   * workers are left running (use killAllWorkers to force-stop them).
   */
  async waitForAllWorkers(timeoutMs: number): Promise<void> {
    const workerIds = this.getActiveWorkers();
    if (workerIds.length === 0) {
      this.logger.info("No active workers to wait for.");
      return;
    }

    this.logger.info(
      `Waiting for ${workerIds.length} worker(s) to finish (timeout: ${Math.round(timeoutMs / 1000)}s)...`,
    );

    const promises = workerIds.map((id) => {
      const handle = this.activeWorkers.get(id);
      return handle ? handle.promise : Promise.resolve();
    });

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      // Allow the process to exit even if the timer is pending
      if (timer.unref) {
        timer.unref();
      }
    });

    const result = await Promise.race([
      Promise.allSettled(promises).then(() => "done" as const),
      timeoutPromise,
    ]);

    if (result === "timeout") {
      const remaining = this.getActiveWorkers();
      this.logger.warn(
        `Timeout reached. ${remaining.length} worker(s) still active: ${remaining.join(", ")}`,
      );
    } else {
      this.logger.info("All workers have finished.");
    }
  }

  /**
   * Force kill all worker processes.
   *
   * Since workers are async tasks (not child processes), we can only
   * remove them from tracking. The SDK doesn't expose a direct kill
   * mechanism, so we signal wind-down and then drop the references.
   */
  async killAllWorkers(): Promise<void> {
    const workerIds = this.getActiveWorkers();
    if (workerIds.length === 0) {
      return;
    }

    this.logger.warn(`Force-killing ${workerIds.length} worker(s): ${workerIds.join(", ")}`);

    // Signal wind-down first to give a chance for clean exit
    await this.signalWindDown("user_requested");

    // Update each session's status to "done" and remove from tracking
    for (const sessionId of workerIds) {
      await this.updateSessionStatus(sessionId, "done", "Force killed by orchestrator");
      this.activeWorkers.delete(sessionId);
    }

    this.logger.info("All workers have been killed and removed from tracking.");
  }

  /**
   * Get combined events from all workers (past and present).
   */
  getWorkerEvents(): OrchestratorEvent[] {
    const allEvents: OrchestratorEvent[] = [];

    for (const handle of this.activeWorkers.values()) {
      allEvents.push(...handle.events);
    }

    return allEvents;
  }

  // ----------------------------------------------------------------
  // Private: Worker execution
  // ----------------------------------------------------------------

  /**
   * Run a single worker session. This method is called as a background
   * async task and iterates over the SDK async iterable until the
   * worker exits.
   */
  private async runWorker(
    sessionId: string,
    handle: WorkerHandle,
  ): Promise<void> {
    const workerPrompt = this.buildWorkerPrompt(sessionId);

    try {
      const asyncIterable = query({
        prompt: workerPrompt,
        options: {
          allowedTools: WORKER_ALLOWED_TOOLS,
          mcpServers: {
            coordinator: {
              command: "node",
              args: [this.mcpServerPath],
              env: {
                CONDUCTOR_DIR: this.orchestratorDir,
                SESSION_ID: sessionId,
              },
            },
          },
          cwd: this.projectDir,
          maxTurns: DEFAULT_WORKER_MAX_TURNS,
          settingSources: ["project"],
        },
      });

      for await (const event of asyncIterable) {
        this.processWorkerEvent(sessionId, handle, event);
      }

      // Worker completed normally
      this.logger.info(`Worker ${sessionId} completed successfully.`);
      handle.events.push({
        type: "session_done",
        sessionId,
      });

      await this.updateSessionStatus(sessionId, "done", "Completed successfully");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      this.logger.error(`Worker ${sessionId} failed: ${errorMessage}`);

      handle.events.push({
        type: "session_failed",
        sessionId,
        error: errorMessage,
      });

      await this.updateSessionStatus(sessionId, "failed", errorMessage);
    } finally {
      // Remove from active workers once done
      this.activeWorkers.delete(sessionId);
    }
  }

  /**
   * Run a security sentinel worker session. Uses read-only tools and
   * a dedicated sentinel prompt. Monitors for security issues in
   * completed tasks.
   */
  private async runSentinelWorker(
    sessionId: string,
    handle: WorkerHandle,
    prompt: string,
  ): Promise<void> {
    try {
      const asyncIterable = query({
        prompt,
        options: {
          allowedTools: [
            ...FLOW_TRACING_READ_ONLY_TOOLS,
            "mcp__coordinator__read_updates",
            "mcp__coordinator__post_update",
            "mcp__coordinator__get_tasks",
          ],
          mcpServers: {
            coordinator: {
              command: "node",
              args: [this.mcpServerPath],
              env: {
                CONDUCTOR_DIR: this.orchestratorDir,
                SESSION_ID: sessionId,
              },
            },
          },
          cwd: this.projectDir,
          maxTurns: SENTINEL_WORKER_MAX_TURNS,
        },
      });

      for await (const event of asyncIterable) {
        this.processWorkerEvent(sessionId, handle, event);
      }

      // Sentinel completed normally
      this.logger.info(`Security sentinel ${sessionId} completed.`);
      handle.events.push({
        type: "session_done",
        sessionId,
      });

      await this.updateSessionStatus(sessionId, "done", "Sentinel completed");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      this.logger.error(`Security sentinel ${sessionId} failed: ${errorMessage}`);

      handle.events.push({
        type: "session_failed",
        sessionId,
        error: errorMessage,
      });

      await this.updateSessionStatus(sessionId, "failed", errorMessage);
    } finally {
      this.activeWorkers.delete(sessionId);
    }
  }

  /**
   * Process a single event from the worker's SDK async iterable.
   * Captures relevant events into the worker handle for the
   * orchestrator to inspect.
   */
  private processWorkerEvent(
    sessionId: string,
    handle: WorkerHandle,
    event: Record<string, unknown>,
  ): void {
    // The SDK emits events with a `type` field. We capture the ones
    // that are relevant for orchestrator monitoring.
    const eventType = event.type as string | undefined;

    if (eventType === "result") {
      const resultText =
        typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result);
      this.logger.debug(`Worker ${sessionId} result: ${resultText.substring(0, 200)}`);
    } else if (eventType === "error") {
      const errorText =
        typeof event.error === "string"
          ? event.error
          : JSON.stringify(event.error);
      this.logger.error(`Worker ${sessionId} error event: ${errorText}`);
      handle.events.push({
        type: "session_failed",
        sessionId,
        error: errorText,
      });
    } else if (eventType === "tool_use") {
      // Log tool usage at debug level for observability
      const toolName = event.tool_name ?? event.name ?? "unknown";
      this.logger.debug(`Worker ${sessionId} using tool: ${String(toolName)}`);
    }
  }

  // ----------------------------------------------------------------
  // Private: Session status management
  // ----------------------------------------------------------------

  /**
   * Update the session status file on disk.
   */
  private async updateSessionStatus(
    sessionId: string,
    state: SessionStatus["state"],
    progress: string,
  ): Promise<void> {
    const sessionDir = path.join(
      this.orchestratorDir,
      SESSIONS_DIR,
      sessionId,
    );

    try {
      await fs.mkdir(sessionDir, { recursive: true });

      const statusPath = path.join(sessionDir, SESSION_STATUS_FILE);

      // Try to read existing status to preserve task history
      let existing: SessionStatus | null = null;
      try {
        const raw = await fs.readFile(statusPath, "utf-8");
        existing = JSON.parse(raw) as SessionStatus;
      } catch {
        // File doesn't exist or is invalid; start fresh
      }

      const status: SessionStatus = {
        session_id: sessionId,
        state,
        current_task: existing?.current_task ?? null,
        tasks_completed: existing?.tasks_completed ?? [],
        progress,
        updated_at: new Date().toISOString(),
      };

      await fs.writeFile(
        statusPath,
        JSON.stringify(status, null, 2) + "\n",
        "utf-8",
      );
    } catch (err) {
      this.logger.error(
        `Failed to update session status for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ----------------------------------------------------------------
  // Private: Prompt builders
  // ----------------------------------------------------------------

  /**
   * Build the system prompt for a worker session.
   * Delegates to the shared getWorkerPrompt function with full context.
   */
  private buildWorkerPrompt(sessionId: string): string {
    return getWorkerPrompt({
      sessionId,
      ...this.workerContext,
    });
  }

  /**
   * Build the system prompt for the security sentinel worker.
   * The sentinel is READ-ONLY and monitors completed tasks for security issues.
   */
  private buildSentinelPrompt(): string {
    const securityInvariants = this.workerContext.conventions?.security_invariants;
    const invariantsSection = securityInvariants && securityInvariants.length > 0
      ? [
          "",
          "## Project Security Invariants",
          "",
          "The following security invariants have been established for this project.",
          "Flag any violations of these as HIGH or CRITICAL severity:",
          "",
          ...securityInvariants.map((inv) => `- ${inv}`),
        ].join("\n")
      : "";

    return [
      "# Security Sentinel Worker",
      "",
      "You are a READ-ONLY security sentinel in a multi-agent conductor system.",
      "Your session ID is: sentinel-security",
      "",
      "## IMPORTANT: You are READ-ONLY",
      "",
      "You must NEVER write, edit, or modify any files. You have only read access.",
      "Your sole purpose is to monitor completed tasks and scan for security issues.",
      "",
      "## Your Mission",
      "",
      "Continuously monitor the `.conductor/tasks/` directory for newly completed tasks.",
      "When you detect a completed task, read the files it changed and scan for security issues.",
      "",
      "## Workflow",
      "",
      "1. Call `mcp__coordinator__get_tasks` to see all tasks and their statuses.",
      "2. For each task with status \"completed\", check if you have already reviewed it",
      "   (keep a mental list of reviewed task IDs).",
      "3. For newly completed tasks, read the `files_changed` list from the task data.",
      "4. Read each changed file and scan for security issues (see checklist below).",
      "5. If you find issues, report them via `mcp__coordinator__post_update` with:",
      "   - type: \"broadcast\"",
      "   - content: A structured report including severity, file path, line number if possible,",
      "     and a description of the security issue.",
      "6. Call `mcp__coordinator__read_updates` to check for wind_down messages.",
      "7. If you receive a `wind_down` message, post a final summary of all findings and exit.",
      "8. Wait briefly, then repeat from step 1.",
      "",
      "## Security Scan Checklist",
      "",
      "Scan every changed file for the following categories of issues:",
      "",
      "### Authentication & Authorization",
      "- Missing auth middleware on route handlers or API endpoints",
      "- Endpoints that accept user input but don't verify the caller's identity",
      "- Missing role/permission checks on sensitive operations",
      "",
      "### Injection & Input Handling",
      "- Raw SQL queries or string concatenation in database queries (SQL injection risk)",
      "- Unsanitized user input passed to shell commands, file paths, or templates",
      "- Missing input validation on API endpoints (no schema validation, no type checks)",
      "",
      "### Secrets & Credentials",
      "- Hardcoded API keys, passwords, tokens, or connection strings",
      "- Secrets logged to console or written to files",
      "- Credentials in configuration files that should use environment variables",
      "",
      "### Network & CORS",
      "- Overly permissive CORS configuration (e.g., `origin: '*'` on authenticated endpoints)",
      "- Missing HTTPS enforcement or insecure cookie settings",
      "",
      "### Rate Limiting & DoS",
      "- Missing rate limiting on mutation endpoints (POST, PUT, DELETE)",
      "- Unbounded queries or operations that could be abused for DoS",
      "- Missing pagination on list endpoints",
      "",
      "### Data Exposure",
      "- Sensitive data returned in API responses that shouldn't be exposed",
      "- Verbose error messages that leak internal details",
      "- Missing field filtering on database query results",
      "",
      "## Severity Levels",
      "",
      "- **CRITICAL**: Immediately exploitable vulnerability (e.g., SQL injection, hardcoded secrets,",
      "  unauthenticated admin endpoints)",
      "- **HIGH**: Significant security gap that needs addressing before deployment (e.g., missing auth",
      "  on sensitive routes, CORS misconfiguration on authenticated APIs)",
      "- **MEDIUM**: Security best practice violation that should be addressed (e.g., missing rate",
      "  limiting, missing input validation on non-sensitive endpoints)",
      "- **LOW**: Minor improvement suggestion (e.g., could add additional logging, consider CSP headers)",
      "",
      "## Reporting Format",
      "",
      "When posting findings via `post_update`, use this format in the content:",
      "",
      "```",
      "SECURITY FINDING: [SEVERITY]",
      "Task: [task-id]",
      "File: [file-path]",
      "Line: [line-number or range]",
      "Issue: [brief description]",
      "Detail: [explanation of the vulnerability and potential impact]",
      "Recommendation: [suggested fix]",
      "```",
      "",
      "## Continuous Operation",
      "",
      "Keep polling for new completed tasks. Do not exit until you receive a wind_down message.",
      "When polling, space out your checks -- do not spam the coordinator with rapid requests.",
      invariantsSection,
    ].join("\n");
  }
}
