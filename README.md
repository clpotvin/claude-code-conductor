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
- **Codex** CLI (optional, for automated code reviews)
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
3. Gather your configuration preferences
4. Launch the conductor in the background
5. Monitor for escalations and handle them with you

### Via CLI directly

```bash
# Start a new conductor run
conduct start "Add user authentication" \
  --project /path/to/your/project \
  --concurrency 2 \
  --max-cycles 5 \
  --usage-threshold 0.80 \
  --verbose

# Check status
conduct status --project /path/to/your/project

# View logs
conduct log --project /path/to/your/project -n 100

# Resume a paused run
conduct resume --project /path/to/your/project --verbose
```

### CLI Options

| Option | Default | Description |
|---|---|---|
| `--project <dir>` | Current directory | Project to conduct |
| `--concurrency <n>` | 2 | Number of parallel worker sessions |
| `--max-cycles <n>` | 5 | Max plan-execute-review cycles before escalating |
| `--usage-threshold <n>` | 0.80 | Pause when 5-hour usage hits this (0-1) |
| `--skip-codex` | false | Skip Codex plan/code reviews |
| `--skip-flow-review` | false | Skip flow-tracing review phase |
| `--dry-run` | false | Generate plan only, don't execute |
| `--context-file <path>` | none | Pre-gathered context file (skips interactive Q&A) |
| `--current-branch` | false | Work on the current branch instead of creating a new one |
| `--verbose` | false | Verbose logging |

## How It Works

### The Conductor Loop

```
plan --> execute (parallel workers) --> code review + flow trace --> checkpoint
  ^                                                                     |
  |_____________________ another cycle if issues found _________________|
```

Each cycle runs through these phases:

1. **Planning** -- The planner analyzes your codebase and feature description, generates a STRIDE threat model, then decomposes work into typed tasks with security requirements, performance requirements, and acceptance criteria. Anchor tasks (shared foundations) are identified for priority execution.

2. **Conventions Extraction** -- A read-only agent scans the codebase to extract existing patterns: auth middleware, validation libraries, error handling, test frameworks, directory structure, naming conventions, and security invariants. These are injected into every worker's prompt.

3. **Codex Plan Review** (optional) -- The plan is sent to Codex for discussion. Up to 5 rounds of back-and-forth before the plan is finalized.

4. **Execution** -- Tasks are assigned to parallel headless Claude Code worker sessions. Workers coordinate via a custom MCP server with shared contracts, architectural decisions, and dependency context. A security sentinel worker runs alongside, scanning completed code in real-time.

5. **Code Review + Flow Tracing** (parallel) -- Codex reviews the code changes while flow-tracing workers trace user journeys end-to-end across all code layers. Both run simultaneously to save time.

6. **Checkpoint** -- The conductor decides whether to ship or loop. If flow tracing found critical/high issues, fix tasks are auto-generated and another cycle begins. If code review was not approved, another cycle begins. Otherwise, the run completes.

7. **Usage Monitoring** -- Runs continuously in the background. If your 5-hour window hits the threshold, all workers gracefully pause and auto-resume when usage resets.

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

### Cross-Worker Coordination

Workers share context through MCP tools beyond the basic task board:

| Tool | Purpose |
|---|---|
| `register_contract` | Publish an API schema, type definition, or event format |
| `get_contracts` | Query contracts to ensure your implementation conforms |
| `record_decision` | Record an architectural decision (naming, auth, data model) |
| `get_decisions` | Check existing decisions before making new choices |
| `run_tests` | Run the project test suite and get results |

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
    state.json            # Current run state
    plan-v1.md            # Generated plan (versioned)
    conventions.json      # Extracted codebase conventions (cached)
    known-issues.json     # Persistent issue tracking across cycles
    escalation.json       # Escalation details (if paused)
    decisions.jsonl       # Architectural decisions log
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

Code changes are made on a `conduct/<feature-slug>` git branch.

## Architecture

```
src/
  cli.ts                        # CLI entry point (Commander.js)
  worker-prompt.ts              # Worker system prompt builder (security constitution, DoD, etc.)
  flow-worker-prompt.ts         # Flow-tracing worker prompt
  performance-worker-prompt.ts  # Performance-tracing worker prompt
  core/
    orchestrator.ts             # Main conductor loop
    planner.ts                  # Task decomposition + threat modeling
    worker-manager.ts           # Worker spawning + sentinel
    codex-reviewer.ts           # Codex integration
    flow-tracer.ts              # Flow-tracing review
    state-manager.ts            # State persistence
    usage-monitor.ts            # Anthropic usage API polling
  mcp/
    coordination-server.ts      # MCP server (stdio transport)
    tools.ts                    # MCP tool handlers (tasks, contracts, decisions, tests)
  utils/
    types.ts                    # All TypeScript types
    constants.ts                # Configuration defaults and paths
    flow-config.ts              # Flow config loader + defaults
    conventions-extractor.ts    # Codebase pattern extraction
    rules-loader.ts             # Project rules loader
    semgrep-runner.ts           # Static analysis runner
    known-issues.ts             # Known issues registry
    logger.ts                   # Structured logging
    git.ts                      # Git operations
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
The conductor automatically detects orphaned tasks (where the worker session died) and resets them to pending for reassignment.

**Stuck on "paused"**
The conductor auto-resumes when your usage window resets. You can also manually resume with `conduct resume`.

**Semgrep not found**
Semgrep is optional. Install it with `pip install semgrep` for static security analysis. Without it, the semgrep phase is skipped with a warning.

**Want to start fresh**
Delete the `.conductor/` directory in your project and start a new run.

## Development

```bash
npm run dev      # Watch mode
npm test         # Run tests (vitest)
npm run build    # Compile TypeScript
npm run setup    # Install slash command
```

## License

MIT
