# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Async by default**: Dispatches run detached in the background; the parent turn returns as soon as the request is accepted
- **Automatic completion**: One aggregate `subagent-completion` message is injected when the whole dispatch settles — immediately when the parent is idle, as a follow-up when it is busy
- **Explicit blocking**: `execution: "blocking"` streams progress and waits for the final result in the same turn
- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: Blocking dispatches stream tool calls and progress as they happen
- **Parallel streaming**: Blocking parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C aborts blocking children; detached children are aborted from `/px:agents` or on session shutdown
- **Inherited permissions**: Each dispatch snapshots the parent's safe mode and outer-access setting when it is prepared, before an async dispatch is accepted
- **Approval relay**: Child dialogs are labeled and serialized through the parent UI, even while detached
- **Runtime controls**: `/px:agents` can inspect, pause, resume, abort, or reconfigure a running child
- **Status-bar row**: While children run, publishes one row with the running count, sorted above the `proc` row
- **Run log**: `/px:agent:log` shows each run's original task prompt and final output, including detached runs after resume

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── prepare.ts           # Validation, permission, and ID allocation before execution
├── dispatch.ts          # Shared single/parallel/chain orchestration runner
├── lifecycle.ts         # Detached async dispatch ownership and exactly-once delivery
├── completion.ts        # Canonical acknowledgement/completion formatting and truncation
├── rpc-client.ts        # RPC process transport and JSONL framing
├── approval-queue.ts    # Global serialized child-dialog queue
├── control.ts           # Child permission and cooperative pause controls
├── registry.ts          # Active/recent run registry
├── result-output.ts     # Canonical per-result output extraction (shared with tool results)
├── run-id.ts            # Restart-safe unique run IDs
├── agent-log.ts         # Pure merge/format helpers for `/px:agent:log`
├── status-row.ts        # Pure formatter and presence probe for the running-count status row
├── safe-mode.ts         # Safe-mode snapshot query and child argv
├── timing.ts            # Per-run timing breakdown
├── events.ts            # RPC stream-event application to `SingleResult`
├── types.ts             # Shared dispatch/result types
├── fixtures/            # Test fixtures (fake RPC child, legacy contracts)
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

From the repository root, run the installer:

```bash
./install
```

Or copy/symlink this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/subagent/`
- Project-local: `.pi/extensions/subagent/`

```bash
# Symlink the whole extension directory (it has multiple modules)
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/extensions/subagent" ~/.pi/agent/extensions/subagent

