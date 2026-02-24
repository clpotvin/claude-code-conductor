You are launching the Hierarchical Agent Orchestrator. This system decomposes a large feature into parallel tasks, spawns headless Claude Code worker sessions via the Agent SDK, coordinates them via a custom MCP server, gets Codex reviews, and handles usage limits — all autonomously.

The user's feature description is: $ARGUMENTS

## Your Role

You are the **interactive front-end** for the orchestrator. The orchestrator itself runs as a background process with no stdin, so YOU handle all user interaction — Q&A, configuration, escalations — and communicate with the orchestrator via files.

## Phase 1: Gather Context

### Step 1: Validate the feature description

If `$ARGUMENTS` is empty or unclear, ask the user to describe the feature they want to implement.

### Step 2: Exhaustive Clarifying Questions

Before launching the orchestrator, YOU must ask the user thorough clarifying questions about the feature. This is critical — the orchestrator cannot ask questions interactively.

First, explore the codebase yourself to understand the existing architecture, then ask the user **at least 10 detailed questions** covering:
- Edge cases and error handling
- User flows and UI/UX expectations
- Data models and database changes
- API design and integrations
- Authentication/authorization implications
- Testing strategy
- Performance considerations
- Backwards compatibility
- Deployment concerns
- Any project-specific conventions you noticed in the codebase

Format your questions clearly with numbers. Wait for the user to answer ALL of them before proceeding.

### Step 3: Confirm configuration

Ask the user if they want to adjust any of these (show defaults):
- **Concurrency**: 2 parallel workers
- **Max cycles**: 5 plan-execute-review cycles before escalating
- **Usage threshold**: 80% (auto-pause when Max 20x usage hits this)
- **Skip Codex**: No (Codex reviews plans and code each cycle)
- **Dry run**: No (set to yes to only generate the plan without executing)

Keep it brief — show the defaults, ask if they want to change anything or just go.

## Phase 2: Write Context File & Launch

### Step 4: Write the context file

Once you have all answers, write a comprehensive context file to `.orchestrator/context.md` in the project directory. The file should contain:

```markdown
# Feature: <feature description>

## User Requirements

<Detailed feature description combining the original request and all Q&A>

## Q&A

<All questions and answers, formatted as:>
Q1: <question>
A1: <answer>

Q2: <question>
A2: <answer>
...

## Codebase Notes

<Any relevant observations you made about the existing codebase architecture, patterns, conventions, etc.>

## Configuration

Concurrency: <n>
Max Cycles: <n>
Usage Threshold: <n>%
Skip Codex: <yes/no>
```

Create the `.orchestrator` directory first if it doesn't exist:
```bash
mkdir -p "$(pwd)/.orchestrator"
```

Then write the context file using your Write tool to `<project>/.orchestrator/context.md`.

### Step 5: Launch the orchestrator

Run it as a background process:
```bash
orchestrate start "<feature description>" \
  --project "$(pwd)" \
  --context-file "$(pwd)/.orchestrator/context.md" \
  --concurrency <n> \
  --max-cycles <n> \
  --usage-threshold <threshold> \
  [--skip-codex] \
  [--dry-run] \
  --verbose \
  2>&1 | tee "$(pwd)/.orchestrator/logs/orchestrator-stdout.log" &
```

Tell the user the orchestrator has launched and give them these commands to monitor:
- **Status**: `orchestrate status --project "$(pwd)"`
- **Logs**: `orchestrate log --project "$(pwd)" -n 100`
- **Full stdout**: `tail -f .orchestrator/logs/orchestrator-stdout.log`

## Phase 3: Monitor for Escalations

After launching, periodically check for an escalation file:
```bash
cat "$(pwd)/.orchestrator/escalation.json" 2>/dev/null
```

If an escalation file exists:
1. Read it and show the user the reason and details
2. Ask the user how they want to proceed:
   - **Continue**: Just resume with `orchestrate resume`
   - **Redirect**: Get new guidance from the user, write it to `.orchestrator/context.md`, then resume
   - **Stop**: Leave it stopped
3. Delete the escalation file after handling it
4. If continuing/redirecting, run: `orchestrate resume --project "$(pwd)" --verbose`

## Other Operations

If the user says "status", "resume", "logs", or similar instead of describing a feature:

- **Status**: `orchestrate status --project "$(pwd)"`
- **Resume**: `orchestrate resume --project "$(pwd)" --verbose`
- **Logs**: `orchestrate log --project "$(pwd)" -n 100`

## Important Notes

- Workers are full headless Claude Code sessions that can spawn their own agent teams.
- Usage is monitored via the OAuth endpoint — auto-pauses at the threshold, auto-resumes when the window resets.
- All state lives in `.orchestrator/` inside the project. Runs survive crashes and can be resumed.
- Code goes on an `orchestrate/<feature-slug>` git branch.
- If `orchestrate` is not found, the user needs to run `npm link` inside the `claude-orchestrator` package directory.
