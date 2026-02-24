import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { query } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";

import type {
  CLIOptions,
  CycleRecord,
  CodexVerdict,
  FlowTracingReport,
  FlowTracingSummary,
  PlannerOutput,
  Task,
  TaskDefinition,
  ProjectConventions,
  ThreatModel,
  KnownIssue,
  FlowFinding,
} from "../utils/types.js";

import {
  BRANCH_PREFIX,
  getLogsDir,
  getOrchestratorDir,
  getPlanPath,
  getCodexReviewsDir,
  getEscalationPath,
  getPauseSignalPath,
  getKnownIssuesPath,
  MAX_PLAN_DISCUSSION_ROUNDS,
  MAX_CODE_REVIEW_ROUNDS,
  MAX_DISAGREEMENT_ROUNDS,
  DEFAULT_WORKER_POLL_INTERVAL_MS,
  WIND_DOWN_GRACE_PERIOD_MS,
} from "../utils/constants.js";

import { Logger } from "../utils/logger.js";
import { GitManager } from "../utils/git.js";
import { StateManager } from "./state-manager.js";
import { UsageMonitor } from "./usage-monitor.js";
import { CodexReviewer } from "./codex-reviewer.js";
import { Planner } from "./planner.js";
import { WorkerManager } from "./worker-manager.js";
import { FlowTracer } from "./flow-tracer.js";
import { extractConventions } from "../utils/conventions-extractor.js";
import { loadWorkerRules } from "../utils/rules-loader.js";
import { runSemgrep } from "../utils/semgrep-runner.js";
import { loadKnownIssues, addKnownIssues, getUnresolvedIssues } from "../utils/known-issues.js";

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

// ============================================================
// Orchestrator
// ============================================================

export class Orchestrator {
  private state: StateManager;
  private usage: UsageMonitor;
  private codex: CodexReviewer;
  private planner: Planner;
  private workers: WorkerManager;
  private flowTracer: FlowTracer;
  private git: GitManager;
  private logger: Logger;
  private options: CLIOptions;

  // Stores the Q&A context gathered during initialization
  private qaContext: string = "";

  // Project conventions extracted pre-execution
  private conventions: ProjectConventions | null = null;
  private projectRules: string = "";
  private threatModel: ThreatModel | null = null;

  // Stores any user redirect guidance gathered during escalation
  private redirectGuidance: string | null = null;

  // Tracks the base branch for diffing
  private baseBranch: string = "main";

  // Tracks whether usage reached critical during execution
  private usageCritical: boolean = false;
  private usageCriticalResetsAt: string = "unknown";

  // Tracks whether a user-requested pause was detected
  private userPauseRequested: boolean = false;

  constructor(options: CLIOptions) {
    this.options = options;

    if (options.verbose) {
      process.env.VERBOSE = "1";
    }

    const logsDir = getLogsDir(options.project);
    this.logger = new Logger(logsDir, "orchestrator");

    this.state = new StateManager(options.project);

    this.git = new GitManager(options.project);

    const orchestratorDir = getOrchestratorDir(options.project);

    // Resolve the MCP coordination server path relative to this package's
    // dist/ directory (not the user's project). This works whether the
    // package is installed globally, linked, or run via npx.
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const mcpServerPath = path.join(__dirname, "..", "mcp", "coordination-server.js");

    this.codex = new CodexReviewer(options.project, this.logger);
    this.planner = new Planner(options.project, this.logger);

    this.usage = new UsageMonitor({
      threshold: options.usageThreshold,
      onWarning: (utilization) => {
        this.logger.warn(
          `Usage warning: ${(utilization * 100).toFixed(1)}% of 5-hour window consumed`,
        );
      },
      onCritical: (utilization, resetsAt) => {
        this.logger.error(
          `Usage CRITICAL: ${(utilization * 100).toFixed(1)}% consumed, resets at ${resetsAt}`,
        );
        this.usageCritical = true;
        this.usageCriticalResetsAt = resetsAt;
      },
      logger: this.logger,
    });

    this.workers = new WorkerManager(
      options.project,
      orchestratorDir,
      mcpServerPath,
      this.logger,
    );

    this.flowTracer = new FlowTracer(options.project, this.logger);
  }

  // ================================================================
  // Main entry point
  // ================================================================

