import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { PlannerOutput, TaskDefinition, Task } from "../utils/types.js";
import { getPlanPath } from "../utils/constants.js";
import type { Logger } from "../utils/logger.js";

// ============================================================
// Planner
// ============================================================

/**
 * Uses the Claude Agent SDK to analyze a codebase and create
 * detailed implementation plans broken into parallelizable tasks.
 */
export class Planner {
  constructor(
    private projectDir: string,
    private logger: Logger,
  ) {}

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Ask exhaustive clarifying questions about a feature.
   *
   * This is INTERACTIVE: it prints questions to stdout, reads answers
   * from stdin, and returns the combined Q&A as a context string.
   */
  async askQuestions(feature: string): Promise<string> {
    this.logger.info("Generating clarifying questions about the feature...");

    const questionPrompt = [
      "You are helping plan a large feature implementation.",
      `Ask exhaustive clarifying questions about: ${feature}`,
      "",
      "Ask about edge cases, user flows, error handling, data models,",
      "integrations, UI/UX, testing strategy, performance considerations,",
      "security implications, backwards compatibility, deployment strategy, etc.",
      "",
      "Ask at least 10 questions. Format each question with a number.",
      "Look at the codebase first to understand the existing architecture",
      "so your questions are informed and specific.",
    ].join("\n");

    // Spawn an SDK session with read-only tools so the LLM
    // can inspect the codebase to inform its questions.
    let questionsText = "";

    const asyncIterable = query({
      prompt: questionPrompt,
      options: {
        allowedTools: ["Read", "Glob", "Grep"],
        cwd: this.projectDir,
        maxTurns: 20,
      },
    });

    for await (const event of asyncIterable) {
      if (event.type === "result" && event.subtype === "success") {
        questionsText = typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result);
      }
    }

    if (!questionsText) {
      this.logger.warn("No questions were generated; using fallback.");
      questionsText = "1. Could you describe the feature in more detail?";
    }

    // Print the questions to stdout
    console.log("\n========================================");
    console.log("  CLARIFYING QUESTIONS");
    console.log("========================================\n");
    console.log(questionsText);
    console.log("\n========================================");
    console.log("  Please answer each question below.");
    console.log("  Type your answer after each prompt.");
    console.log("========================================\n");

