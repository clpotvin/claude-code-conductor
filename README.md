# claude-orchestrator

Hierarchical agent orchestration for implementing large features autonomously. Spawns parallel headless Claude Code worker sessions, coordinates them via a custom MCP server, optionally gets Codex reviews, and handles usage limits with automatic pause/resume.

## Prerequisites

- **Node.js** >= 20
- **Claude Code** CLI installed and authenticated (Max subscription)
- **Git** initialized in your target project
- **Codex** CLI (optional, for automated code reviews)

## Install

```bash
# Clone or copy this package somewhere on your machine
cd claude-orchestrator

# Install dependencies and build
npm install
npm run build

# Link the CLI globally so 'orchestrate' is on your PATH
npm link
```

The install automatically copies the `/orchestrate` slash command to `~/.claude/commands/` so it's available in Claude Code. If you need to re-install the slash command manually:

```bash
npm run setup
```

## Usage

### Via Claude Code (recommended)

Open Claude Code in any project and run:

```
/orchestrate Add user authentication with OAuth, session management, and role-based access control
```

Claude Code will:
1. Explore your codebase
2. Ask you 10+ clarifying questions about the feature
3. Gather your configuration preferences
4. Launch the orchestrator in the background
5. Monitor for escalations and handle them with you

### Via CLI directly

```bash
# Start a new orchestration run
orchestrate start "Add user authentication" \
  --project /path/to/your/project \
  --concurrency 2 \
  --max-cycles 5 \
  --usage-threshold 0.80 \
  --verbose

# Check status
orchestrate status --project /path/to/your/project

# View logs
orchestrate log --project /path/to/your/project -n 100

# Resume a paused run
orchestrate resume --project /path/to/your/project --verbose
```

### CLI Options

| Option | Default | Description |
|---|---|---|
| `--project <dir>` | Current directory | Project to orchestrate |
| `--concurrency <n>` | 2 | Number of parallel worker sessions |
| `--max-cycles <n>` | 5 | Max plan-execute-review cycles before escalating |
| `--usage-threshold <n>` | 0.80 | Pause when 5-hour usage hits this (0-1) |
| `--skip-codex` | false | Skip Codex plan/code reviews |
| `--dry-run` | false | Generate plan only, don't execute |
| `--context-file <path>` | none | Pre-gathered context file (skips interactive Q&A) |
| `--verbose` | false | Verbose logging |

## How It Works

1. **Planning** — The orchestrator analyzes your feature description and codebase, then decomposes the work into independent tasks.

2. **Codex Review** (optional) — The plan is sent to Codex for review. If Codex has concerns, the plan is revised.

3. **Execution** — Tasks are assigned to parallel headless Claude Code worker sessions. Workers coordinate via a custom MCP server (task board + messaging).

4. **Review** — After workers finish, Codex reviews the code changes. If issues are found, a new cycle begins with revised tasks.

5. **Usage Monitoring** — The orchestrator polls the Anthropic usage API. If your 5-hour window hits the threshold, it gracefully pauses all workers and waits for the window to reset before resuming.

6. **Escalation** — If the orchestrator hits max cycles or encounters issues it can't resolve, it writes an escalation file and exits. Claude Code (or you) can provide guidance and resume.

## Project Structure During a Run

All orchestration state lives in `.orchestrator/` inside your project:

```
your-project/
  .orchestrator/
    state.json          # Current run state
    context.md          # User requirements and Q&A
    plan-v1.md          # Generated plan (versioned)
    escalation.json     # Escalation details (if paused)
    tasks/              # Individual task files
    sessions/           # Worker session state
    messages/           # Inter-worker messages
    codex-reviews/      # Codex review results
    logs/               # Orchestrator and worker logs
```

Code changes are made on a `orchestrate/<feature-slug>` git branch.

## Authentication

The orchestrator needs your Claude Code OAuth token to monitor usage. It automatically finds it from (in order):

1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
2. `~/.claude/.credentials.json` file (Linux)
3. macOS Keychain (`Claude Code-credentials` entry)

No additional setup needed if you're already authenticated with Claude Code.

## Troubleshooting

**`orchestrate: command not found`**
Run `npm link` from the package directory.

**`No OAuth token found`**
Make sure you're logged into Claude Code (`claude` in terminal). The orchestrator reads your existing OAuth token.

**Workers dying / orphaned tasks**
The orchestrator automatically detects orphaned tasks (where the worker session died) and resets them to pending for reassignment.

**Stuck on "paused"**
The orchestrator auto-resumes when your usage window resets. You can also manually resume with `orchestrate resume`.

**Want to start fresh**
Delete the `.orchestrator/` directory in your project and start a new run.

## Development

```bash
# Watch mode for development
npm run dev

# Run tests
npm test

# Build
npm run build
```
