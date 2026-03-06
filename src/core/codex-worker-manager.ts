import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type {
  ExecutionWorkerManager,
  Message,
  OrchestratorEvent,
  SessionStatus,
  WorkerSharedContext,
} from "../utils/types.js";
import {
  MESSAGES_DIR,
  SESSIONS_DIR,
  SESSION_STATUS_FILE,
} from "../utils/constants.js";
import { getWorkerPrompt } from "../worker-prompt.js";
import type { Logger } from "../utils/logger.js";
import { coerceLogText, detectProviderRateLimit } from "../utils/provider-limit.js";

interface WorkerHandle {
  sessionId: string;
  promise: Promise<void>;
  events: OrchestratorEvent[];
  startedAt: string;
  child: ChildProcess | null;
  lastMessage: string | null;
  rateLimitReported: boolean;
}

type CodexSandboxMode = "workspace-write" | "read-only";

export class CodexWorkerManager implements ExecutionWorkerManager {
  private activeWorkers: Map<string, WorkerHandle> = new Map();
  private pendingEvents: OrchestratorEvent[] = [];

  private workerContext: WorkerSharedContext = {};

  constructor(
    private projectDir: string,
    private orchestratorDir: string,
    private mcpServerPath: string,
    private logger: Logger,
  ) {}

  setWorkerContext(context: WorkerSharedContext): void {
    this.workerContext = context;
  }

  async spawnWorker(sessionId: string): Promise<void> {
    if (this.activeWorkers.has(sessionId)) {
      this.logger.warn(`Worker ${sessionId} is already active; skipping spawn`);
      return;
    }

    this.logger.info(`Spawning Codex worker: ${sessionId}`);
    await this.initializeSessionStatus(sessionId, "Worker session starting...");

    const handle: WorkerHandle = {
      sessionId,
      promise: Promise.resolve(),
      events: [],
      startedAt: new Date().toISOString(),
      child: null,
      lastMessage: null,
      rateLimitReported: false,
    };

    this.activeWorkers.set(sessionId, handle);
    handle.promise = this.runCodexSession(
      sessionId,
      handle,
      this.buildWorkerPrompt(sessionId),
      "workspace-write",
      "Codex worker running...",
    );
  }

  async spawnSentinelWorker(): Promise<void> {
    const sentinelId = "sentinel-security";

    if (this.activeWorkers.has(sentinelId)) {
      this.logger.warn("Security sentinel is already running");
      return;
    }

    this.logger.info("Spawning Codex security sentinel...");
    await this.initializeSessionStatus(sentinelId, "Security sentinel starting...");

    const handle: WorkerHandle = {
      sessionId: sentinelId,
      promise: Promise.resolve(),
      events: [],
      startedAt: new Date().toISOString(),
      child: null,
      lastMessage: null,
      rateLimitReported: false,
    };

    this.activeWorkers.set(sentinelId, handle);
    handle.promise = this.runCodexSession(
      sentinelId,
      handle,
      this.buildSentinelPrompt(),
      "read-only",
      "Security sentinel running...",
    );
  }

  getActiveWorkers(): string[] {
    return Array.from(this.activeWorkers.keys());
  }

  isWorkerActive(sessionId: string): boolean {
    return this.activeWorkers.has(sessionId);
  }

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