    // Parse numbered questions from the output
    const questionLines = questionsText.split("\n").filter((line) =>
      /^\s*\d+[\.\)]\s+/.test(line),
    );

    const rl = readline.createInterface({ input, output });
    const qaEntries: string[] = [];

    try {
      for (const questionLine of questionLines) {
        const trimmed = questionLine.trim();
        console.log(`\n${trimmed}`);

        const answer = await rl.question("Your answer: ");
        qaEntries.push(`Q: ${trimmed}\nA: ${answer}`);
      }

      // If we couldn't parse individual questions, ask for a single block answer
      if (qaEntries.length === 0) {
        console.log(
          "\n(Could not parse individual questions. Please provide your answers below.)\n",
        );
        console.log(questionsText);
        const answer = await rl.question("\nYour answers: ");
        qaEntries.push(`Questions:\n${questionsText}\n\nAnswers:\n${answer}`);
      }
    } finally {
      rl.close();
    }

    const qaContext = qaEntries.join("\n\n");

    this.logger.info(`Collected ${qaEntries.length} Q&A pair(s).`);

    return qaContext;
  }

  /**
   * Analyze the codebase and create a detailed implementation plan.
   *
   * Spawns an SDK session that can read the codebase, then produces
   * a plan markdown file and parsed task definitions.
   */
  async createPlan(
    feature: string,
    qaContext: string,
    planVersion: number,
  ): Promise<PlannerOutput> {
    this.logger.info(`Creating implementation plan v${planVersion}...`);

    const planPrompt = this.buildCreatePlanPrompt(feature, qaContext);

    let planOutput = "";

    const asyncIterable = query({
      prompt: planPrompt,
      options: {
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        cwd: this.projectDir,
        maxTurns: 80,
      },
    });

    for await (const event of asyncIterable) {
      this.logger.debug(`Planner event: type=${event.type} subtype=${"subtype" in event ? event.subtype : "N/A"}`);
      if (event.type === "result" && event.subtype === "success") {
        const rawResult = event.result;
        this.logger.info(`Planner success: result type=${typeof rawResult}, truthy=${!!rawResult}, length=${typeof rawResult === "string" ? rawResult.length : JSON.stringify(rawResult).length}`);
        planOutput = typeof rawResult === "string"
          ? rawResult
          : JSON.stringify(rawResult);
      } else if (event.type === "result") {
        // For max_turns errors, try to salvage output if present
        if (event.subtype === "error_max_turns" && "result" in event && event.result) {
          const partialResult = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
          if (partialResult && partialResult.length > 100) {
            this.logger.warn(`Planner hit max turns but produced output (${partialResult.length} chars). Attempting to use it.`);
            planOutput = partialResult;
          } else {
            this.logger.error(`Planner hit max turns with insufficient output. Increase maxTurns.`);
            throw new Error(`Planner SDK session hit max turns without producing a plan`);
          }
        } else {
          const errorMsg = "result" in event ? String(event.result) : "unknown error";
          this.logger.error(`Planner SDK error event (subtype=${event.subtype}): ${errorMsg}`);
          throw new Error(`Planner SDK session errored (${event.subtype}): ${errorMsg}`);
        }
      }
    }

    this.logger.info(`Planner finished. planOutput truthy=${!!planOutput}, length=${planOutput.length}`);
    if (!planOutput) {
      throw new Error("Planner SDK session returned no output (no success event received)");
    }

    // Parse the JSON task definitions block from the output
    const tasks = this.parseTaskDefinitions(planOutput);

    // Write the plan markdown to disk
    const planPath = getPlanPath(this.projectDir, planVersion);
    await fs.writeFile(planPath, planOutput, "utf-8");
    this.logger.info(`Plan written to ${planPath} (${tasks.length} task(s))`);

    return {
      plan_markdown: planOutput,
      tasks,
    };
  }

  /**
   * Replan after a checkpoint cycle.
   *
   * Looks at what tasks are completed, what failed, and any Codex
   * feedback, then produces an updated plan covering only remaining work.
   */
  async replan(
    feature: string,
    previousPlanPath: string,
    completedTasks: Task[],
    failedTasks: Task[],
    codexFeedback: string | null,
    planVersion: number,
  ): Promise<PlannerOutput> {
    this.logger.info(
      `Replanning (v${planVersion}) — ${completedTasks.length} completed, ${failedTasks.length} failed`,
    );

    let previousPlan: string;
    try {
      previousPlan = await fs.readFile(previousPlanPath, "utf-8");
    } catch {
      previousPlan = "(Previous plan could not be loaded)";
    }

    const replanPrompt = this.buildReplanPrompt(
      feature,
      previousPlan,
      completedTasks,
      failedTasks,
      codexFeedback,
    );

    let planOutput = "";

    const asyncIterable = query({
      prompt: replanPrompt,
      options: {
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        cwd: this.projectDir,
        maxTurns: 80,
      },
    });

    for await (const event of asyncIterable) {
      this.logger.debug(`Replanner event: type=${event.type} subtype=${"subtype" in event ? event.subtype : "N/A"}`);
      if (event.type === "result" && event.subtype === "success") {
        planOutput = typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result);
      } else if (event.type === "result") {
        if (event.subtype === "error_max_turns" && "result" in event && event.result) {
          const partialResult = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
          if (partialResult && partialResult.length > 100) {
            this.logger.warn(`Replanner hit max turns but produced output (${partialResult.length} chars). Attempting to use it.`);
            planOutput = partialResult;
          } else {
            this.logger.error(`Replanner hit max turns with insufficient output.`);
            throw new Error(`Replanner SDK session hit max turns without producing a plan`);
          }
        } else {
          const errorMsg = "result" in event ? String(event.result) : "unknown error";
          this.logger.error(`Replanner SDK error event (subtype=${event.subtype}): ${errorMsg}`);
          throw new Error(`Replanner SDK session errored (${event.subtype}): ${errorMsg}`);
        }
      }
    }

    if (!planOutput) {
      throw new Error("Replanner SDK session returned no output (no success event received)");
    }

    const tasks = this.parseTaskDefinitions(planOutput);

    const planPath = getPlanPath(this.projectDir, planVersion);
    await fs.writeFile(planPath, planOutput, "utf-8");
    this.logger.info(`Replan written to ${planPath} (${tasks.length} task(s))`);

    return {
      plan_markdown: planOutput,
      tasks,
    };
  }

  // ----------------------------------------------------------------
  // Private: Prompt builders
  // ----------------------------------------------------------------

  private buildCreatePlanPrompt(feature: string, qaContext: string): string {
    return [
      "You are a senior software architect planning a large feature implementation.",
      "Your job is to analyze the codebase and create a detailed, actionable plan.",
      "",
      "## Feature Description",
      "",
      feature,
      "",
      "## Q&A Context (from the user)",
      "",
      qaContext,
      "",
      "## Instructions",
      "",
      "1. Thoroughly explore the codebase using the available tools (Read, Glob, Grep, Bash).",
      "   Understand the project structure, existing patterns, frameworks, and conventions.",
      "",
      "2. Create a detailed implementation plan in Markdown with numbered steps.",
      "   Each step should be a discrete, parallelizable unit of work that one developer",
      "   (or one AI agent) can complete independently.",
      "",
      "3. For each step, describe:",
      "   - What files to create or modify",
      "   - What the implementation should do",
      "   - Key design decisions and rationale",
      "   - Dependencies on other steps (if any)",
      "   - Testing approach for that step",
      "",
      "4. Consider:",
      "   - Correct dependency ordering (what must be done first)",
      "   - Maximizing parallelism (independent tasks that can run concurrently)",
      "   - Small, focused tasks rather than monolithic ones",
      "   - Error handling and edge cases",
      "   - Testing strategy",
      "",
      "5. At the END of your plan, output a JSON block with the task definitions.",
      "   This block MUST be fenced with triple backticks and the 'json' language tag.",
      "   Each task object must have these fields:",
      "",
      "```",
      "[",
      "  {",
      '    "subject": "Short title for the task",',
      '    "description": "Detailed description of what to implement...",',
      '    "depends_on_subjects": ["Subject of dependency 1", "Subject of dependency 2"],',
      '    "estimated_complexity": "small|medium|large"',
      "  }",
      "]",
      "```",
      "",
      "   - `subject`: A concise, unique title (used to reference the task).",
      "   - `description`: Enough detail for an autonomous agent to implement it.",
      "   - `depends_on_subjects`: Array of subject strings from other tasks that must",
      "     be completed before this one can start. Use an empty array if no dependencies.",
      "   - `estimated_complexity`: 'small' (~30 min), 'medium' (~1-2 hours), 'large' (~3+ hours).",
      "",
      "Make sure the JSON block is valid JSON and appears at the very end of your output.",
      "",
      "CRITICAL: You MUST include the JSON task definitions block at the end of your output.",
      "Without this JSON block, the orchestrator cannot create tasks and the entire plan will be",
      "rejected. The JSON block is the most important part of your output.",
      "If you are running low on turns, prioritize outputting the JSON task definitions over",
      "further exploration. The plan markdown + JSON block is what matters.",
    ].join("\n");
  }

  private buildReplanPrompt(
    feature: string,
    previousPlan: string,
    completedTasks: Task[],
    failedTasks: Task[],
    codexFeedback: string | null,
  ): string {
    const completedSummary =
      completedTasks.length > 0
        ? completedTasks
            .map(
              (t) =>
                `- [COMPLETED] ${t.subject}: ${t.result_summary ?? "(no summary)"}\n` +
                `  Files changed: ${t.files_changed.join(", ") || "(none)"}`,
            )
            .join("\n")
        : "(none)";

    const failedSummary =
      failedTasks.length > 0
        ? failedTasks
            .map(
              (t) =>
                `- [FAILED] ${t.subject}: ${t.result_summary ?? "(no error details)"}`,
            )
            .join("\n")
        : "(none)";

    const feedbackSection = codexFeedback
      ? ["## Codex Review Feedback", "", codexFeedback, ""].join("\n")
      : "";

    return [
      "You are a senior software architect replanning after a checkpoint.",
      "A previous cycle of work has been completed. Some tasks succeeded, some failed.",
      "You need to create an UPDATED plan that covers only the REMAINING work.",
      "",
      "## Feature Description",
      "",
      feature,
      "",
      "## Previous Plan",
      "",
      previousPlan,
      "",
      "## Completed Tasks",
      "",
      completedSummary,
      "",
      "## Failed Tasks",
      "",
      failedSummary,
      "",
      feedbackSection,
      "## Instructions",
      "",
      "1. Explore the codebase to see the current state of the implementation.",
      "   Look at what was actually built (not just what was planned).",
      "",
      "2. DO NOT re-plan completed work. Only plan remaining tasks.",
      "",
      "3. For failed tasks, analyze what went wrong and create corrected task",
      "   definitions that address the failures.",
      "",
      "4. If Codex review feedback is provided, incorporate those suggestions",
      "   into the updated plan.",
      "",
      "5. Create an updated Markdown plan and a JSON task block at the end,",
      "   following the same format as the original plan:",
      "",
      "```",
      "[",
      "  {",
      '    "subject": "Short title for the task",',
      '    "description": "Detailed description of what to implement...",',
      '    "depends_on_subjects": ["Subject of dependency 1"],',
      '    "estimated_complexity": "small|medium|large"',
      "  }",
      "]",
      "```",
      "",
      "Only include tasks that still need to be done. Do not include",
      "tasks that were already completed successfully.",
    ].join("\n");
  }

  // ----------------------------------------------------------------
  // Private: Parse task definitions from plan output
  // ----------------------------------------------------------------

  /**
   * Extract the JSON task definitions block from the plan output.
   *
   * Looks for the last fenced code block tagged with `json` and
   * attempts to parse it as TaskDefinition[].
   */
  private parseTaskDefinitions(planOutput: string): TaskDefinition[] {
    // Find all ```json ... ``` blocks
    const jsonBlockRegex = /```json\s*\n([\s\S]*?)```/g;
    const matches: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = jsonBlockRegex.exec(planOutput)) !== null) {
      matches.push(match[1].trim());
    }

    if (matches.length === 0) {
      this.logger.warn("No JSON task definition block found in plan output");
      return [];
    }

    // Take the last JSON block (the spec says it appears at the end)
    const lastBlock = matches[matches.length - 1];

    try {
      const parsed = JSON.parse(lastBlock) as unknown;

      if (!Array.isArray(parsed)) {
        this.logger.warn("JSON task block is not an array; wrapping in array");
        const single = this.validateTaskDefinition(parsed);
        return single ? [single] : [];
      }

      const tasks: TaskDefinition[] = [];
      for (const item of parsed) {
        const validated = this.validateTaskDefinition(item);
        if (validated) {
          tasks.push(validated);
        }
      }

      return tasks;
    } catch (err) {
      this.logger.error(
        `Failed to parse JSON task block: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Validate and normalize a single task definition object.
   * Returns null if the object is not a valid TaskDefinition.
   */
  private validateTaskDefinition(obj: unknown): TaskDefinition | null {
    if (!obj || typeof obj !== "object") {
      this.logger.warn("Invalid task definition: not an object");
      return null;
    }

    const record = obj as Record<string, unknown>;

    const subject = typeof record.subject === "string" ? record.subject : null;
    const description =
      typeof record.description === "string" ? record.description : null;

    if (!subject || !description) {
      this.logger.warn("Task definition missing 'subject' or 'description'");
      return null;
    }

    // depends_on_subjects should be string[]
    let dependsOnSubjects: string[] = [];
    if (Array.isArray(record.depends_on_subjects)) {
      dependsOnSubjects = record.depends_on_subjects.filter(
        (d): d is string => typeof d === "string",
      );
    }

    // estimated_complexity should be one of the valid values
    const validComplexities = ["small", "medium", "large"] as const;
    type Complexity = (typeof validComplexities)[number];
    let complexity: Complexity = "medium";
    if (
      typeof record.estimated_complexity === "string" &&
      (validComplexities as readonly string[]).includes(
        record.estimated_complexity,
      )
    ) {
      complexity = record.estimated_complexity as Complexity;
    }

    return {
      subject,
      description,
      depends_on_subjects: dependsOnSubjects,
      estimated_complexity: complexity,
    };
  }
}
