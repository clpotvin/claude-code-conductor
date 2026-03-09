# Claude Code Conductor (C3)

Hierarchical multi-agent orchestration for Claude Code. Plans, delegates to parallel workers, reviews with Codex, and traces user flows across code boundaries. Think of it as a software engineering department in your terminal: a director plans the work, managers coordinate, and engineers (headless Claude Code sessions) execute.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents/agent-sdk) and [Model Context Protocol](https://modelcontextprotocol.io/).

## What Makes This Different

C3 is designed to one-shot large features with security and performance built in from the start, not bolted on after. The pipeline includes:

- **Threat modeling** during planning (STRIDE-based attack surface analysis)
- **Security constitution** in every worker prompt (input validation, auth, output encoding, secrets management)
- **Security sentinel** worker that monitors code in real-time during execution
- **Static analysis** via semgrep integration between execution and review
- **Cross-worker coordination** through shared contracts, architectural decisions, and dependency context
- **Flow tracing** that traces user journeys end-to-end across all code layers
- **Automatic fix cycles** when critical issues are found (checkpoint gating)

## Prerequisites

- **Node.js** >= 20
- **Claude Code** CLI installed and authenticated (Max subscription)
- **Git** initialized in your target project
- **Codex** CLI (optional for reviews, required if you choose `--worker-runtime codex`)
- **Semgrep** (optional, for static security analysis -- `pip install semgrep`)

## Install

```bash
git clone https://github.com/clpotvin/claude-code-conductor.git
cd claude-code-conductor

npm install
npm run build

# Link the CLI globally so 'conduct' is on your PATH
npm link
```

The install automatically copies the `/conduct` slash command to `~/.claude/commands/` so it's available in Claude Code. To re-install the slash command manually:

```bash
npm run setup
```

## Usage

### Via Claude Code (recommended)

Open Claude Code in any project and run:

```
/conduct Add user authentication with OAuth, session management, and role-based access control
```

Claude Code will:
1. Explore your codebase
2. Ask you 10+ clarifying questions (including security-specific ones)
3. Gather your configuration preferences (including model selection)
4. Launch the conductor in the background
5. Monitor for escalations and handle them with you

### Via CLI directly

```bash
# Start a new conductor run (interactive model selection prompt)
conduct start "Add user authentication" \
  --project /path/to/your/project \
  --concurrency 2 \
  --max-cycles 5 \
  --verbose

# Start with specific models
conduct start "Add user authentication" \
  --project /path/to/your/project \
  --worker-model sonnet \
  --subagent-model haiku \
  --concurrency 3 \
  --verbose

# Check status
conduct status --project /path/to/your/project

# View logs
conduct log --project /path/to/your/project -n 100

# Pause a running conductor
conduct pause --project /path/to/your/project

# Resume a paused run
conduct resume --project /path/to/your/project --verbose
```

### CLI Options

**`conduct start`**

| Option | Default | Description |
|---|---|---|
| `--project <dir>` | Current directory | Project to conduct |
| `--worker-runtime <claude\|codex>` | `claude` | Execution worker backend |
| `--worker-model <opus\|sonnet\|haiku>` | `opus` | Claude model for workers, planner, conventions extraction, and flow tracing |
| `--subagent-model <opus\|sonnet\|haiku>` | `sonnet` | Claude model for subagents spawned by workers and the sentinel |
| `--extended-context` | `false` | Use 1M token context window (opus/sonnet only, costs extra) |
| `--concurrency <n>` | `2` | Number of parallel worker sessions |
| `--max-cycles <n>` | `5` | Max plan-execute-review cycles before escalating |
| `--usage-threshold <n>` | `0.80` | Pause when 5-hour usage hits this (0-1) |
| `--skip-codex` | `false` | Skip Codex plan/code reviews |
| `--skip-flow-review` | `false` | Skip flow-tracing review phase |
| `--dry-run` | `false` | Generate plan only, don't execute |
| `--context-file <path>` | none | Pre-gathered context file (skips interactive Q&A and model prompt) |
| `--current-branch` | `false` | Work on the current branch instead of creating `conduct/<slug>` |
| `--verbose` | `false` | Verbose logging |

**`conduct resume`**

| Option | Default | Description |
|---|---|---|
| `--project <dir>` | Current directory | Project to resume |
| `--worker-runtime <claude\|codex>` | saved | Override the saved worker runtime |
| `--worker-model <tier>` | saved | Override the saved worker model |
| `--subagent-model <tier>` | saved | Override the saved subagent model |
| `--extended-context` | saved | Override extended context setting |
| `--concurrency <n>` | saved | Override the saved concurrency |
| `--skip-codex` | `false` | Skip Codex reviews |
| `--skip-flow-review` | `false` | Skip flow-tracing review phase |
| `--force-resume` | `false` | Resume a stale run stuck in a non-paused state (e.g., `executing`) |
| `--verbose` | `false` | Verbose logging |

### Model Selection

When running `conduct start` without model flags and without `--context-file`, an interactive prompt asks you to choose:

1. **Worker model** -- Used for execution workers, planner, conventions extraction, and flow tracing. Default: opus.
2. **Subagent model** -- Used for subagents spawned by workers (via the Agent/Task tool) and the security sentinel. Default: sonnet.
3. **Extended context** -- Enables the 1M token context window for opus or sonnet. Not available for haiku. Default: no.

Available models:

| Tier | Model ID | Description |
|---|---|---|
| `opus` | `claude-opus-4-6` | Most capable, highest cost |
| `sonnet` | `claude-sonnet-4-6` | Balanced capability and cost |
| `haiku` | `claude-haiku-4-5-20251001` | Fastest, lowest cost |

Model configuration is persisted to `state.json` and restored on `conduct resume`. You can override it on resume with `--worker-model` and `--subagent-model`.

### Execution Runtime

- `--worker-runtime claude` (default) runs workers as headless Claude Code sessions via the Agent SDK.
- `--worker-runtime codex` runs the execution phase with parallel `codex exec` workers and a Codex-backed sentinel.
- Planning, conventions extraction, and flow tracing always use the Claude Agent SDK regardless of runtime.
- The `--concurrency` setting controls how many execution workers run in parallel.

## How It Works

### The Conductor Loop

```
plan --> execute (parallel workers) --> code review + flow trace --> checkpoint
  ^                                                                     |
  |_____________________ another cycle if issues found _________________|
```

Each cycle runs through these phases:

1. **Planning** -- The planner analyzes your codebase and feature description, generates a STRIDE threat model, then decomposes work into typed tasks with security requirements, performance requirements, and acceptance criteria. Anchor tasks (shared foundations) are identified for priority execution. Tasks are written to a draft file and validated with a dedicated MCP tool before acceptance.

2. **Conventions Extraction** -- A read-only agent scans the codebase to extract existing patterns: auth middleware, validation libraries, error handling, test frameworks, directory structure, naming conventions, and security invariants. Results are cached for 1 hour.

3. **Codex Plan Review** (optional) -- The plan is sent to Codex for discussion. Up to 5 rounds of back-and-forth before the plan is finalized.

4. **Execution** -- Tasks are assigned to parallel headless worker sessions using the selected execution runtime and model. Workers coordinate via a custom MCP server with shared contracts, architectural decisions, and dependency context. A security sentinel worker runs alongside, scanning completed code in real-time. Task scheduling uses priority scoring based on task type, risk level, and critical path depth.

5. **Code Review + Flow Tracing** (parallel) -- Codex reviews the code changes while flow-tracing workers trace user journeys end-to-end across all code layers. Both run simultaneously since they are read-only.

6. **Checkpoint** -- The conductor decides whether to ship or loop. If flow tracing found critical/high issues, fix tasks are auto-generated and another cycle begins. If code review was not approved, another cycle begins. Otherwise, the run completes.

7. **Usage Monitoring** -- Runs continuously in the background with adaptive polling. Tracks usage rate over time and predicts when thresholds will be reached. If your 5-hour window hits the threshold, all workers gracefully pause and auto-resume when usage resets.

8. **Escalation** -- After max cycles or unresolvable disagreements, the conductor writes an escalation file and pauses for human guidance.

### Worker Intelligence

Every worker session receives:

- **Security constitution** -- Mandatory rules for input validation, authentication, authorization, output encoding, error handling, secrets management, and dependency hygiene.
- **Performance rules** -- Pagination, bounded queries, N+1 avoidance, index verification.
- **Definition of done checklist** -- 9-point verification before a task can be marked complete.
- **Project conventions** -- Extracted patterns from the existing codebase (auth, validation, error handling, tests, etc.).
- **Project rules** -- Custom rules from `.conductor/rules.md`.
- **Threat model** -- Attack surfaces and required mitigations for the feature being built.
- **Task-type guidelines** -- Specific guidance for security, backend API, frontend UI, database, testing, and infrastructure tasks.
- **Dependency context** -- What completed tasks produced, what sibling tasks are doing, registered contracts and decisions.
- **Model guidance** -- Which model tier to use when spawning subagents.
- **Worker personas** -- Task-type-specific personas for focused expertise.
- **Project guidance** -- Auto-detected project profile (languages, frameworks, test runners, linters).

### Cross-Worker Coordination

Workers share context through MCP tools beyond the basic task board:

| Tool | Purpose |
|---|---|
| `register_contract` | Publish an API schema, type definition, or event format |
| `get_contracts` | Query contracts to ensure your implementation conforms |
| `record_decision` | Record an architectural decision (naming, auth, data model) |
| `get_decisions` | Check existing decisions before making new choices |
| `run_tests` | Run the project test suite and get results |

### Worker Resilience

Workers are monitored for health with automatic recovery:

- **Timeout tracking** -- Workers exceeding the wall-clock timeout (45 min) are detected and their tasks reassigned.
- **Heartbeat monitoring** -- Stale workers with no activity for 5 minutes are flagged.
- **Task retry** -- Failed tasks are retried up to 2 times (3 total attempts) with error context from previous attempts.
- **Rate limit detection** -- Provider rate limits are detected from worker output and bubbled up for orchestrator-level handling.

### Security Pipeline

```
Planning:     Threat model (STRIDE) --> security requirements on tasks
Execution:    Security sentinel (real-time) --> contracts + decisions
Review:       Codex review + flow tracing (parallel) --> semgrep (static analysis)
Checkpoint:   Gate on results --> auto-generate fix tasks --> known issues registry
```

The known issues registry persists across cycles. Issues found by any phase (Codex, flow tracing, semgrep, sentinel) are tracked and fed back into replanning so they actually get fixed.

## Project Configuration

### `.conductor/` directory

All conductor state lives in `.conductor/` inside your project:

```
your-project/
  .conductor/
    state.json            # Current run state (includes model config)
    plan-v1.md            # Generated plan (versioned)
    tasks-draft.json      # Planner task output (validated before acceptance)
    conventions.json      # Extracted codebase conventions (cached 1 hour)
    known-issues.json     # Persistent issue tracking across cycles
    escalation.json       # Escalation details (if paused)
    decisions.jsonl       # Architectural decisions log
    events.jsonl          # Structured event log (phases, workers, tasks)
    project-profile.json  # Auto-detected project profile (cached)
    progress.jsonl        # Real-time progress updates
    conductor.lock        # Process lock (prevents concurrent runs)
    tasks/                # Individual task files
    sessions/             # Worker session state
    messages/             # Inter-worker messages
    contracts/            # Shared API/type contracts
    codex-reviews/        # Codex review results
    flow-tracing/         # Flow tracing reports
    logs/                 # Conductor and worker logs
```

### Configurable Files

| File | Purpose |
|---|---|
| `.conductor/rules.md` | Custom rules injected into every worker prompt. Use this for project-specific conventions like "always use `secureHandler`" or "never use `any` type". |
| `.conductor/worker-rules.md` | Alternative name for worker rules (same effect as `rules.md`). |
| `.conductor/flow-config.json` | Configure flow-tracing layers, actor types, edge cases, and example flows. See [Flow Configuration](#flow-configuration) below. |

### Flow Configuration

Flow tracing is configurable per-project via `.conductor/flow-config.json`. If not present, sensible generic defaults are used.

```json
{
  "layers": [
    {
      "name": "Frontend/UI Layer",
      "checks": [
        "What data does the component send?",
        "Does it handle error states, loading states, empty states?",
        "Are there role-based UI guards that match backend permissions?"
      ]
    },
    {
      "name": "API/Route Layer",
      "checks": ["Does the endpoint enforce auth?", "Does it validate input?"]
    }
  ],
  "actor_types": ["owner", "admin", "member", "viewer", "anonymous"],
  "edge_cases": [
    "Concurrent modifications",
    "Token expiry mid-flow",
    "Access policy mismatch between layers"
  ],
  "example_flows": [
    {
      "id": "invite-member",
      "name": "Invite a new member",
      "description": "Admin invites a user by email...",
      "entry_points": ["app/settings/members/page.tsx"],
      "actors": ["admin", "unauthenticated"],
      "edge_cases": ["User already a member", "Token expired"]
    }
  ]
}
```

Code changes are made on a `conduct/<feature-slug>` git branch (or the current branch with `--current-branch`).

## Architecture

```
src/
  cli.ts                        # CLI entry point (Commander.js)
  setup.ts                      # Slash command installer
  worker-prompt.ts              # Worker system prompt builder (security constitution, DoD, etc.)
  worker-personas.ts            # Task-type-specific worker personas
  sentinel-prompt.ts            # Security sentinel prompt
  flow-worker-prompt.ts         # Flow-tracing worker prompt
  performance-worker-prompt.ts  # Performance-tracing worker prompt
  core/
    orchestrator.ts             # Main conductor loop
    planner.ts                  # Task decomposition + threat modeling
    worker-manager.ts           # Claude worker spawning + sentinel
    codex-worker-manager.ts     # Codex CLI worker spawning
    codex-reviewer.ts           # Codex plan/code review integration
    flow-tracer.ts              # Flow-tracing review
    state-manager.ts            # State persistence with file locking
    usage-monitor.ts            # Claude usage API polling (adaptive, rate-aware)
    codex-usage-monitor.ts      # Codex usage monitoring
    event-log.ts                # Structured event logging (phases, workers, tasks)
    project-detector.ts         # Auto-detect project languages, frameworks, tools
    task-scheduler.ts           # Priority-based task scheduling
    worker-resilience.ts        # Timeout, heartbeat, and retry tracking
  mcp/
    coordination-server.ts      # MCP server (stdio transport)
    tools.ts                    # MCP tool handlers (tasks, contracts, decisions, tests)
  utils/
    types.ts                    # All TypeScript types (including ModelConfig)
    constants.ts                # Configuration defaults and paths
    state-schema.ts             # Zod schema for state.json validation
    sdk-timeout.ts              # Agent SDK query wrapper with timeout
    task-validator.ts            # Task definition validation (Zod)
    flow-config.ts              # Flow config loader + defaults
    conventions-extractor.ts    # Codebase pattern extraction
    rules-loader.ts             # Project rules loader
    semgrep-runner.ts           # Static analysis runner
    known-issues.ts             # Known issues registry
    logger.ts                   # Structured logging
    git.ts                      # Git operations
    gitignore.ts                # .gitignore management
    progress.ts                 # Real-time progress reporting
    provider-limit.ts           # Rate limit detection from worker output
    codex-usage.ts              # Codex usage API helpers
    secure-fs.ts                # Secure file operations (0o600/0o700 permissions)
    validation.ts               # CLI parameter bounds validation
```

## Authentication

The conductor needs your Claude Code OAuth token to monitor usage. It automatically finds it from (in order):

1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
2. `~/.claude/.credentials.json` file
3. macOS Keychain (`Claude Code-credentials` entry)

No additional setup needed if you're already authenticated with Claude Code.

## Troubleshooting

**`conduct: command not found`**
Run `npm link` from the package directory.

**`No OAuth token found`**
Make sure you're logged into Claude Code (`claude` in terminal). The conductor reads your existing OAuth token.

**Workers dying / orphaned tasks**
The conductor automatically detects orphaned tasks (where the worker session died) and resets them to pending for reassignment. Workers that exceed the 45-minute timeout or go 5 minutes without activity are also detected and handled.

**Stuck on "paused"**
The conductor auto-resumes when your usage window resets. You can also manually resume with `conduct resume`.

**Stuck on "executing" or another non-paused state**
Use `conduct resume --force-resume` to recover from a stale state where the process died mid-execution.

**Another conductor process is already running**
A process lock prevents concurrent runs. If the previous process died, the lock will auto-expire after 1 hour, or you can check if the PID in `.conductor/conductor.lock.info` is still alive.

**Semgrep not found**
Semgrep is optional. Install it with `pip install semgrep` for static security analysis. Without it, the semgrep phase is skipped with a warning.

**Want to start fresh**
Delete the `.conductor/` directory in your project and start a new run.

## Development

```bash
npm run dev      # Watch mode
npm test         # Run tests (vitest, 565 tests)
npm run build    # Compile TypeScript
npm run setup    # Install slash command
```

## License

MIT
