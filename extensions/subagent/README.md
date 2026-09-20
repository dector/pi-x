# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to child processes
- **Inherited permissions**: Each child snapshots the parent's safe mode and outer-access setting at spawn
- **Approval relay**: Child dialogs are labeled and serialized through the parent UI
- **Runtime controls**: `/px:agents` can inspect, pause, resume, abort, or reconfigure a running child
- **Status-bar row**: While children run, publishes one row with the running count, sorted above the `proc` row
- **Run log**: `/px:agent:log` shows each run's original task prompt and final output

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── rpc-client.ts        # RPC process transport and JSONL framing
├── approval-queue.ts    # Global serialized child-dialog queue
├── control.ts           # Child permission and cooperative pause controls
├── registry.ts          # Active/recent run registry
├── result-output.ts     # Canonical per-result output extraction (shared with tool results)
├── run-id.ts            # Restart-safe unique run IDs
├── agent-log.ts         # Pure merge/format helpers for `/px:agent:log`
├── status-row.ts        # Pure formatter and presence probe for the running-count status row
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   ├── researcher.md    # Web + local research with citations
│   ├── ultra-reviewer-explicit.md  # Deep review (gpt-5.6-sol) — only on explicit request
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts
# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

Dependencies:

- [`status-bar`](../status-bar/README.md) for the running-count row (optional but recommended)
- `safe-mode` for child permission inheritance (optional)

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

Children use pi RPC mode. Safe-mode approvals appear in the parent UI with the agent name and stable run ID. Parallel approval dialogs are shown one at a time. In a non-interactive parent, requests fail closed instead of hanging.

Safe mode is a spawn-time snapshot. Parent changes affect later children only. Session-only approvals remain local to the child that received them; project-persistent approvals continue to use the repository allowlist.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential; `{previous}` in a step's task is interpolated with the previous step's final output (empty for the first step) |

## Runtime manager

Run `/px:agents` to list active and recent children. Select a run to:

- inspect its task, PID, state, working directory, diagnostics, and inherited/effective mode;
- configure that child's safe mode and outer access;
- request cooperative pause or resume;
- abort it after confirmation.

Pause takes effect at the next safe boundary, before a provider turn or tool call. It does not interrupt a provider request or tool already in progress, so the state may remain `pause-requested` briefly.

## Status bar

While at least one child is running, `subagent` publishes one generic
[`status-bar`](../status-bar/README.md) row with the running count, using
`order: 50` so it sorts above the `proc` row (`order: 100`). The row is cleared
when the last child finishes and on `session_shutdown`.

```text
◆ 2 subagents running
● vite 48231  ·  ● npm 48255
```

The row is optional: `subagent` works without `status-bar`, it only loses the
row. When the first run starts, the extension pings `status-bar`; if no pong
arrives within a short delay it shows one warning, then stops probing for the
session. The warning is cancelled if the run finishes (or the running count
returns to zero) before the delay elapses, so a short run never warns.

## Run log (`/px:agent:log`)

`/px:agent:log` lists every agent run seen in this session. Select one to see
the exact task prompt it was started with and the final output it returned, or
pick `View all runs` to open every run in one editor.

Sources are merged and deduplicated by `runId`:

- the live `SubagentRegistry` (active runs and recent completed runs);
- persisted `subagent` tool results in the current session branch, so runs stay
  visible after registry pruning or `/resume`.

The registry entry wins on a `runId` collision because it carries live state,
but richer persisted metadata (`mode`, `step`, and timestamps) is preserved.
Persisted results without a `runId` fall back to a content signature to avoid
double-reporting. Picker labels are made unique, so duplicate-looking runs open
the entry you selected. With no UI the command returns quietly, and with no
recorded runs it notifies
`No subagent runs recorded in this session.`

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Per-tool outcomes: running, waiting approval, approved, completed, blocked, failed, or interrupted, with a short failure reason
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
short_description: Brief one-liner shown in the subagent tool description
tools: read, grep, find, ls
model: opencode-go/deepseek-v4.1-flash
thinking: high
---

System prompt for the agent goes here.
```

`description` is the full, human-authored summary. `short_description` is an optional
brief version surfaced to the parent model in the `subagent` tool description, so it
knows which agent to pick without trial and error. Keep it short to save tokens; when
omitted, the full `description` is used instead.

When `model` is omitted, the subagent inherits the dispatching session's active model and thinking level.
When `thinking` is omitted but `model` is set, the model's default thinking level is used.
The `thinking` field accepts pi thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
Levels the chosen model does not support are clamped by pi.

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (loaded with the default `agentScope: "user"` and with `"both"`; skipped by `"project"`)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Thinking | Tools |
|-------|---------|-------|----------|-------|
| `scout` | Fast codebase recon | deepseek-v4.1-flash | low | read, grep, find, ls, bash |
| `planner` | Implementation plans | deepseek-v4.1-flash | high | read, grep, find, ls |
| `reviewer` | Code review | deepseek-v4.1-flash | max | read, grep, find, ls, bash |
| `researcher` | Web + local research with citations | deepseek-v4.1-flash | high | web_search, http_md, http, read, grep, find, ls |
| `ultra-reviewer-explicit` | Deep adversarial review (only on explicit request) | gpt-5.6-sol | max | read, grep, find, ls, bash |
| `worker` | General-purpose | deepseek-v4.1-flash | high | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) asks the child to abort, then terminates it with bounded escalation
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- Cooperative pause waits for the next turn/tool boundary; it is not hard process suspension
- Completed manager records are retained only as a bounded recent history
- `/px:agent:log` shows the task and final output; intermediate tool calls stay in the expanded tool result view
