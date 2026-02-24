import fs from "node:fs/promises";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  OrchestratorEvent,
  Message,
  SessionStatus,
} from "../utils/types.js";
import {
  WORKER_ALLOWED_TOOLS,
  DEFAULT_WORKER_MAX_TURNS,
  MESSAGES_DIR,
  SESSIONS_DIR,
  SESSION_STATUS_FILE,
} from "../utils/constants.js";
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
                ORCHESTRATOR_DIR: this.orchestratorDir,
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
  // Private: Prompt builder
  // ----------------------------------------------------------------

  /**
   * Build the system prompt for a worker session.
   */
  private buildWorkerPrompt(sessionId: string): string {
    return [
      "You are a worker session in a multi-agent orchestration system.",
      `Your session ID is: ${sessionId}`,
      "",
      "## Orchestration Protocol",
      "",
      "You are one of several parallel worker agents managed by an orchestrator.",
      "You communicate with the orchestrator through an MCP coordination server.",
      "",
      "### Workflow",
      "",
      "1. **Get available tasks**: Call `get_tasks` with status_filter='pending' to see",
      "   what work is available.",
      "",
      "2. **Claim a task**: Call `claim_task` with a task_id to atomically claim it.",
      "   Only claim tasks whose dependencies are all completed.",
      "   If the claim fails (task already taken), try another pending task.",
      "",
      "3. **Implement the task**: Use your development tools (Read, Write, Edit, Bash,",
      "   Glob, Grep) to implement the task as described in its description.",
      "   Follow the project's existing conventions and patterns.",
      "",
      "4. **Test your work**: Run relevant tests to verify your implementation.",
      "   Fix any failures before marking the task as complete.",
      "",
      "5. **Complete the task**: Call `complete_task` with a result summary and",
      "   list of files changed.",
      "",
      "6. **Repeat**: Go back to step 1 and look for more tasks.",
      "",
      "### Communication",
      "",
      "- Call `read_updates` periodically to check for messages from the orchestrator.",
      "- If you receive a `wind_down` message, finish your current task and exit cleanly.",
      "- Call `post_update` to report progress or ask questions.",
      "- If you encounter a blocking issue, post an `escalation` message.",
      "",
      "### Rules",
      "",
      "- Only work on tasks you have successfully claimed.",
      "- Never modify files that are clearly outside your task scope.",
      "- Commit your work after completing each task (use git add -A && git commit).",
      "- If a task is too large, break it down and complete it in stages.",
      "- If all pending tasks have unmet dependencies, post a status update and wait.",
      "- Check for wind_down messages after completing each task.",
      "",
      "### Start",
      "",
      "Begin by calling `get_tasks` to see available work, then `claim_task` to pick up a task.",
    ].join("\n");
  }
}