    const messagePath = path.join(messagesDir, "orchestrator.jsonl");
    await fs.appendFile(messagePath, JSON.stringify(message) + "\n", "utf-8");
  }

  async waitForAllWorkers(timeoutMs: number): Promise<void> {
    const workerIds = this.getActiveWorkers();
    if (workerIds.length === 0) {
      this.logger.info("No active workers to wait for.");
      return;
    }

    this.logger.info(
      `Waiting for ${workerIds.length} worker(s) to finish (timeout: ${Math.round(timeoutMs / 1000)}s)...`,
    );

    const promises = workerIds.map((id) => this.activeWorkers.get(id)?.promise ?? Promise.resolve());
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
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

  async killAllWorkers(): Promise<void> {
    const workerIds = this.getActiveWorkers();
    if (workerIds.length === 0) {
      return;
    }

    this.logger.warn(`Force-killing ${workerIds.length} worker(s): ${workerIds.join(", ")}`);
    await this.signalWindDown("user_requested");

    for (const sessionId of workerIds) {
      const handle = this.activeWorkers.get(sessionId);
      handle?.child?.kill("SIGTERM");
      await this.updateSessionStatus(sessionId, "done", "Force killed by orchestrator");
      this.activeWorkers.delete(sessionId);
    }

    this.logger.info("All Codex workers have been killed and removed from tracking.");
  }

  getWorkerEvents(): OrchestratorEvent[] {
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    return events;
  }

  private async initializeSessionStatus(sessionId: string, progress: string): Promise<void> {
    const sessionDir = path.join(this.orchestratorDir, SESSIONS_DIR, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const initialStatus: SessionStatus = {
      session_id: sessionId,
      state: "starting",
      current_task: null,
      tasks_completed: [],
      progress,
      updated_at: new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(sessionDir, SESSION_STATUS_FILE),
      JSON.stringify(initialStatus, null, 2) + "\n",
      "utf-8",
    );
  }

  private async runCodexSession(
    sessionId: string,
    handle: WorkerHandle,
    prompt: string,
    sandbox: CodexSandboxMode,
    progress: string,
  ): Promise<void> {
    const outputPath = path.join(
      this.orchestratorDir,
      SESSIONS_DIR,
      sessionId,
      "codex-last-message.txt",
    );

    await this.updateSessionStatus(sessionId, "working", progress);

    return new Promise<void>((resolve, reject) => {
      const args = this.buildCodexExecArgs(sessionId, prompt, sandbox, outputPath);
      const child = spawn("codex", args, {
        cwd: this.projectDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      handle.child = child;

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let settled = false;

      const settle = (success: boolean, message: string): void => {
        if (settled) {
          return;
        }
        settled = true;

        void (async () => {
          if (success) {
            this.logger.info(`Codex worker ${sessionId} completed successfully.`);
            if (handle.lastMessage) {
              this.logger.debug(
                `Codex worker ${sessionId} final message: ${handle.lastMessage.substring(0, 200)}`,
              );
            }
            this.recordEvent(handle, { type: "session_done", sessionId });
            await this.updateSessionStatus(sessionId, "done", "Completed successfully");
          } else {
            this.logger.error(`Codex worker ${sessionId} failed: ${message}`);
            this.maybeRecordRateLimit(handle, sessionId, message);
            this.recordEvent(handle, { type: "session_failed", sessionId, error: message });
            await this.updateSessionStatus(sessionId, "failed", message);
          }

          handle.child = null;
          this.activeWorkers.delete(sessionId);
        })()
          .then(() => {
            if (success) {
              resolve();
            } else {
              reject(new Error(message));
            }
          })
          .catch(reject);
      };

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");

      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer = this.consumeLines(stdoutBuffer + chunk, (line) => {
          this.processCodexOutputLine(sessionId, handle, line);
        });
      });

      child.stderr.on("data", (chunk: string) => {
        stderrBuffer = this.consumeLines(stderrBuffer + chunk, (line) => {
          if (line.trim().length > 0) {
            this.maybeRecordRateLimit(handle, sessionId, line);
            this.logger.debug(`Codex worker ${sessionId} stderr: ${line}`);
          }
        });
      });

      child.on("error", (err) => {
        settle(false, err.message);
      });

      child.on("close", (code, signal) => {
        stdoutBuffer = this.consumeLines(stdoutBuffer, (line) => {
          this.processCodexOutputLine(sessionId, handle, line);
        }, true);
        stderrBuffer = this.consumeLines(stderrBuffer, (line) => {
          if (line.trim().length > 0) {
            this.logger.debug(`Codex worker ${sessionId} stderr: ${line}`);
          }
        }, true);

        if (code === 0) {
          settle(true, "Completed successfully");
          return;
        }

        const reason = signal
          ? `Codex worker terminated by signal ${signal}`
          : `Codex exited with code ${code ?? "unknown"}`;
        settle(false, reason);
      });
    });
  }

  private consumeLines(
    buffer: string,
    onLine: (line: string) => void,
    flushRemainder = false,
  ): string {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const remainder = flushRemainder ? "" : (lines.pop() ?? "");

    for (const line of flushRemainder ? lines.filter((entry) => entry.length > 0) : lines) {
      if (line.trim().length > 0) {
        onLine(line);
      }
    }

    if (flushRemainder && remainder.trim().length > 0) {
      onLine(remainder);
    }

    return remainder;
  }

  private processCodexOutputLine(
    sessionId: string,
    handle: WorkerHandle,
    line: string,
  ): void {
    const parsed = this.tryParseJsonLine(line);
    if (!parsed) {
      this.maybeRecordRateLimit(handle, sessionId, line);
      this.logger.debug(`Codex worker ${sessionId}: ${line}`);
      return;
    }

    const eventType = typeof parsed.type === "string" ? parsed.type : "unknown";

    if (eventType === "error") {
      const message = coerceLogText(parsed.message ?? parsed);
      this.maybeRecordRateLimit(handle, sessionId, message);
      this.logger.warn(`Codex worker ${sessionId} reported: ${message}`);
      return;
    }

    if (eventType === "item.completed") {
      const item = parsed.item as Record<string, unknown> | undefined;
      const messageText = this.extractAgentMessageText(item);
      if (messageText) {
        handle.lastMessage = messageText;
        this.maybeRecordRateLimit(handle, sessionId, messageText);
        this.logger.debug(`Codex worker ${sessionId} message: ${messageText.substring(0, 200)}`);
      }
      return;
    }

    if (eventType === "turn.completed") {
      const usage = parsed.usage as Record<string, unknown> | undefined;
      if (usage) {
        this.logger.debug(`Codex worker ${sessionId} turn completed: ${JSON.stringify(usage)}`);
      }
      return;
    }

    this.logger.debug(`Codex worker ${sessionId} event: ${line}`);
  }

  private tryParseJsonLine(line: string): Record<string, unknown> | null {
    if (!line.trim().startsWith("{")) {
      return null;
    }

    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private extractAgentMessageText(item: Record<string, unknown> | undefined): string | null {
    if (!item || item.type !== "agent_message") {
      return null;
    }

    if (typeof item.text === "string") {
      return item.text;
    }

    if (Array.isArray(item.content)) {
      const parts = item.content
        .map((entry) => {
          if (typeof entry === "string") {
            return entry;
          }
          if (entry && typeof entry === "object" && "text" in entry) {
            return coerceLogText((entry as Record<string, unknown>).text);
          }
          return "";
        })
        .filter((entry) => entry.length > 0);

      if (parts.length > 0) {
        return parts.join("\n");
      }
    }

    return null;
  }

  private buildCodexExecArgs(
    sessionId: string,
    prompt: string,
    sandbox: CodexSandboxMode,
    outputPath: string,
  ): string[] {
    return [
      "exec",
      "--json",
      "--full-auto",
      "--sandbox",
      sandbox,
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "-o",
      outputPath,
      "-C",
      this.projectDir,
      "-c",
      'mcp_servers.coordinator.command="node"',
      "-c",
      `mcp_servers.coordinator.args=[${JSON.stringify(this.mcpServerPath)}]`,
      "-c",
      `mcp_servers.coordinator.env.CONDUCTOR_DIR=${JSON.stringify(this.orchestratorDir)}`,
      "-c",
      `mcp_servers.coordinator.env.SESSION_ID=${JSON.stringify(sessionId)}`,
      "-c",
      "mcp_servers.coordinator.startup_timeout_sec=10",
      "-c",
      "mcp_servers.coordinator.tool_timeout_sec=30",
      "-c",
      "mcp_servers.coordinator.enabled=true",
      "-c",
      "mcp_servers.coordinator.required=false",
      prompt,
    ];
  }

  private async updateSessionStatus(
    sessionId: string,
    state: SessionStatus["state"],
    progress: string,
  ): Promise<void> {
    const sessionDir = path.join(this.orchestratorDir, SESSIONS_DIR, sessionId);

    try {
      await fs.mkdir(sessionDir, { recursive: true });

      const statusPath = path.join(sessionDir, SESSION_STATUS_FILE);
      let existing: SessionStatus | null = null;

      try {
        const raw = await fs.readFile(statusPath, "utf-8");
        existing = JSON.parse(raw) as SessionStatus;
      } catch {
        // Start fresh if the status file is missing or malformed.
      }

      const status: SessionStatus = {
        session_id: sessionId,
        state,
        current_task: existing?.current_task ?? null,
        tasks_completed: existing?.tasks_completed ?? [],
        progress,
        updated_at: new Date().toISOString(),
      };

      await fs.writeFile(statusPath, JSON.stringify(status, null, 2) + "\n", "utf-8");
    } catch (err) {
      this.logger.error(
        `Failed to update session status for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildWorkerPrompt(sessionId: string): string {
    return getWorkerPrompt({
      sessionId,
      runtime: "codex",
      ...this.workerContext,
    });
  }

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
      "You must NEVER write, edit, or modify any files. You may only read files, run safe read-only commands, and use the coordinator MCP tools.",
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

  private recordEvent(handle: WorkerHandle, event: OrchestratorEvent): void {
    handle.events.push(event);
    this.pendingEvents.push(event);
  }

  private maybeRecordRateLimit(
    handle: WorkerHandle,
    sessionId: string,
    detail: string,
  ): void {
    if (handle.rateLimitReported) {
      return;
    }

    const signal = detectProviderRateLimit("codex", detail);
    if (!signal) {
      return;
    }

    handle.rateLimitReported = true;
    this.logger.warn(`Codex worker ${sessionId} hit a usage limit: ${signal.detail}`);
    this.recordEvent(handle, {
      type: "provider_rate_limited",
      sessionId,
      provider: signal.provider,
      detail: signal.detail,
      resets_at: signal.resetsAt,
    });
  }
}