  async run(): Promise<void> {
    try {
      await this.initialize();

      let planVersion = 1;
      const state = this.state.get();

      // On resume, check if tasks already exist — if so, skip planning
      // for the first cycle and go straight to execution.
      let skipPlanningThisCycle = false;
      if (this.options.resume) {
        const existingTasks = await this.state.getAllTasks();
        const hasPendingOrInProgress = existingTasks.some(
          (t) => t.status === "pending" || t.status === "in_progress",
        );
        if (hasPendingOrInProgress) {
          skipPlanningThisCycle = true;
          // Infer plan version from cycle history
          if (state.cycle_history.length > 0) {
            planVersion = state.cycle_history[state.cycle_history.length - 1].plan_version;
          }
          this.logger.info(
            `Resuming with ${existingTasks.length} existing task(s) — skipping planning phase`,
          );
        }
      }

      while (state.current_cycle < state.max_cycles) {
        const cycleStart = Date.now();
        const cycleNum = state.current_cycle + 1;

        this.logger.info(`\n${"=".repeat(60)}`);
        this.logger.info(`  CYCLE ${cycleNum} of ${state.max_cycles}`);
        this.logger.info(`${"=".repeat(60)}\n`);

        // Phase 1: Planning (skip on resume if tasks already exist)
        if (skipPlanningThisCycle) {
          skipPlanningThisCycle = false; // only skip once
          this.logger.info("Skipping planning phase (resuming with existing tasks).");
        } else {
          planVersion = await this.plan(planVersion, cycleNum > 1);

          // Check if planning triggered a Codex rate-limit pause
          if (this.state.get().status === "paused") {
            return;
          }
        }

        // If dry run, print plan and exit
        if (this.options.dryRun) {
          const planPath = getPlanPath(this.options.project, planVersion);
          try {
            const planContent = await fs.readFile(planPath, "utf-8");
            console.log("\n" + chalk.bold.cyan("=== DRY RUN: Plan Output ===") + "\n");
            console.log(planContent);
            console.log("\n" + chalk.bold.cyan("=== End of Plan ===") + "\n");
          } catch {
            this.logger.warn("Could not read plan file for dry run display");
          }
          this.logger.info("Dry run complete. Exiting without executing.");
          return;
        }

        // Extract project conventions (pre-execution phase)
        this.logger.info("Extracting project conventions...");
        this.conventions = await extractConventions(this.options.project);
        this.projectRules = await loadWorkerRules(this.options.project);

        // Pass context to worker manager
        this.workers.setWorkerContext({
          qaContext: this.qaContext,
          conventions: this.conventions,
          projectRules: this.projectRules,
          featureDescription: this.options.feature,
          threatModelSummary: this.threatModel
            ? this.formatThreatModelForWorkers(this.threatModel)
            : undefined,
        });

        // Phase 2: Execution
        await this.execute();

        // Phase 3: Code review and flow tracing in parallel (both are read-only)
        const [approved, flowReport] = await Promise.all([
          this.review(),
          this.flowReview(cycleNum),
        ]);

        // Check if review triggered a Codex rate-limit pause
        if (this.state.get().status === "paused") {
          return;
        }

        // Track findings in known issues registry
        if (flowReport && flowReport.findings.length > 0) {
          await addKnownIssues(this.options.project, flowReport.findings.map((f) => ({
            description: `${f.title}: ${f.description}`,
            severity: f.severity,
            source: "flow_tracing" as const,
            file_path: f.file_path,
            found_in_cycle: cycleNum,
          })));
        }

        // Phase 4: Checkpoint
        let result = await this.checkpoint();

        // If flow tracing found critical/high issues, force another cycle
        if (flowReport && (flowReport.summary.critical > 0 || flowReport.summary.high > 0)) {
          this.logger.warn(
            `Flow tracing found ${flowReport.summary.critical} critical and ${flowReport.summary.high} high severity issues. Forcing another cycle.`,
          );
          // Create fix tasks from flow findings
          await this.createFixTasksFromFindings(flowReport);
          result = "continue";
        }

        // If code review was not approved, force another cycle
        if (!approved && result === "complete") {
          this.logger.warn("Code review not approved. Forcing another cycle.");
          result = "continue";
        }

        // Record cycle
        const completedTasks = await this.state.getTasksByStatus("completed");
        const failedTasks = await this.state.getTasksByStatus("failed");

        const cycleRecord: CycleRecord = {
          cycle: cycleNum,
          plan_version: planVersion,
          tasks_completed: completedTasks.length,
          tasks_failed: failedTasks.length,
          codex_plan_approved: true, // Updated in plan() if applicable
          codex_code_approved: approved,
          plan_discussion_rounds: 0,
          code_review_rounds: 0,
          duration_ms: Date.now() - cycleStart,
          started_at: new Date(cycleStart).toISOString(),
          completed_at: new Date().toISOString(),
          flow_tracing: flowReport
            ? FlowTracer.toSummary(flowReport, flowReport.summary.total > 0 ? Date.now() - cycleStart : 0)
            : undefined,
        };
        await this.state.recordCycle(cycleRecord);

        if (result === "complete") {
          await this.complete();
          return;
        }

        if (result === "pause") {
          await this.handleUsagePause();
          // For user-requested pause, handleUsagePause returns immediately
          // (or exits the process in non-interactive mode). Check if we're
          // still paused — if so, stop the cycle loop.
          if (this.state.get().status === "paused") {
            return;
          }
          // For usage-triggered pause, handleUsagePause waits for reset
          // then resumes. Continue to next cycle.
          continue;
        }

        if (result === "escalate") {
          const escalationResult = await this.escalateToUser(
            "Cycle limit or persistent issues",
            `Completed ${cycleNum} cycle(s). Some tasks may remain incomplete.`,
          );

          if (escalationResult === "stop") {
            this.logger.info("User requested stop. Finishing up.");
            await this.complete();
            return;
          }

          if (escalationResult === "redirect") {
            // redirectGuidance was set in escalateToUser
            this.logger.info("User provided new guidance. Replanning in next cycle.");
          }

          // "continue" falls through to next cycle
        }

        // Increment cycle
        state.current_cycle = cycleNum;
      }

      // Exhausted all cycles
      this.logger.warn("Maximum cycles reached. Completing with current state.");
      await this.complete();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Orchestrator failed: ${message}`);
      try {
        await this.state.setStatus("failed");
      } catch {
        // Best effort
      }
      throw err;
    }
  }

  // ================================================================
  // Phase 0: Interactive Initialization
  // ================================================================

  private async initialize(): Promise<void> {
    this.logger.info("Initializing orchestrator...");

    // Create directory structure
    await this.state.createDirectories();

    if (this.options.resume) {
      // Resume from existing state
      this.logger.info("Resuming from existing state...");
      const loaded = await this.state.load();

      if (loaded.base_commit_sha) {
        // Was started with --current-branch; use the saved commit SHA for diffs
        this.baseBranch = loaded.base_commit_sha;
      } else {
        this.baseBranch = loaded.branch.replace(BRANCH_PREFIX, "");
      }

      // Checkout the existing orchestration branch (skip if using current branch)
      if (!loaded.base_commit_sha) {
        try {
          await this.git.checkout(loaded.branch);
        } catch {
          this.logger.warn(`Could not checkout branch ${loaded.branch}; continuing on current branch`);
        }
      }

      // Log warning if Codex was recently rate-limited
      if (loaded.codex_metrics?.last_presumed_rate_limit_at) {
        const limitedAt = new Date(loaded.codex_metrics.last_presumed_rate_limit_at).getTime();
        const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
        if (limitedAt > fiveHoursAgo) {
          this.logger.warn(
            `Codex was rate-limited at ${loaded.codex_metrics.last_presumed_rate_limit_at}. ` +
            `Rate limit may still be in effect.`,
          );
        }
      }

      await this.state.resume();
      this.logger.info(`Resumed orchestration for: ${loaded.feature}`);
      return;
    }

    // Fresh initialization
    if (this.options.currentBranch) {
      // --current-branch mode: stay on current branch, record HEAD SHA for diffs
      let branchName: string;
      let sha: string;

      try {
        if (await this.git.isDetachedHead()) {
          throw new Error(
            "Cannot use --current-branch in detached HEAD state. " +
            "Please checkout a branch first.",
          );
        }
        branchName = await this.git.getCurrentBranch();
        sha = await this.git.getHeadSha();
      } catch (err) {
        if (err instanceof Error && err.message.includes("detached HEAD")) {
          throw err;
        }
        throw new Error(
          "Cannot use --current-branch: failed to read git state. " +
          "Ensure the repository has at least one commit. " +
          `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
      this.baseBranch = sha;

      await this.state.initialize(this.options.feature, branchName, {
        maxCycles: this.options.maxCycles,
        concurrency: this.options.concurrency,
        baseCommitSha: sha,
      });

      this.logger.info(`Using current branch: ${branchName} (base commit: ${sha.substring(0, 8)})`);
    } else {
      // Default: create orchestration branch
      const featureSlug = slugify(this.options.feature);
      const branchName = `${BRANCH_PREFIX}${featureSlug}`;

      // Capture base branch before creating the orchestration branch
      try {
        this.baseBranch = await this.git.getCurrentBranch();
      } catch {
        this.baseBranch = "main";
      }

      // Create orchestration branch
      try {
        await this.git.createBranch(branchName);
        this.logger.info(`Created branch: ${branchName}`);
      } catch {
        this.logger.warn(`Branch ${branchName} may already exist; attempting checkout`);
        try {
          await this.git.checkout(branchName);
        } catch {
          this.logger.warn(`Could not checkout ${branchName}; continuing on current branch`);
        }
      }

      // Initialize state
      await this.state.initialize(this.options.feature, branchName, {
        maxCycles: this.options.maxCycles,
        concurrency: this.options.concurrency,
      });
    }

    // Print welcome banner
    this.printBanner();

    // Phase: Questioning — either read from context file or run interactive Q&A
    if (this.options.contextFile) {
      // Non-interactive mode: read pre-gathered context from file
      this.logger.info(`Reading pre-gathered context from: ${this.options.contextFile}`);
      try {
        this.qaContext = await fs.readFile(this.options.contextFile, "utf-8");
        this.logger.info(`Loaded ${this.qaContext.length} chars of context from file`);
      } catch (err) {
        throw new Error(
          `Failed to read context file ${this.options.contextFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Interactive mode: ask questions via stdin
      await this.state.setStatus("questioning");
      this.qaContext = await this.planner.askQuestions(this.options.feature);
    }

    this.logger.info("Initialization complete.");
  }

  // ================================================================
  // Phase 1: Planning with Codex review
  // ================================================================

  private async plan(planVersion: number, isReplan: boolean): Promise<number> {
    await this.state.setStatus("planning");
    this.logger.info(`Planning phase (version ${planVersion}, replan=${isReplan})...`);

    let planOutput: PlannerOutput;

    if (isReplan) {
      const completedTasks = await this.state.getTasksByStatus("completed");
      const failedTasks = await this.state.getTasksByStatus("failed");
      const previousPlanPath = getPlanPath(this.options.project, planVersion - 1);

      // Include any redirect guidance from user escalation
      const codexFeedback = this.redirectGuidance;
      this.redirectGuidance = null;

      // Build cycle feedback from review issues, flow findings, and known issues
      const unresolvedIssues = await getUnresolvedIssues(this.options.project);
      const cycleFeedback = this.buildCycleFeedback(codexFeedback, null, unresolvedIssues);

      planOutput = await this.planner.replan(
        this.options.feature,
        previousPlanPath,
        completedTasks,
        failedTasks,
        codexFeedback,
        planVersion,
        cycleFeedback || undefined,
      );
    } else {
      planOutput = await this.planner.createPlan(
        this.options.feature,
        this.qaContext,
        planVersion,
      );
    }

    // Store threat model if present in plan output
    if (planOutput.threat_model) {
      this.threatModel = planOutput.threat_model;
    }

    // Codex plan review (unless skipped)
    if (!this.options.skipCodex) {
      const codexAvailable = await this.codex.isAvailable();

      if (codexAvailable) {
        const planPath = getPlanPath(this.options.project, planVersion);
        let reviewResult = await this.codex.reviewPlan(planPath);

        let discussionRound = 0;
        const issueCounts = new Map<string, number>();

        // If Codex errored, log clearly and proceed without review
        if (reviewResult.verdict === "ERROR") {
          this.logger.error(
            `Codex plan review FAILED: ${reviewResult.raw_output}. Proceeding without plan review.`,
          );
        }

        // If Codex is rate-limited, pause the orchestrator
        if (reviewResult.verdict === "RATE_LIMITED") {
          await this.handleCodexRateLimit();
          return planVersion;
        }

        while (
          reviewResult.verdict !== "APPROVE" &&
          reviewResult.verdict !== "ERROR" &&
          discussionRound < MAX_PLAN_DISCUSSION_ROUNDS
        ) {
          discussionRound++;
          this.logger.info(
            `Plan review round ${discussionRound}: verdict=${reviewResult.verdict}, ` +
            `${reviewResult.issues.length} issue(s)`,
          );

          // Track recurring issues
          for (const issue of reviewResult.issues) {
            const issueKey = issue.substring(0, 80);
            const count = (issueCounts.get(issueKey) ?? 0) + 1;
            issueCounts.set(issueKey, count);

            if (count >= MAX_DISAGREEMENT_ROUNDS) {
              this.logger.warn(`Persistent disagreement on issue: ${issueKey}`);
              const escalation = await this.escalateToUser(
                "Plan review disagreement",
                `Codex and planner disagree on: ${issue}\n\nCodex verdict: ${reviewResult.verdict}\n\nFull output:\n${reviewResult.raw_output}`,
              );

              if (escalation === "stop") {
                this.logger.info("User requested stop during plan review.");
                throw new Error("User stopped orchestration during plan review");
              }
              // Clear the issue count to allow continued discussion
              issueCounts.set(issueKey, 0);
            }
          }

          // Spawn investigator to respond to Codex feedback
          const responsePath = path.join(
            getCodexReviewsDir(this.options.project),
            `plan-discussion-round-${discussionRound}.md`,
          );

          const investigatorPrompt = [
            "You are responding to a code review from Codex (OpenAI).",
            "Review the feedback and either update the plan or explain why the current approach is correct.",
            "",
            "## Codex Feedback",
            "",
            reviewResult.raw_output,
            "",
            "## Instructions",
            "",
            "1. Read the current plan and the codebase to understand the context.",
            "2. For each issue raised, either:",
            "   a. Agree and describe the fix needed, OR",
            "   b. Explain why the current approach is correct.",
            "3. If fixes are needed, update the plan file accordingly.",
            "4. Provide a clear, structured response addressing each point.",
          ].join("\n");

          let responseText = "";
          const asyncIterable = query({
            prompt: investigatorPrompt,
            options: {
              allowedTools: ["Read", "Glob", "Grep", "Write", "Edit"],
              cwd: this.options.project,
              maxTurns: 20,
            },
          });

          for await (const event of asyncIterable) {
            if (event.type === "result" && "result" in event) {
              responseText =
                typeof event.result === "string"
                  ? event.result
                  : JSON.stringify(event.result);
            }
          }

          // Save the response
          await fs.writeFile(responsePath, responseText, "utf-8");
          this.logger.debug(`Discussion response saved to ${responsePath}`);

          // Re-review with the response
          reviewResult = await this.codex.reReviewPlan(planPath, responsePath);

          // Check for rate limit after re-review
          if (reviewResult.verdict === "RATE_LIMITED") {
            await this.handleCodexRateLimit();
            return planVersion;
          }
        }

        // Persist metrics after plan review
        await this.state.updateCodexMetrics(this.codex.getMetrics());

        if (reviewResult.verdict === "APPROVE") {
          this.logger.info("Codex APPROVED the plan.");
        } else if (reviewResult.verdict === "ERROR") {
          this.logger.error(
            "Codex plan review errored out. Plan was NOT reviewed by Codex.",
          );
        } else {
          this.logger.warn(
            `Plan review ended without full approval (verdict: ${reviewResult.verdict}). Proceeding anyway.`,
          );
        }
      } else {
        this.logger.info("Codex CLI not available; skipping plan review.");
      }
    } else {
      this.logger.info("Codex review skipped (--skip-codex).");
    }

    // Create tasks from plan output
    const subjectToId = new Map<string, string>();

    // First pass: assign IDs
    for (let i = 0; i < planOutput.tasks.length; i++) {
      const def = planOutput.tasks[i];
      const taskId = `task-${String(i + 1).padStart(3, "0")}`;
      subjectToId.set(def.subject, taskId);
    }

    // Second pass: create tasks with resolved dependency IDs
    for (let i = 0; i < planOutput.tasks.length; i++) {
      const def = planOutput.tasks[i];
      const taskId = `task-${String(i + 1).padStart(3, "0")}`;

      const dependencyIds: string[] = [];
      for (const depSubject of def.depends_on_subjects) {
        const depId = subjectToId.get(depSubject);
        if (depId) {
          dependencyIds.push(depId);
        } else {
          this.logger.warn(
            `Task "${def.subject}" depends on unknown subject "${depSubject}"; skipping dependency`,
          );
        }
      }

      await this.state.createTask(def, taskId, dependencyIds);
      this.logger.debug(`Created task ${taskId}: ${def.subject}`);
    }

    this.logger.info(`Created ${planOutput.tasks.length} task(s) from plan.`);
    return planVersion;
  }

  // ================================================================
  // Phase 2: Execution
  // ================================================================

  private async execute(): Promise<void> {
    await this.state.setStatus("executing");
    this.logger.info("Execution phase: spawning workers...");

    // Reset usage critical flag
    this.usageCritical = false;

    // Reset any orphaned tasks from a previous run/crash before spawning
    const activeBeforeStart = this.workers.getActiveWorkers();
    const orphansReset = await this.state.resetOrphanedTasks(activeBeforeStart);
    if (orphansReset > 0) {
      this.logger.info(`Reset ${orphansReset} orphaned task(s) from previous run`);
    }

    // Start usage monitoring
    this.usage.start();

    try {
      // Determine how many workers to spawn
      const pendingTasks = await this.state.getTasksByStatus("pending");
      const numWorkers = Math.min(this.options.concurrency, pendingTasks.length);

      if (numWorkers === 0) {
        this.logger.info("No pending tasks to execute.");
        return;
      }

      this.logger.info(`Spawning ${numWorkers} worker(s) for ${pendingTasks.length} pending task(s)`);

      // Spawn initial workers
      for (let i = 0; i < numWorkers; i++) {
        const sessionId = `worker-${Date.now()}-${i}`;
        await this.workers.spawnWorker(sessionId);
        await this.state.addActiveSession(sessionId);
      }

      // Spawn security sentinel (runs in parallel with workers)
      await this.workers.spawnSentinelWorker();

      // Monitor loop
      let iteration = 0;
      while (true) {
        iteration++;

        // Check if all tasks are complete
        const allTasks = await this.state.getAllTasks();
        const remaining = allTasks.filter(
          (t) => t.status === "pending" || t.status === "in_progress",
        );
        const completed = allTasks.filter((t) => t.status === "completed");
        const failed = allTasks.filter((t) => t.status === "failed");

        if (remaining.length === 0) {
          this.logger.info("All tasks complete. Ending execution phase.");
          break;
        }

        // Check usage
        if (this.usageCritical) {
          this.logger.warn("Usage critical. Signaling workers to wind down...");
          await this.workers.signalWindDown("usage_limit", this.usageCriticalResetsAt);
          await this.workers.waitForAllWorkers(WIND_DOWN_GRACE_PERIOD_MS);
          break;
        }

        if (this.usage.isWindDownNeeded()) {
          this.logger.warn("Usage threshold reached. Signaling wind-down...");
          const resetTime = this.usage.getResetTime();
          await this.workers.signalWindDown("usage_limit", resetTime ?? undefined);
          await this.workers.waitForAllWorkers(WIND_DOWN_GRACE_PERIOD_MS);
          break;
        }

        // Check for user-requested pause signal file
        if (await this.checkPauseSignal()) {
          this.logger.warn("User-requested pause detected. Signaling workers to wind down...");
          this.userPauseRequested = true;
          await this.workers.signalWindDown("user_requested");
          await this.workers.waitForAllWorkers(WIND_DOWN_GRACE_PERIOD_MS);
          break;
        }

        // Check for orphaned tasks: in_progress tasks whose owner worker is dead
        const activeWorkers = this.workers.getActiveWorkers();
        const orphaned = await this.state.resetOrphanedTasks(activeWorkers);
        if (orphaned > 0) {
          this.logger.info(`Reset ${orphaned} orphaned task(s) from dead worker(s)`);
        }

        // Re-read tasks after orphan reset to get accurate pending count
        const refreshedTasks = orphaned > 0 ? await this.state.getAllTasks() : allTasks;
        const pendingNow = refreshedTasks.filter((t) => t.status === "pending");

        if (activeWorkers.length === 0 && pendingNow.length > 0) {
          // All workers finished but tasks remain — respawn
          const respawnCount = Math.min(this.options.concurrency, pendingNow.length);
          this.logger.info(
            `All workers done but ${pendingNow.length} task(s) remain. Respawning ${respawnCount} worker(s)...`,
          );
          for (let i = 0; i < respawnCount; i++) {
            const sessionId = `worker-${Date.now()}-respawn-${i}`;
            await this.workers.spawnWorker(sessionId);
            await this.state.addActiveSession(sessionId);
          }
        } else if (activeWorkers.length === 0 && pendingNow.length === 0) {
          // No active workers, no pending tasks — execution is done
          break;
        }

        // Print progress
        if (iteration % 3 === 0) {
          this.printProgress(completed.length, failed.length, remaining.length, activeWorkers.length);
        }

        // Sleep between checks
        await sleep(DEFAULT_WORKER_POLL_INTERVAL_MS);
      }
    } finally {
      // Stop usage monitoring
      this.usage.stop();

      // Update usage snapshot in state
      await this.state.updateUsage(this.usage.getUsage());
    }
  }

  // ================================================================
  // Phase 3: Code review with Codex
  // ================================================================

  private async review(): Promise<boolean> {
    await this.state.setStatus("reviewing");
    this.logger.info("Review phase: checking code changes...");

    if (this.options.skipCodex) {
      this.logger.info("Codex review skipped (--skip-codex).");
      return true;
    }

    const codexAvailable = await this.codex.isAvailable();
    if (!codexAvailable) {
      this.logger.info("Codex CLI not available; skipping code review.");
      return true;
    }

    // Get diff from base branch
    let diff: string;
    let changedFiles: string[];
    try {
      diff = await this.git.getDiff(this.baseBranch);
      changedFiles = await this.git.getChangedFiles(this.baseBranch);
    } catch (err) {
      this.logger.warn(`Could not get git diff: ${err instanceof Error ? err.message : String(err)}`);
      return true; // Can't review without a diff
    }

    if (!diff || diff.trim().length === 0) {
      this.logger.info("No code changes to review.");
      return true;
    }

    // Write diff and changed files to codex-reviews/
    const reviewsDir = getCodexReviewsDir(this.options.project);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const diffPath = path.join(reviewsDir, `diff-${timestamp}.patch`);
    const changedFilesPath = path.join(reviewsDir, `changed-files-${timestamp}.txt`);

    await fs.writeFile(diffPath, diff, "utf-8");
    await fs.writeFile(changedFilesPath, changedFiles.join("\n"), "utf-8");

    // Get the current plan path
    const state = this.state.get();
    const latestPlanVersion =
      state.cycle_history.length > 0
        ? state.cycle_history[state.cycle_history.length - 1].plan_version
        : 1;
    const planPath = getPlanPath(this.options.project, latestPlanVersion);

    // Run code review
    let reviewResult = await this.codex.reviewCode(
      state.feature,
      planPath,
      changedFilesPath,
      diffPath,
    );

    let reviewRound = 0;
    const issueCounts = new Map<string, number>();

    // If Codex errored, log clearly and proceed without code review
    if (reviewResult.verdict === "ERROR") {
      this.logger.error(
        `Codex code review FAILED: ${reviewResult.raw_output}. Proceeding without code review.`,
      );
    }

    // If Codex is rate-limited, pause the orchestrator
    if (reviewResult.verdict === "RATE_LIMITED") {
      await this.handleCodexRateLimit();
      return false;
    }

    while (
      reviewResult.verdict !== "APPROVE" &&
      reviewResult.verdict !== "ERROR" &&
      reviewRound < MAX_CODE_REVIEW_ROUNDS
    ) {
      reviewRound++;
      this.logger.info(
        `Code review round ${reviewRound}: verdict=${reviewResult.verdict}, ` +
        `${reviewResult.issues.length} issue(s)`,
      );

      // Track recurring issues
      for (const issue of reviewResult.issues) {
        const issueKey = issue.substring(0, 80);
        const count = (issueCounts.get(issueKey) ?? 0) + 1;
        issueCounts.set(issueKey, count);

        if (count >= MAX_DISAGREEMENT_ROUNDS) {
          this.logger.warn(`Persistent code review disagreement: ${issueKey}`);
          const escalation = await this.escalateToUser(
            "Code review disagreement",
            `Codex repeatedly flagged: ${issue}\n\nVerdict: ${reviewResult.verdict}\n\nFull output:\n${reviewResult.raw_output}`,
          );

          if (escalation === "stop") {
            return false;
          }
          issueCounts.set(issueKey, 0);
        }
      }

      // Spawn reviewer SDK query to investigate and fix issues
      const responsePath = path.join(
        reviewsDir,
        `code-review-response-round-${reviewRound}.md`,
      );

      const reviewerPrompt = [
        "You are responding to a code review from Codex (OpenAI).",
        "Review the feedback, investigate the issues in the codebase, and fix them.",
        "",
        "## Codex Code Review Feedback",
        "",
        reviewResult.raw_output,
        "",
        "## Changed Files",
        "",
        changedFiles.join("\n"),
        "",
        "## Instructions",
        "",
        "1. Read each file mentioned in the review.",
        "2. For each issue, either fix the code or explain why it's correct.",
        "3. Run any relevant tests after making fixes.",
        "4. Provide a summary of what you fixed and what you left unchanged.",
      ].join("\n");

      let responseText = "";
      const asyncIterable = query({
        prompt: reviewerPrompt,
        options: {
          allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          cwd: this.options.project,
          maxTurns: 30,
        },
      });

      for await (const event of asyncIterable) {
        if (event.type === "result" && "result" in event) {
          responseText =
            typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result);
        }
      }

      await fs.writeFile(responsePath, responseText, "utf-8");

      // Re-review
      reviewResult = await this.codex.reReviewCode(responsePath, changedFilesPath);

      // Check for rate limit after re-review
      if (reviewResult.verdict === "RATE_LIMITED") {
        await this.handleCodexRateLimit();
        return false;
      }
    }

    // Persist metrics after code review
    await this.state.updateCodexMetrics(this.codex.getMetrics());

    const approved = reviewResult.verdict === "APPROVE";
    if (approved) {
      this.logger.info("Codex APPROVED the code changes.");
    } else if (reviewResult.verdict === "ERROR") {
      this.logger.error(
        "Codex code review errored out. Code was NOT reviewed by Codex.",
      );
    } else {
      this.logger.warn(
        `Code review ended without approval (verdict: ${reviewResult.verdict}). Proceeding anyway.`,
      );
    }

    return approved;
  }

  // ================================================================
  // Phase 3.5: Flow-Tracing Review
  // ================================================================

  /**
   * Run flow-tracing review workers that trace user journeys end-to-end
   * across all code layers. Workers are read-only and organized by user
   * flow (not code area), checking every relevant actor type against
   * each layer boundary.
   *
   * This catches issues that area-based reviews miss:
   * - Access policies that block operations area-reviewers assumed would work
   * - Cross-boundary mismatches (API assumes access, DB denies)
   * - Edge cases in actor type transitions (e.g., role changes mid-session)
   */
  private async flowReview(cycle: number): Promise<FlowTracingReport | null> {
    if (this.options.skipFlowReview) {
      this.logger.info("Flow-tracing review skipped (--skip-flow-review).");
      return null;
    }

    await this.state.setStatus("flow_tracing");
    this.logger.info("Flow-tracing review phase: tracing user flows across layers...");

    // Get changed files and diff from base branch
    let diff: string;
    let changedFiles: string[];
    try {
      diff = await this.git.getDiff(this.baseBranch);
      changedFiles = await this.git.getChangedFiles(this.baseBranch);
    } catch (err) {
      this.logger.warn(
        `Could not get git diff for flow-tracing: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    if (!diff || diff.trim().length === 0) {
      this.logger.info("No code changes to flow-trace.");
      return null;
    }

    try {
      const report = await this.flowTracer.trace(changedFiles, diff, cycle);

      // Log summary
      if (report.summary.total > 0) {
        this.logger.info(
          `Flow-tracing found ${report.summary.total} issue(s): ` +
          `${report.summary.critical} critical, ${report.summary.high} high, ` +
          `${report.summary.medium} medium, ${report.summary.low} low ` +
          `(${report.summary.cross_boundary_count} cross-boundary)`,
        );
      } else {
        this.logger.info("Flow-tracing: no issues found.");
      }

      return report;
    } catch (err) {
      this.logger.error(
        `Flow-tracing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // ================================================================
  // Phase 4: Checkpoint
  // ================================================================

  private async checkpoint(): Promise<"continue" | "complete" | "escalate" | "pause"> {
    await this.state.setStatus("checkpointing");
    this.logger.info("Checkpoint phase...");

    const state = this.state.get();

    // Git checkpoint
    try {
      const cycleNum = state.current_cycle + 1;
      await this.git.checkpoint(`cycle-${cycleNum}`);
      this.logger.info(`Git checkpoint: cycle-${cycleNum}`);
    } catch (err) {
      this.logger.warn(
        `Git checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Count completed vs remaining tasks
    const allTasks = await this.state.getAllTasks();
    const completed = allTasks.filter((t) => t.status === "completed");
    const failed = allTasks.filter((t) => t.status === "failed");
    const pending = allTasks.filter((t) => t.status === "pending");
    const inProgress = allTasks.filter((t) => t.status === "in_progress");
    const remaining = pending.length + inProgress.length;

    this.logger.info(
      `Checkpoint summary: ${completed.length} completed, ${failed.length} failed, ` +
      `${remaining} remaining (${pending.length} pending, ${inProgress.length} in progress)`,
    );

    // All tasks done
    if (remaining === 0 && failed.length === 0) {
      return "complete";
    }

    // User-requested pause
    if (this.userPauseRequested) {
      return "pause";
    }

    // Usage wind-down needed
    if (this.usage.isWindDownNeeded() || this.usageCritical) {
      return "pause";
    }

    // Cycle limit reached
    if (state.current_cycle + 1 >= state.max_cycles) {
      return "escalate";
    }

    // Failed tasks but room for more cycles
    if (failed.length > 0 || remaining > 0) {
      return "continue";
    }

    return "complete";
  }

  // ================================================================
  // Phase 5: Completion
  // ================================================================

  private async complete(): Promise<void> {
    await this.state.setStatus("completed");
    this.logger.info("Orchestration complete!");

    // Final git commit
    try {
      await this.git.commit("[orchestrator] Orchestration complete");
    } catch {
      // May fail if no changes to commit
    }

    const state = this.state.get();
    const allTasks = await this.state.getAllTasks();
    const completed = allTasks.filter((t) => t.status === "completed");
    const failed = allTasks.filter((t) => t.status === "failed");

    console.log("\n" + chalk.bold.green("=".repeat(60)));
    console.log(chalk.bold.green("  ORCHESTRATION COMPLETE"));
    console.log(chalk.bold.green("=".repeat(60)));
    console.log("");
    console.log(chalk.white(`  Feature:    ${state.feature}`));
    console.log(chalk.white(`  Branch:     ${state.branch}`));
    console.log(chalk.white(`  Cycles:     ${state.cycle_history.length}`));
    console.log(chalk.green(`  Completed:  ${completed.length} task(s)`));
    if (failed.length > 0) {
      console.log(chalk.red(`  Failed:     ${failed.length} task(s)`));
    }

    // Flow-tracing summary across all cycles
    const flowTracingCycles = state.cycle_history.filter((c) => c.flow_tracing);
    if (flowTracingCycles.length > 0) {
      const totalFlowFindings = flowTracingCycles.reduce(
        (sum, c) => sum + (c.flow_tracing?.total_findings ?? 0), 0,
      );
      const totalCritical = flowTracingCycles.reduce(
        (sum, c) => sum + (c.flow_tracing?.critical_findings ?? 0), 0,
      );
      const totalHigh = flowTracingCycles.reduce(
        (sum, c) => sum + (c.flow_tracing?.high_findings ?? 0), 0,
      );
      console.log(chalk.bold("  Flow-Tracing:"));
      console.log(chalk.white(`    Findings:   ${totalFlowFindings}`));
      if (totalCritical > 0) {
        console.log(chalk.red(`    Critical:   ${totalCritical}`));
      }
      if (totalHigh > 0) {
        console.log(chalk.yellow(`    High:       ${totalHigh}`));
      }
    }

    const totalMs = state.cycle_history.reduce((sum, c) => sum + c.duration_ms, 0);
    const totalMin = Math.round(totalMs / 60_000);
    console.log(chalk.white(`  Duration:   ${totalMin} minute(s)`));
    console.log("");
    console.log(chalk.gray(`  State:  ${getOrchestratorDir(this.options.project)}/state.json`));
    console.log(chalk.gray(`  Logs:   ${getLogsDir(this.options.project)}/orchestrator.log`));
    console.log(chalk.bold.green("=".repeat(60)) + "\n");
  }

  // ================================================================
  // Handle usage pause/resume
  // ================================================================

  /**
   * Handle Codex rate limit: persist metrics, pause with 5-hour resume time, exit cleanly.
   */
  private async handleCodexRateLimit(): Promise<void> {
    await this.state.updateCodexMetrics(this.codex.getMetrics());

    const resumeAfter = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    await this.state.pause(resumeAfter);

    this.logger.warn(
      `Codex appears rate-limited. Orchestrator paused until ${resumeAfter}. ` +
      `Resume with: orchestrate resume`,
    );

    console.log(
      chalk.yellow(
        `\n  Codex rate limit detected. Paused until ${resumeAfter}.\n` +
        `  Resume with: orchestrate resume --project "${this.options.project}"\n`,
      ),
    );
  }

  private async handleUsagePause(): Promise<void> {
    // User-requested pause: just pause and exit (don't wait for anything)
    if (this.userPauseRequested) {
      this.userPauseRequested = false;

      this.logger.info("Pausing orchestration (user requested).");
      await this.state.pause("user-requested");

      console.log("\n" + chalk.yellow.bold("=".repeat(60)));
      console.log(chalk.yellow.bold("  ORCHESTRATION PAUSED"));
      console.log(chalk.yellow.bold("=".repeat(60)));
      console.log("");
      console.log(chalk.yellow(`  Reason:     User requested`));
      console.log(chalk.yellow(`  Resume:     Run 'orchestrate resume' when ready`));
      console.log(chalk.yellow.bold("=".repeat(60)) + "\n");

      // In non-interactive mode, write escalation so the slash command
      // can inform the user and handle resume later.
      if (this.isNonInteractive) {
        const escalation = {
          reason: "User requested pause",
          details: "The orchestrator was paused at your request. Run 'orchestrate resume' when you're ready to continue.",
          timestamp: new Date().toISOString(),
          options: ["resume", "stop"],
        };
        const escalationPath = getEscalationPath(this.options.project);
        await fs.writeFile(
          escalationPath,
          JSON.stringify(escalation, null, 2) + "\n",
          "utf-8",
        );
        process.exit(2);
      }

      // Interactive mode: just return and let the process exit naturally
      // The user will resume with `orchestrate resume`
      return;
    }

    // Usage-triggered pause: wait for the usage window to reset
    const resetTime = this.usage.getResetTime() ?? new Date(Date.now() + 5 * 60 * 60_000).toISOString();

    this.logger.info(`Pausing orchestration. Usage will reset at: ${resetTime}`);
    await this.state.pause(resetTime);

    console.log("\n" + chalk.yellow.bold("=".repeat(60)));
    console.log(chalk.yellow.bold("  ORCHESTRATION PAUSED"));
    console.log(chalk.yellow.bold("=".repeat(60)));
    console.log("");
    console.log(chalk.yellow(`  Reason:     Usage limit reached`));
    console.log(chalk.yellow(`  Resets at:  ${resetTime}`));
    console.log(chalk.yellow(`  Resume:     Run 'orchestrate resume' after reset`));
    console.log(chalk.yellow.bold("=".repeat(60)) + "\n");

    // Wait for usage to reset
    this.logger.info("Waiting for usage window to reset...");
    await this.usage.waitForReset();

    // Resume
    this.logger.info("Usage reset. Resuming orchestration.");
    await this.state.resume();
  }

  // ================================================================
  // Handle escalation to user
  // ================================================================

  private get isNonInteractive(): boolean {
    return this.options.contextFile !== null;
  }

  private async escalateToUser(
    reason: string,
    details: string,
  ): Promise<"continue" | "redirect" | "stop"> {
    await this.state.setStatus("escalated");

    // Non-interactive mode: write escalation file and exit process.
    // The calling process (Claude Code slash command) will read this
    // file, handle the escalation with the user, and relaunch.
    if (this.isNonInteractive) {
      const escalation = {
        reason,
        details,
        timestamp: new Date().toISOString(),
        options: ["continue", "redirect", "stop"],
      };

      const escalationPath = getEscalationPath(this.options.project);
      await fs.writeFile(
        escalationPath,
        JSON.stringify(escalation, null, 2) + "\n",
        "utf-8",
      );

      this.logger.info(`Escalation written to ${escalationPath} — exiting for external handler`);

      // Exit with code 2 to signal "escalation needed" to the caller
      process.exit(2);
    }

    // Interactive mode: prompt via stdin
    console.log("\n" + chalk.red.bold("=".repeat(60)));
    console.log(chalk.red.bold("  ESCALATION REQUIRED"));
    console.log(chalk.red.bold("=".repeat(60)));
    console.log("");
    console.log(chalk.white(`  Reason: ${reason}`));
    console.log("");
    console.log(chalk.gray(details));
    console.log("");

    const choice = await this.promptUser("How would you like to proceed?", [
      "Continue with next cycle",
      "Provide new guidance (redirect)",
      "Stop orchestration",
    ]);

    if (choice === 0) {
      this.logger.info("User chose to continue.");
      return "continue";
    }

    if (choice === 1) {
      // Ask for new guidance
      const rl = readline.createInterface({ input, output });
      try {
        const guidance = await rl.question(
          chalk.cyan("\nEnter your new guidance/instructions:\n> "),
        );
        this.redirectGuidance = guidance;
        this.logger.info(`User provided redirect guidance: ${guidance}`);
      } finally {
        rl.close();
      }
      return "redirect";
    }

    this.logger.info("User chose to stop.");
    return "stop";
  }

  // ================================================================
  // Helper: prompt user
  // ================================================================

  private async promptUser(question: string, options: string[]): Promise<number> {
    const rl = readline.createInterface({ input, output });

    try {
      console.log(chalk.bold.cyan(`\n${question}\n`));

      for (let i = 0; i < options.length; i++) {
        console.log(chalk.white(`  ${i + 1}. ${options[i]}`));
      }

      while (true) {
        const answer = await rl.question(chalk.cyan("\nYour choice (number): "));
        const num = parseInt(answer.trim(), 10);

        if (!isNaN(num) && num >= 1 && num <= options.length) {
          return num - 1;
        }

        console.log(chalk.yellow(`Please enter a number between 1 and ${options.length}.`));
      }
    } finally {
      rl.close();
    }
  }

  // ================================================================
  // Pause signal detection
  // ================================================================

  /**
   * Check if a pause signal file exists, indicating the user wants
   * to pause the orchestrator. If found, removes the signal file
   * and returns true.
   */
  private async checkPauseSignal(): Promise<boolean> {
    const signalPath = getPauseSignalPath(this.options.project);
    try {
      await fs.access(signalPath);
      // Signal file exists — remove it and return true
      await fs.unlink(signalPath);
      this.logger.info(`Pause signal detected and consumed: ${signalPath}`);
      return true;
    } catch {
      // File doesn't exist — no pause requested
      return false;
    }
  }

  // ================================================================
  // Threat model formatting
  // ================================================================

  private formatThreatModelForWorkers(tm: ThreatModel): string {
    const lines = [
      `Feature: ${tm.feature_summary}`,
      "",
      "Attack Surfaces and Required Mitigations:",
    ];
    for (const surface of tm.attack_surfaces) {
      lines.push(`- ${surface.surface} (${surface.threat_category}): ${surface.mitigation}`);
    }
    if (tm.unmapped_mitigations.length > 0) {
      lines.push("", "Unaddressed mitigations (MUST be resolved):");
      for (const m of tm.unmapped_mitigations) {
        lines.push(`- ${m}`);
      }
    }
    return lines.join("\n");
  }

  // ================================================================
  // Create fix tasks from flow-tracing findings
  // ================================================================

  private async createFixTasksFromFindings(report: FlowTracingReport): Promise<void> {
    const criticalAndHigh = report.findings.filter(
      (f) => f.severity === "critical" || f.severity === "high",
    );

    // Determine next task ID offset
    const allTasks = await this.state.getAllTasks();
    let nextTaskNum = allTasks.length + 1;

    const subjectToId = new Map<string, string>();

    for (const finding of criticalAndHigh) {
      const taskId = `task-${String(nextTaskNum).padStart(3, "0")}`;
      nextTaskNum++;

      const taskDef: TaskDefinition = {
        subject: `Fix: ${finding.title}`,
        description: [
          `## Flow-Tracing Finding (${finding.severity})`,
          "",
          finding.description,
          "",
          `**File:** ${finding.file_path}${finding.line_number ? `:${finding.line_number}` : ""}`,
          `**Flow:** ${finding.flow_id}`,
          `**Actor:** ${finding.actor}`,
          finding.edge_case ? `**Edge Case:** ${finding.edge_case}` : "",
          "",
          "Fix this issue and verify the fix resolves the finding.",
        ].filter(Boolean).join("\n"),
        depends_on_subjects: [],
        estimated_complexity: finding.severity === "critical" ? "medium" : "small",
        task_type: "security",
        security_requirements: [finding.description],
        acceptance_criteria: [`The ${finding.severity} finding "${finding.title}" is resolved`],
      };

      await this.state.createTask(taskDef, taskId, []);
      this.logger.debug(`Created fix task ${taskId}: ${taskDef.subject}`);
    }

    if (criticalAndHigh.length > 0) {
      this.logger.info(`Created ${criticalAndHigh.length} fix task(s) from flow-tracing findings.`);
    }
  }

  // ================================================================
  // Build cycle feedback for replanning
  // ================================================================

  private buildCycleFeedback(
    codexFeedback: string | null,
    flowReport: FlowTracingReport | null,
    unresolvedIssues: KnownIssue[],
  ): string {
    const sections: string[] = [];

    if (codexFeedback) {
      sections.push("## Codex Review Feedback\n\n" + codexFeedback);
    }

    if (flowReport && flowReport.findings.length > 0) {
      const findingLines = flowReport.findings.map(
        (f) =>
          `- [${f.severity.toUpperCase()}] ${f.title}: ${f.description} (${f.file_path}${f.line_number ? `:${f.line_number}` : ""})`,
      );
      sections.push(
        "## Flow-Tracing Findings\n\n" + findingLines.join("\n"),
      );
    }

    if (unresolvedIssues.length > 0) {
      const issueLines = unresolvedIssues.map(
        (i) =>
          `- [${i.severity.toUpperCase()}] ${i.description}${i.file_path ? ` (${i.file_path})` : ""} [source: ${i.source}, cycle ${i.found_in_cycle}]`,
      );
      sections.push(
        "## Unresolved Known Issues\n\n" + issueLines.join("\n"),
      );
    }

    return sections.length > 0
      ? sections.join("\n\n")
      : "";
  }

  // ================================================================
  // Private helpers
  // ================================================================

  private printBanner(): void {
    console.log("");
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log(chalk.bold.cyan("  HIERARCHICAL AGENT ORCHESTRATOR"));
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log("");
    console.log(chalk.white(`  Feature:      ${this.options.feature}`));
    console.log(chalk.white(`  Project:      ${this.options.project}`));
    console.log(chalk.white(`  Concurrency:  ${this.options.concurrency} worker(s)`));
    console.log(chalk.white(`  Max Cycles:   ${this.options.maxCycles}`));
    console.log(chalk.white(`  Usage Limit:  ${(this.options.usageThreshold * 100).toFixed(0)}%`));
    console.log(chalk.white(`  Skip Codex:   ${this.options.skipCodex ? "Yes" : "No"}`));
    console.log(chalk.white(`  Dry Run:      ${this.options.dryRun ? "Yes" : "No"}`));
    console.log("");
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log("");
  }

  private printProgress(
    completed: number,
    failed: number,
    remaining: number,
    activeWorkers: number,
  ): void {
    const total = completed + failed + remaining;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const bar = this.buildProgressBar(pct);

    console.log(
      chalk.gray(`  [${new Date().toLocaleTimeString()}] `) +
      chalk.white(`Progress: ${bar} ${pct}% `) +
      chalk.green(`${completed} done `) +
      chalk.red(`${failed} failed `) +
      chalk.yellow(`${remaining} remaining `) +
      chalk.cyan(`(${activeWorkers} worker(s) active)`),
    );
  }

  private buildProgressBar(percent: number): string {
    const width = 20;
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return chalk.green("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(empty));
  }
}
