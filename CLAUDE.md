# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (src/ → dist/)
npm run dev          # Watch mode compilation
npm test             # Run tests (vitest, no project tests yet)
npm link             # Install `orchestrate` CLI globally
npm run setup        # Install /orchestrate slash command to ~/.claude/commands/
```

No linter is configured. The project uses TypeScript strict mode (ES2022 target, Node16 modules).

## What This Project Does

A hierarchical multi-agent orchestration system that decomposes large features into parallel tasks and coordinates headless Claude Code worker sessions. It runs in cycles of: **plan → execute (parallel workers) → code review (Codex) → flow-trace → checkpoint**.

Workers are full Claude Code sessions spawned via the Agent SDK. They coordinate through a custom MCP server (not file-based messaging). All run state persists to `.orchestrator/` in the target project directory.

## Architecture

### Orchestration Loop (`src/core/orchestrator.ts`)
The central class that drives the lifecycle through phases: init → plan → execute → review → flow-trace → checkpoint. Decides whether to start another cycle or escalate to the user.

### Worker System
- **WorkerManager** (`src/core/worker-manager.ts`) — Spawns headless Claude Code sessions via `@anthropic-ai/claude-agent-sdk`. Each worker gets the system prompt from `src/worker-prompt.ts`.
- **MCP Coordination Server** (`src/mcp/coordination-server.ts` + `src/mcp/tools.ts`) — Workers claim tasks, report completion, and exchange messages through MCP tools: `get_tasks`, `claim_task`, `complete_task`, `read_updates`, `post_update`.
- **Flow Tracer** (`src/core/flow-tracer.ts`) — Spawns read-only workers to trace user flows through code changes and report security/architectural findings.

### Planning & Review
- **Planner** (`src/core/planner.ts`) — Decomposes features into tasks with dependencies using Agent SDK.
- **CodexReviewer** (`src/core/codex-reviewer.ts`) — Calls external `codex` CLI for plan discussion (up to 5 rounds) and code review (up to 5 rounds).

### State & Infrastructure
- **StateManager** (`src/core/state-manager.ts`) — Persists `OrchestratorState` to `.orchestrator/state.json`. All tasks, sessions, messages, and reviews also persist under `.orchestrator/`.
- **UsageMonitor** (`src/core/usage-monitor.ts`) — Polls Anthropic OAuth API to track 5-hour usage window. Auto-pauses at 80% utilization, resumes at 50%.
- **Types** (`src/utils/types.ts`) — All shared TypeScript types (`OrchestratorState`, `Task`, `SessionStatus`, `Message`, etc.).
- **Constants** (`src/utils/constants.ts`) — Configuration defaults, file paths, tool allowlists, thresholds.

### Entry Points
- **CLI** (`src/cli.ts`) — Commands: `start`, `status`, `resume`, `pause`, `log`. Uses Commander.js.
- **Slash Command** (`commands/orchestrate.md`) — Interactive guide for invoking from within Claude Code. Installed to `~/.claude/commands/` by `src/setup.ts`.

## Key Design Decisions

- Git branch isolation: all changes go to `orchestrate/<feature-slug>` branches.
- Workers get a restricted tool allowlist defined in `WORKER_ALLOWED_TOOLS` (constants.ts). Flow-tracing workers are further restricted to read-only tools.
- Escalation model: after `MAX_DISAGREEMENT_ROUNDS` (2) or `DEFAULT_MAX_CYCLES` (5), the orchestrator writes `escalation.json` and pauses for human guidance.
- Default concurrency is 2 parallel workers (`DEFAULT_CONCURRENCY`).
