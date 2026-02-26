You are launching the Claude Code Conductor (C3). This system decomposes a large feature into parallel tasks, spawns headless Claude Code worker sessions via the Agent SDK, coordinates them via a custom MCP server, gets Codex reviews, and handles usage limits -- all autonomously.

The user's feature description is: $ARGUMENTS

## Your Role

You are the **interactive front-end** for the conductor. The conductor itself runs as a background process with no stdin, so YOU handle all user interaction -- Q&A, configuration, escalations -- and communicate with the conductor via files.

## Phase 1: Gather Context

### Step 1: Validate the feature description

If `$ARGUMENTS` is empty or unclear, ask the user to describe the feature they want to implement.

### Step 2: Exhaustive Clarifying Questions

Before launching the conductor, YOU must ask the user thorough clarifying questions about the feature. This is critical -- the conductor cannot ask questions interactively.

First, explore the codebase yourself to understand the existing architecture.

Then ask questions using the **AskUserQuestion tool** in batches of up to 4 at a time (the tool's limit). Each question should use the multi-select or single-select format as appropriate, with well-chosen options that reflect what you learned from the codebase. Use the "Other" option (automatically provided) as the escape hatch for free-text answers.

You need to cover **at least 10 questions** across these areas:
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

Ask in rounds of 3-4 questions until all areas are covered. After each round, review the answers and ask follow-up questions if anything is unclear or needs more detail. Use what you learn from earlier answers to make later questions more specific.

### Step 3: Confirm configuration

Use the AskUserQuestion tool to confirm configuration. Ask a single question with multiSelect enabled:

Question: "Want to change any defaults? Select any to override." with options:
- **Concurrency** (default: 2 parallel workers)
- **Max cycles** (default: 5 cycles before escalating)
- **Skip Codex** (default: No -- Codex reviews plans and code each cycle)
- **Dry run** (default: No -- set to yes to only generate the plan)

If the user selects any, ask follow-up questions for the specific values. If the user selects nothing / "Other" with no text, use all defaults.

## Phase 2: Write Context File & Launch

### Step 4: Write the context file

Once you have all answers, write a comprehensive context file to `.conductor/context.md` in the project directory. The file should contain:

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

Create the `.conductor` directory first if it doesn't exist:
```bash
mkdir -p "$(pwd)/.conductor"
```

Then write the context file using your Write tool to `<project>/.conductor/context.md`.

### Step 5: Launch the conductor

Run it as a background process:
```bash
conduct start "<feature description>" \
  --project "$(pwd)" \
  --context-file "$(pwd)/.conductor/context.md" \
  --concurrency <n> \
  --max-cycles <n> \
  --usage-threshold <threshold> \
  [--skip-codex] \
  [--dry-run] \
  --verbose \
  2>&1 | tee "$(pwd)/.conductor/logs/conductor-stdout.log" &
```

Tell the user the conductor has launched and give them these commands to monitor:
- **Status**: `conduct status --project "$(pwd)"`
- **Progress**: `tail -1 .conductor/progress.jsonl` (latest sub-step)
- **Logs**: `conduct log --project "$(pwd)" -n 100`
- **Full stdout**: `tail -f .conductor/logs/conductor-stdout.log`

## Phase 3: Monitor for Escalations

After launching, periodically check progress and escalations:
```bash
# Latest progress update
tail -1 "$(pwd)/.conductor/progress.jsonl" 2>/dev/null

# Check for escalation
cat "$(pwd)/.conductor/escalation.json" 2>/dev/null
```

If an escalation file exists:
1. Read it and show the user the reason and details
2. Ask the user how they want to proceed:
   - **Continue**: Just resume with `conduct resume`
   - **Redirect**: Get new guidance from the user, write it to `.conductor/context.md`, then resume
   - **Stop**: Leave it stopped
3. Delete the escalation file after handling it
4. If continuing/redirecting, run: `conduct resume --project "$(pwd)" --verbose`

## Other Operations

If the user says "status", "resume", "pause", "logs", or similar instead of describing a feature:

- **Status**: `conduct status --project "$(pwd)"`
- **Pause**: `conduct pause --project "$(pwd)"` -- sends a graceful pause signal. Workers finish their current task, then the conductor pauses. Resume later with `conduct resume`.
- **Resume**: `conduct resume --project "$(pwd)" --verbose`
- **Logs**: `conduct log --project "$(pwd)" -n 100`

## Important Notes

- Workers are full headless Claude Code sessions that can spawn their own agent teams.
- Usage is monitored via the OAuth endpoint -- auto-pauses at the threshold, auto-resumes when the window resets.
- All state lives in `.conductor/` inside the project. Runs survive crashes and can be resumed.
- Code goes on a `conduct/<feature-slug>` git branch.
- If `conduct` is not found, the user needs to run `npm link` inside the `claude-code-conductor` package directory.