# Agents and prompts are loaded from top-level pi directories, not the
# extension folder, so copy them out explicitly.
mkdir -p ~/.pi/agent/agents ~/.pi/agent/prompts
cp extensions/subagent/agents/*.md ~/.pi/agent/agents/
cp extensions/subagent/prompts/*.md ~/.pi/agent/prompts/
```

Then run `/reload`.

Dependencies:

- [`status-bar`](../status-bar/README.md) for the running-count row (optional but recommended)
- `safe-mode` for child permission inheritance (optional)

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

Children use pi RPC mode. Project-agent approval happens before an async dispatch is accepted, so a denied request never starts detached work. Child safe-mode approvals appear in the parent UI with the agent name and stable run ID, and can appear while you are chatting with the parent. Dialogs are serialized globally, one at a time. In a non-interactive parent, requests fail closed instead of hanging.

Safe mode is captured when a dispatch is prepared, before an async dispatch is accepted. Parent changes only affect dispatches prepared later. Session-only approvals remain local to the child that received them; project-persistent approvals continue to use the repository allowlist.

## Shared working tree

Parent and children share one working tree. Async editing agents are supported and run by default, but there is **no cross-process lock or merge**: the parent and several children can write the same files concurrently.

The `withFileMutationQueue` used for internal temp-file writes only serializes mutations inside the parent process. Children are separate processes, so it does not serialize their edits against each other or against the parent.

Mitigations in place:

- The async acknowledgement and completion details include the working directory.
- The acknowledgement tells the parent model to re-read affected files before editing them.
- Exact-edit failures surface unchanged instead of being hidden.

Re-read files before editing after a child may have touched them. Automatic worktrees, file ownership, and conflict resolution are out of scope.

## Usage

By default every dispatch is **async**: the `subagent` tool returns a dispatch id and run ids immediately, and the aggregate completion arrives later. Add `execution: "blocking"` when the current turn needs the result before it can continue.

### Single agent
```
Use scout to find all authentication code
```

### Blocking agent
```
Use worker to implement the validation change, execution: blocking
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

### Execution modes

| `execution` | Behavior |
|-------------|----------|
| omitted or `"async"` | Return immediately after acceptance; the aggregate result arrives later as one `subagent-completion` message. |
| `"blocking"` | Stream progress and return the final tool result in this turn. |

Async is the default for every capability, including agents that can edit, run bash, or write files. The parent can keep taking ordinary turns while children run. Do not poll for the result: it is delivered automatically.

When a dispatch settles, exactly one aggregate message is injected:

- if the parent is idle, it starts a new parent turn;
- if the parent is busy, it is queued and delivered as a follow-up.

The message carries the dispatch id, execution mode, mode (single/parallel/chain), requested agents and tasks, run ids, success/failure status, and final output. A partial failure keeps successful sibling output instead of dropping it.

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential; `{previous}` in a step's task is interpolated with the previous step's final output (empty for the first step) |
| Execution | `execution` | `"async"` (default) detaches and returns immediately; `"blocking"` streams and waits |

## Runtime manager

Run `/px:agents` to list active and recent children, async and blocking alike. Select a run to:

- inspect its task, PID, state, working directory, diagnostics, execution mode, dispatch id, and inherited/effective mode;
- configure that child's safe mode and outer access;
- request cooperative pause or resume;
- abort it after confirmation. For a detached child this aborts its owning dispatch, so the final completion is recorded as aborted and remaining chain/parallel work is stopped.

Pause takes effect at the next safe boundary, before a provider turn or tool call. It does not interrupt a provider request or tool already in progress, so the state may remain `pause-requested` briefly.

## Status bar

While at least one child is running, `subagent` publishes one generic
[`status-bar`](../status-bar/README.md) row with the running count, using
`order: 50` so it sorts above the `proc` row (`order: 100`). The row is cleared
when the last child finishes and on `session_shutdown`. Detached async children
keep the row published until their dispatch settles.

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

- the live `SubagentRegistry` (active runs and recent completed runs, async and blocking);
- persisted terminal `subagent` tool results in the current session branch;
- persisted `subagent-completion` custom messages, so detached runs stay visible
  after registry pruning, `/reload`, or `/resume`.

Async acknowledgement tool results (`dispatchStatus: "started"`) are never listed
as completed runs. The registry entry wins on a `runId` collision because it
carries live state, but richer persisted metadata (`mode`, `step`, `dispatchId`,
`execution`, and timestamps) is preserved.
Persisted results without a `runId` fall back to a content signature to avoid
double-reporting. Picker labels are made unique, so duplicate-looking runs open
the entry you selected. With no UI the command returns quietly, and with no
recorded runs it notifies
`No subagent runs recorded in this session.`

## Output Display

**Async acknowledgement**: The `subagent` tool result for a detached dispatch is a short `started in the background` note listing the dispatch id, run ids, tasks, and working directory. It is not a result. Live progress stays in the status row and `/px:agents`.

**Completion message**: When a detached dispatch settles, one `subagent-completion` message is injected. Collapsed, it shows the aggregate status and counts. Expanded (Ctrl+O), it shows every task, run id, working directory, output, and error. The model sees the same aggregate content.

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Per-tool outcomes: running, waiting approval, approved, completed, blocked, failed, or interrupted, with a short failure reason
- Timing after every finished, failed, or cancelled child: `Finished in 42.3s — API 31.8s, tools 9.7s, overhead 0.8s`
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task timing and usage (for chain/parallel)

**Parallel mode streaming (blocking)**:
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
- **stopReason "aborted"**: Aborting asks the child to stop, then terminates it with bounded escalation
- **Chain mode**: Stops at the first failing step and reports which step failed. The async completion message lists later unstarted steps as `not run` and counts them in the summary; blocking chain results only report the failing step.
- **Async dispatch**: A partial failure is delivered as a completed aggregate that keeps successful sibling output, and an orchestration failure becomes one failed completion message. No completion is emitted after session shutdown begins.

Session teardown (`quit`, `/new`, `/reload`, `/resume`, fork) aborts all detached dispatches, terminates active RPC children, awaits settlement, then clears runtime state. A completion from a replaced session is never delivered into the replacement session.

## Limitations

- **Shared working tree**: Parent and children share one working tree with no cross-process lock or merge; re-read files before editing (see [Shared working tree](#shared-working-tree))
- **Detached work is not resumable**: Still-running children are terminated on shutdown and are not restored across Pi restarts
- Output truncated to last 10 items in collapsed view (expand to see all)
- The 50 KB per-task model-visible output cap applies to parallel aggregate and async completion output only; single and chain blocking results are returned in full. Full results remain in tool/completion details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- Cooperative pause waits for the next turn/tool boundary; it is not hard process suspension
- Completed manager records are retained only as a bounded recent history
- `/px:agent:log` shows the task and final output; intermediate tool calls stay in the expanded tool result or completion view
