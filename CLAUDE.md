# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (src/ -> dist/)
npm run dev          # Watch mode compilation
npm test             # Run tests (vitest, no project tests yet)
npm link             # Install `conduct` CLI globally
npm run setup        # Install /conduct slash command to ~/.claude/commands/
```

No linter is configured. The project uses TypeScript strict mode (ES2022 target, Node16 modules).

## What This Project Does

Claude Code Conductor (C3) is a hierarchical multi-agent orchestration system that decomposes large features into parallel tasks and coordinates headless Claude Code worker sessions. It runs in cycles of: **plan -> conventions extraction -> execute (parallel workers + security sentinel) -> code review + flow-trace (parallel) -> checkpoint**.

Workers are full Claude Code sessions spawned via the Agent SDK. They coordinate through a custom MCP server with shared contracts, architectural decisions, and dependency context. All run state persists to `.conductor/` in the target project directory.

The system is designed to produce secure, performant code on the first pass through a security-first pipeline: STRIDE threat modeling during planning, a security constitution in every worker prompt, a real-time security sentinel during execution, semgrep static analysis, and checkpoint gating that forces additional cycles when critical issues are found.

## Architecture

### Conductor Loop (`src/core/orchestrator.ts`)
The central class that drives the lifecycle through phases: init -> plan -> conventions extraction -> execute -> review + flow-trace (parallel) -> checkpoint. Decides whether to start another cycle or escalate to the user. Gates checkpoints on review and flow-tracing results -- if critical/high findings exist, auto-generates fix tasks and forces another cycle. Tracks known issues across cycles and feeds them back into replanning.

### Planning System
- **Planner** (`src/core/planner.ts`) -- Decomposes features into typed tasks with dependencies, security requirements, performance requirements, and acceptance criteria. Generates STRIDE threat models before task decomposition. Identifies anchor tasks (shared foundations that must execute first). Asks security-focused clarifying questions (auth, authorization, data sensitivity, rate limiting, audit logging).
- **Task types**: `backend_api`, `frontend_ui`, `database`, `security`, `testing`, `infrastructure`, `general`. Each type gets specific worker guidance.
- **CodexReviewer** (`src/core/codex-reviewer.ts`) -- Calls external `codex` CLI for plan discussion (up to 5 rounds) and code review (up to 5 rounds).

### Worker System
- **WorkerManager** (`src/core/worker-manager.ts`) -- Spawns headless Claude Code sessions via `@anthropic-ai/claude-agent-sdk`. Injects shared context (Q&A, conventions, rules, threat model) into every worker prompt via `setWorkerContext()`. Also spawns a security sentinel worker.
- **Worker Prompt** (`src/worker-prompt.ts`) -- Builds comprehensive worker prompts with: security constitution (input validation, auth, authorization, output encoding, secrets), performance rules, definition of done checklist, project conventions, project-specific rules, threat model context, and task-type-specific guidelines. Accepts a `WorkerPromptContext` object.
- **Security Sentinel** -- A read-only worker that runs alongside execution workers, monitoring completed tasks in real-time and broadcasting security findings via MCP.
- **MCP Coordination Server** (`src/mcp/coordination-server.ts` + `src/mcp/tools.ts`) -- Workers coordinate through 11 MCP tools:
  - Task management: `get_tasks`, `claim_task`, `complete_task`
  - Messaging: `read_updates`, `post_update`, `get_session_status`
  - Cross-worker coordination: `register_contract`, `get_contracts`, `record_decision`, `get_decisions`
  - Testing: `run_tests`
  - `claim_task` returns rich context: dependency summaries, in-progress sibling tasks, all registered contracts and decisions.

### Flow Tracing & Performance
- **Flow Tracer** (`src/core/flow-tracer.ts`) -- Spawns read-only workers to trace user flows through code changes across all configured layers. Loads project-specific flow config from `.conductor/flow-config.json`. Runs in parallel with code review.
- **Flow Worker Prompt** (`src/flow-worker-prompt.ts`) -- Generates prompts from configurable layers, actor types, and edge cases.
- **Performance Worker Prompt** (`src/performance-worker-prompt.ts`) -- Traces flows for performance anti-patterns: N+1 queries, missing pagination, missing indexes, synchronous blocking, large payloads, missing caching, unbounded in-memory operations.

### Security & Quality Infrastructure
- **Conventions Extractor** (`src/utils/conventions-extractor.ts`) -- Spawns a read-only agent to analyze the project's codebase and extract patterns (auth, validation, error handling, tests, directory structure, naming, libraries, security invariants). Cached for 1 hour.
- **Rules Loader** (`src/utils/rules-loader.ts`) -- Loads `.conductor/rules.md` or `.conductor/worker-rules.md` for project-specific rules injected into worker prompts.
- **Semgrep Runner** (`src/utils/semgrep-runner.ts`) -- Runs semgrep static analysis on changed files. Supports configurable rule configs (defaults: `p/typescript`, `p/owasp-top-ten`, `p/cwe-top-25`). Gracefully degrades if semgrep is not installed.
- **Known Issues** (`src/utils/known-issues.ts`) -- Persistent issue registry across cycles. Deduplicates findings, tracks which cycle found/addressed each issue, and feeds unresolved issues back into replanning.

### State & Infrastructure
- **StateManager** (`src/core/state-manager.ts`) -- Persists `OrchestratorState` to `.conductor/state.json`. All tasks, sessions, messages, contracts, decisions, and reviews also persist under `.conductor/`.
- **UsageMonitor** (`src/core/usage-monitor.ts`) -- Polls Anthropic OAuth API to track 5-hour usage window. Auto-pauses at 80% utilization, resumes at 50%.
- **Flow Config** (`src/utils/flow-config.ts`) -- Loads per-project flow-tracing configuration from `.conductor/flow-config.json` with generic defaults.
- **Types** (`src/utils/types.ts`) -- All shared TypeScript types including `OrchestratorState`, `Task`, `TaskDefinition` (with `task_type`, `security_requirements`, `performance_requirements`, `acceptance_criteria`), `ThreatModel`, `ContractSpec`, `ArchitecturalDecision`, `ProjectConventions`, `KnownIssue`, `FlowConfig`, `SemgrepFinding`, `CompletionVerification`, etc.
- **Constants** (`src/utils/constants.ts`) -- Configuration defaults, file paths, tool allowlists, thresholds, semgrep configs, sentinel/extraction settings.

### Entry Points
- **CLI** (`src/cli.ts`) -- Commands: `start`, `status`, `resume`, `pause`, `log`. Uses Commander.js. CLI binary is `conduct`.
- **Slash Command** (`commands/conduct.md`) -- Interactive guide for invoking from within Claude Code. Installed to `~/.claude/commands/` by `src/setup.ts`.

## Key Design Decisions

- **Security-first pipeline**: Threat modeling during planning, security constitution in worker prompts, real-time sentinel during execution, semgrep + flow tracing during review, checkpoint gating on results. Every phase has a security angle.
- **Git branch isolation**: All changes go to `conduct/<feature-slug>` branches.
- **Worker tool allowlists**: Workers get `WORKER_ALLOWED_TOOLS` (constants.ts) including the 6 new coordination tools. Flow-tracing and sentinel workers are restricted to read-only tools.
- **Rich task definitions**: Tasks carry `task_type`, `security_requirements`, `performance_requirements`, `acceptance_criteria`, `risk_level`, and `review_feedback`. The planner generates all of these.
- **Cross-worker coordination**: Contracts (API schemas, type defs) and architectural decisions are shared through MCP tools. `claim_task` returns dependency context so workers know what predecessors produced.
- **Parallel review + flow tracing**: Code review and flow tracing run via `Promise.all()` since both are read-only operations.
- **Checkpoint gating**: If flow tracing finds critical/high issues or code review fails, the checkpoint auto-generates fix tasks and forces another cycle. The system does not ship known-bad code.
- **Known issues registry**: Findings from any source (Codex, flow tracing, semgrep, sentinel) persist across cycles and feed back into replanning.
- **Escalation model**: After `MAX_DISAGREEMENT_ROUNDS` (2) or `DEFAULT_MAX_CYCLES` (5), the conductor writes `escalation.json` and pauses for human guidance.
- **Default concurrency is 2** parallel workers (`DEFAULT_CONCURRENCY`), plus the security sentinel.
- **Configurable per-project**: `.conductor/rules.md` for worker rules, `.conductor/flow-config.json` for flow-tracing layers/actors/edge-cases.
