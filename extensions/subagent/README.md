# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Async by default**: Dispatches run detached in the background; the parent turn returns as soon as the request is accepted
- **Automatic completion**: One aggregate `subagent-completion` message is injected when the whole dispatch settles — immediately when the parent is idle, as a follow-up when it is busy
- **Explicit blocking**: `execution: "blocking"` streams progress and waits for the final result in the same turn
- **Blocking → background**: An attached blocking dispatch can be moved to the background mid-turn from `/px:agents` → `Detach`; the same child keeps running and its result arrives later as one completion
- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: Blocking dispatches stream tool calls and progress as they happen
- **Parallel streaming**: Blocking parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C aborts blocking children; detached children are aborted by the `action: "stop"` tool control, from `/px:agents`, or on session shutdown
- **Model-driven controls**: the `subagent` tool accepts `action: "stop"` or `action: "steer"` addressed by dispatch id or run id, so the parent model can abort or redirect running children without shell-killing processes
- **Inherited permissions**: Each dispatch snapshots the parent's safe mode, outer-access setting, and configured network policy when it is prepared, before an async dispatch is accepted
- **Restricted-agent gate**: Agent names matching a global pattern require one timed parent confirmation per dispatch
- **Approval relay**: Child dialogs are labeled and serialized through the parent UI, even while detached
- **Runtime controls**: `/px:agents` can inspect, pause, resume, abort, or reconfigure a running child
- **Bounded delegation**: `/px:agents:config` controls whether delegation is disabled, top-level only, or recursively available with a finite depth budget
- **Session rewiring**: `/px:agents:rewire` can silently replace every subagent profile's model and effort for the current session without editing agent files
- **Active widget**: While children run, a non-interactive two-line list above the input editor shows each active subagent's state, elapsed time, turns, model/effort, usage, readable id, and task preview
- **Opt-in Herdr backend**: Pass `herdr: {}` to run a dispatch in a reusable Herdr pane owned by the parent session, with failed-pane retention by default, explicit `retain: "always"`, and `Jump to Herdr pane` from `/px:agents` (see [Herdr backend](#herdr-backend-opt-in))
- **Run log**: `/px:agent:log` shows each run's original task prompt and final output, including detached runs after resume

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── prepare.ts           # Validation, permission, and ID allocation before execution
├── restricted-agent-policy.ts # Pure pattern matching, tier ranking, and config parsing
├── restricted-agent-config.ts # Loads the global ~/.pi/agent/subagent.json policy
├── restricted-agent-approval.ts # Timed parent confirm prompt for restricted dispatches
├── dispatch.ts          # Shared single/parallel/chain orchestration runner
├── lifecycle.ts         # Unified dispatch ownership: attached blocking, detach-to-background, exactly-once delivery
├── completion.ts        # Canonical acknowledgement/completion formatting and truncation
├── rpc-client.ts        # RPC process transport and JSONL framing
├── approval-queue.ts    # Global serialized child-dialog queue
├── control.ts           # Child permission and cooperative pause controls
├── control-ops.ts       # Tool-level stop/steer control ops (validation + execution)
├── backend.ts           # Backend boundary: direct process plus the Herdr pane bridge
├── herdr-client.ts      # Typed Herdr socket API adapter and exact pane focus
├── herdr-preflight.ts   # Herdr detection, validation, and bridge launch
├── herdr-tab.ts         # Parent-owned Herdr tab, pane leasing, retention, cleanup
├── herdr-bridge.ts      # Parent-side authenticated Unix-socket bridge
├── herdr-bridge-main.ts # Pane-side bridge entry point and transcript renderer
├── run-stop.ts          # Per-run stop escalation (cooperative abort -> forced termination)
├── registry.ts          # Active/recent run registry
├── result-output.ts     # Canonical per-result output extraction (shared with tool results)
├── run-id.ts            # Restart-safe unique run IDs
├── agent-log.ts         # Pure merge/format helpers for `/px:agent:log`
├── status-row.ts        # Pure formatter for the active-subagents panel content
├── panels.ts            # `px:panels:*` integration: active -> collapsed, Watch suppression
├── safe-mode.ts         # Safe-mode snapshot query and child argv
├── network-policy.ts    # Configured network-policy snapshot query and child argv
├── timing.ts            # Per-run timing breakdown
├── events.ts            # RPC stream-event application to `SingleResult`
├── types.ts             # Shared dispatch/result types
├── fixtures/            # Test fixtures (fake RPC child, legacy contracts)
├── agents/              # Sample agent definitions (stable <role>-<tier> profiles)
│   ├── scout-fast.md    # Fast recon, returns compressed context (flash, low)
│   ├── scout-xfast.md   # Fastest recon (flash, minimal)
│   ├── planner-fast.md  # Creates implementation plans (flash, high)
│   ├── planner-strong.md # Stronger implementation plans (gpt-5.6-sol, medium)
│   ├── planner-ultra-explicit.md # Deep ultra plan (gpt-5.6-sol) — only on explicit request
│   ├── reviewer-fast.md # Code review (flash, high)
│   ├── reviewer-xfast.md # Fast code review (flash, minimal)
│   ├── reviewer-strong.md # Strong code review (gpt-5.6-sol, high)
│   ├── reviewer-ultra-explicit.md # Deep adversarial review (gpt-5.6-sol) — only on explicit request
│   ├── reviewer-xultra-explicit.md # Deepest adversarial review (gpt-5.6-sol, xhigh) — only on explicit request
│   ├── researcher-fast.md # Web + local research with citations (flash, high)
│   ├── researcher-strong.md # Strong research with citations (gpt-5.6-sol, high)
│   ├── worker-fast.md   # General-purpose (flash, high)
│   ├── worker-xfast.md  # Fast general-purpose (flash, minimal)
│   └── worker-strong-explicit.md # Strong general-purpose (gpt-5.6-sol, medium) — only on explicit request
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout-fast -> planner-fast -> worker-fast
    ├── scout-and-plan.md    # scout-fast -> planner-fast (no implementation)
    └── implement-and-review.md  # worker-fast -> reviewer-fast -> worker-fast
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

- `safe-mode` for child permission inheritance (optional)
- `permissions-core` for child network-policy inheritance (optional)
- [Bun](https://bun.sh) on `PATH` when using the opt-in Herdr backend (the pane bridge runs on Bun)

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

Children use pi RPC mode. Project-agent approval happens before an async dispatch is accepted, so a denied request never starts detached work. Child safe-mode approvals appear in the parent UI with the agent name and stable run ID, and can appear while you are chatting with the parent. Dialogs are serialized globally, one at a time. In a non-interactive parent, requests fail closed instead of hanging. While a relayed approval/input dialog is open the parent declares a hub user wait, so the Herdr pane/tab reports `blocked` (needs attention) instead of `working`.

Safe mode is captured when a dispatch is prepared, before an async dispatch is accepted. Parent changes only affect dispatches prepared later. Session-only approvals remain local to the child that received them; project-persistent approvals continue to use the repository allowlist.

The parent's configured network policy is captured at the same moment and passed to every child as `--network-policy <setting>`, so a child does not silently fall back to Auto while the parent runs `allow-all`. Only the configured choice is inherited, never the parent's already-derived effective policy, so the child still applies its own Auto derivation and PARANOID override. The snapshot is a bounded, read-only query of the `px:permissions-core:net:state:*` contract (never the hub): if permissions-core is absent, slow, or answers with anything but a valid configured policy, the flag is omitted and the child keeps its own Auto default. A failed query never inherits `allow-all`. Nested subagents behave the same way, because a child answers the same state contract with the policy it inherited itself.

### Restricted agents

Expensive or explicit-only profiles must not be auto-selected by the model. A name gate asks the parent user to confirm any dispatch that names a restricted agent. Defaults: every `*-strong` and `*-explicit` agent, with a 15-second prompt timeout.

The policy is global user policy, read only from `~/.pi/agent/subagent.json` (the same agent directory used for global agents). Project-local config is never consulted, so a repository cannot loosen it. The file is optional:

```json
{
  "restrictedAgentPatterns": ["*-strong", "*-explicit"],
  "restrictedAgentPromptTimeoutSeconds": 15
}
```

- `restrictedAgentPatterns` is a list of globs (`*` matches any run of characters including `-`, `?` matches exactly one).
- `restrictedAgentPromptTimeoutSeconds` is the confirm-dialog timeout in seconds.

A missing, unreadable, or invalid-JSON file uses the defaults. Invalid individual fields fall back to that field's default. An explicit `restrictedAgentPatterns: []` is valid and disables the gate entirely.

Dispatch behavior:

- One dialog covers the whole dispatch, whether single, parallel, or chain. Approval is for that dispatch only and is never remembered, so the next dispatch prompts again.
- The dialog lists the requested restricted names, the matching patterns, and the allowed alternatives, preferring same-family names (cheapest tier first).
- Denial, timeout, or a session without UI rejects the entire dispatch and returns the allowed alternatives. Nothing starts: no child, no run or dispatch id, no Herdr preflight, and no automatic substitution to an alternative.
- The gate runs after project-agent approval and is independent of safe mode; `yolo` and other safe-mode settings do not bypass it.

**Limitation:** this is a name-routing guard, not model or cost enforcement. It only restricts agent names that match a pattern; a custom agent with a cheap-looking name can still be configured to use an expensive model.

## Shared working tree

Parent and children share one working tree. Async editing agents are supported and run by default, but there is **no cross-process lock or merge**: the parent and several children can write the same files concurrently.

The `withFileMutationQueue` used for internal temp-file writes only serializes mutations inside the parent process. Children are separate processes, so it does not serialize their edits against each other or against the parent.

Mitigations in place:

- The async acknowledgement and completion details include the working directory.
- The acknowledgement tells the parent model to re-read affected files before editing them.
- Exact-edit failures surface unchanged instead of being hidden.

Re-read files before editing after a child may have touched them. Automatic worktrees, file ownership, and conflict resolution are out of scope.

## Progress relay

When the parent hub has the `progress` tool registered, a restricted-tool
agent gets `progress` appended to its explicit `--tools` list, so a child can
report semantic milestone progress even with a narrow tool set. Every child
also receives shared system-prompt guidance: only use progress when its task
explicitly supplies `trackerId`, `trackerToken`, and an assigned leaf `chunkId`;
mark that leaf active and then terminal; never mutate a container or another
leaf, and never start/finish/clear the parent tracker; and describe relay
delivery as best-effort rather than claiming parent acceptance. Without all three IDs the
child does not report parent progress. Without the parent tool the original
tool list and system prompt are unchanged, and installing `subagent` does not
depend on hub.

A child runs in a separate process, so its `progress` tool cannot reach the
parent hub directly. It serializes each mutation into a `px:hub-progress-relay`
extension UI `setStatus` request. The subagent extension recognizes that exact
status key, validates the versioned envelope, and re-emits the mutation on the
parent bus (forcing the relayed owner to `progress-tool`). The parent hub then
applies its normal validation and acknowledgement.

- **Best-effort**: `setStatus` is fire-and-forget, so the child is told only
  that a valid envelope reached the parent transport. It never learns whether
  the parent hub accepted the transition, and must not claim parent acceptance.
- **Not cleared on child exit**: relayed data is semantic milestone state, not
  child presence. A child may mark a leaf `done` immediately before exiting and
  run cleanup must not erase it. If a child fails while its leaf is still
  `active`, the coordinating parent reports that leaf `blocked` or `failed`
  after observing the result.
- **Immediate child only**: a grandchild relays to its own parent process, never
  to the root. The middle agent reports its assigned leaf after its nested
  work settles.
- Malformed JSON, wrong version, non-allowlisted channels, and oversized text
  (over 256 KiB UTF-8) are ignored; at most one concise diagnostic is recorded
  per run and a bad relay never crashes the run. Raw relay payloads are never
  logged or displayed.

## Herdr backend (opt-in)

Subagents run as direct `pi --mode rpc` processes by default. Pass an optional
`herdr` object to run a dispatch instead in a pane of one reusable Herdr tab
owned by the parent Pi session. The object's presence is the explicit opt-in;
there is no automatic fallback and no config key.

```ts
// Herdr backend. A successful pane can be recycled; a failed pane is retained.
{ agent: "worker-fast", task: "Implement it", herdr: {} }

// Keep the pane after success too.
{ agent: "reviewer-fast", task: "Review it", herdr: { retain: "always" } }
```

`herdr` is a per-dispatch user intent. It cannot be set in agent definition
files, and it is rejected on `action: "stop"` / `action: "steer"` control
calls because it describes a new dispatch rather than a control operation.

Detached dispatches hold the parent Herdr pane in `working` until they settle,
through the `herdr:background` lease consumed by the `herdr-agent-state` fork
(see `extensions/subagent/herdr-background.ts`). The official Herdr Pi
integration ignores that event, so the pane still looks done there.

### Retention

| `herdr` | successful pane | failed / aborted pane |
|---------|-----------------|-----------------------|
| omitted | direct process (no pane) | direct process (no pane) |
| `{}` | recycled into the tab's idle pool | retained in Herdr |
| `{ retain: "always" }` | retained in Herdr | retained in Herdr |

A retained pane is never reused automatically. It keeps the terminal
transcript and a concise final summary; the recorded subagent result and
`/px:agent:log` remain authoritative. If every pane in the tab is retained, the
next run creates another split — that growth is intentional because retention
was requested explicitly.

### Shared parent tab

One Herdr tab is created lazily per parent Pi session and reused for every
Herdr dispatch from that session. Ownership is bound to
`HERDR_SOCKET_PATH + HERDR_PANE_ID + PI_SESSION_ID` and recorded both as
machine-readable Herdr pane tokens and as a small state record under Pi's state
directory. The tab label is `Subagents · <short-parent-pane> · <short-pi-session>`.

Panes are leased to runs:

- the first run uses the tab's root pane;
- concurrent runs split balanced leaves in the same tab, always with `--no-focus`;
- a chain reuses one pane sequentially while that pane is idle;
- at most one idle pane is kept, so the tab stays alive without accumulating shells;
- every pane is labeled `<agent> · <short-run-id>`.

### Jump and close from `/px:agents`

A Herdr-backed run adds `Jump to Herdr pane` to its manager menu, for both
active and retained completed runs. It validates the recorded tab/pane against
live Herdr state, focuses the exact pane, then returns from the menu. A pane the
user closed manually is reported as missing and its stale location is cleared; a
missing pane is never recreated just because Jump was selected.

A retained completed run also offers `Close retained pane`. It confirms first,
closes only an extension-owned retained pane, and preserves the subagent result
and log. A Herdr run's Details view adds `Backend`, `Herdr tab`, `Herdr pane`,
`Retention`, and a live `Pane status` (`active` / `retained` / `missing`).

### Security

A pane cannot share the parent extension's stdin/stdout pipes, so the parent
creates a private `0700` temporary directory containing a `0600` one-time token,
launches a small Bun bridge in the pane, and authenticates it over a Unix domain
socket before sending anything. The bridge then spawns the same `pi --mode rpc`
command and environment the direct backend uses and relays framed JSONL.

- only safe bootstrap arguments (`--socket`, `--token-file`) reach the pane
  command line; task text, prompts, and Pi arguments travel over the authenticated socket;
- tokens are unpredictable and consumed once; message sizes and diagnostics are bounded;
- the pane renders a concise activity transcript, never raw protocol JSON;
- prompts, secrets, and large model output are not dumped into the terminal by default.

### Reload and shutdown

- `/reload` rediscovers and reuses the same owned tab while `PI_SESSION_ID` is unchanged;
- `/new` or `/resume` cannot adopt the previous session's tab because the session id is part of ownership;
- shutdown stops active children through the normal lifecycle first, then closes the owned tab only when it has no explicitly retained panes; retained panes leave the tab in Herdr for the user;
- startup cleanup removes persisted records that provably no longer point at an owned tab, but never closes a tab or pane that lacks verified ownership.

### Herdr limitations

- Herdr is explicit and non-default. Opting in without a usable Herdr environment fails before the async dispatch is accepted, with no fallback to direct execution.
- Detached work is not resumable after the parent Pi process exits; retained panes preserve terminal evidence, not a live model session.
- Remote Herdr machines and automatic worktrees are out of scope.
- The pane transcript is a concise view; the Pi session result and `/px:agent:log` are authoritative.

## Usage

By default every dispatch is **async**: the `subagent` tool returns a dispatch id and run ids immediately, and the aggregate completion arrives later. Add `execution: "blocking"` when the current turn needs the result before it can continue.

### Single agent
```
Use scout-fast to find all authentication code
```

### Blocking agent
```
Use worker-fast to implement the validation change, execution: blocking
```

### Herdr pane (opt-in)
```
Use worker-fast to implement the validation change, herdr: {}
Use reviewer-fast to review it and keep the pane, herdr: { retain: "always" }
```

### Parallel execution
```
Run 2 scout-fast agents in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout-fast find the read tool, then have planner-fast suggest improvements
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

An attached blocking dispatch can be detached from `/px:agents` ("Detach"): the existing child keeps running without restarting, the tool call returns an acknowledgement instead of waiting, and the aggregate arrives later as exactly one `subagent-completion` message. Detaching after the dispatch already settled is a no-op and reports that there is nothing to detach.

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

## Delegation depth

Delegation defaults to depth `0`, which allows the main agent to start subagents but does not expose the `subagent` tool inside those children. Use `/px:agents:config` to change the policy for the current session:

- `-1` disables all new subagent dispatches;
- `0` allows top-level dispatches only;
- `1+` allows that many additional recursive delegation levels.

Every child receives its parent's budget minus one. Existing children keep the budget they received; menu changes affect later dispatches. In border mode the status bar renders compact, single-color indicators immediately after network, with one space after the icon: muted `󰚩 ×` when disabled, frame-colored `󰚩 ✓` for top-level-only, and warning-colored `󰚩 N` for recursive delegation. Legacy mode uses the same spacing and colors the full label using the corresponding state color.

Set `PI_SUBAGENT_MAX_DEPTH=-1|0|N` before starting Pi to change the initial policy. The value is clamped to `-1..8`; invalid or missing values default to `0`. Session menu changes survive `/reload` for that session but are not persisted across Pi restarts.

## Session model rewiring

Run `/px:agents:rewire` to configure one model and effort for all subagents. The menu shows `Rewire   [OFF]` in muted text while disabled and `Rewire   [ON]` in red while enabled; it also has `Inherit model` and `Inherit All` mode toggles. `  Configuration` opens the model, effort, and preset selectors, and the model selector includes both inherited targets. Selecting an inherited target activates it immediately; the `Rewire` toggle can still turn it off. `Inherit model` follows the parent model while keeping the configured effort, and `Inherit All` follows the parent model and effort. `Inherit All` takes priority if both modes are present. While enabled, a muted bottom row shows the active target, such as `Rewiring to Inherit All` or `Rewiring to <model> · <effort>`.

Rewire presets are stored globally in `~/.pi/agent/subagent-rewire-presets.json`. Configuration shows `Presets (N)` first, where `N` includes the two built-in `Inherit model` and `Inherit All` entries; the other entries are stored user presets. In the preset list, press `n` to create a preset by selecting its model and effort, `d` to delete the preset under the cursor after confirmation (the built-in Inherit entries cannot be deleted), or `enter` to apply one to the current rewire configuration. The most recently applied user preset supplies the initial model and effort in later sessions and is preselected when creating another preset.

When enabled, the configured values override each agent file's `model` and `thinking` fields. Select `Inherit model` to keep the configured effort while detecting the parent's active model, or `Inherit All` to detect both the parent's model and effort at the moment each subagent starts. This is resolved per child, so queued chain steps and parallel work can follow model changes made after the dispatch was accepted. The status bar shows a red `󰚩 󰒟 <provider>/<model> · <effort>` before the skills counter and applies the status bar's provider/model aliases; `Inherit model` keeps the configured effort in the status label, while `Inherit All` displays only `󰚩 󰒟 Inherit`. Agent identity, prompt, tools, permissions, and routing are unchanged. A fresh session starts disabled; its process-local setting survives `/reload` but not a Pi restart, and agent definitions are never modified. A dispatch snapshots the setting when it is accepted, so later menu changes affect only later dispatches.

## Runtime manager

Run `/px:agents` to list active and recent children, async and blocking alike. Runs are grouped into **batches by dispatch**: each dispatch renders one header (`󰚩 dp_… · 󱐋 async · 2 runs`) followed by its runs, and active batches sit above settled batches separated by one blank non-selectable line. The header shows the dispatch id, execution mode, run count, `detached` when backgrounded, and a roll-up status glyph with elapsed time; each run row is prefixed by its status glyph. Dispatch-less runs stay flat. In the list: `↑`/`↓` (or `j`/`k`) move, `enter` opens the run's action menu, `d` attaches/joins the selected run (a completed persisted run opens its read-only transcript), `D` detaches the selected attached blocking dispatch, and `esc` closes. An ineligible `d`/`D` keeps the list open and shows a short warning. When there are no runs to show, the manager still opens and displays a muted `No agents running…` message instead of a toast.

Status glyphs are Nerd Font Material Design, shared by the list and the above-editor widget (see `manager-icons.ts`):

| State | Glyph | Meaning |
| --- | --- | --- |
| running | 󰁚 `U+F005A` | actively working |
| paused | 󰏦 `U+F03E6` | `pause-requested` / `paused` / `resuming` / `aborting` |
| waiting approval | 󱈸 `U+F1238` | blocked on a parent approval |
| finished | 󰄬 `U+F012C` | completed successfully |
| failed | 󰅖 `U+F0156` | failed |
| canceled | 󰜺 `U+F073A` | aborted |
| async | 󱐋 `U+F140B` | detached/background dispatch |
| blocking | 󰥿 `U+F097F` | attached blocking dispatch |

Select a run to:

- watch a live transcript/progress stream in a read-only floating panel without changing dispatch ownership or execution mode. The panel draws a rounded purple frame titled with the agent id, with one terminal-background cell of spacing outside the frame, and sizes itself to the 70%-of-terminal cap the host applies so the frame is never truncated; `j`/`k` scroll one line and `Shift+j`/`Shift+k` scroll five;
- attach to the full transcript with steering and run controls;
- inspect its task, PID, state, working directory, diagnostics, execution mode, dispatch id, and inherited/effective mode;
- configure that child's safe mode and outer access;
- request cooperative pause or resume;
- abort it after confirmation. For a detached/async child this aborts its owning dispatch, so the final completion is recorded as aborted and remaining chain/parallel work is stopped. An attached blocking child is aborted per-run, so its parallel siblings keep running;
- detach an active blocking dispatch ("Detach") so the same child keeps running in the background and its result arrives later as one completion.

Run IDs use short session-unique animal names such as `ag_shy-lion`. Dispatch IDs use geographic names such as `dp_snowy-mountain`. Used names stay reserved for the session, including across `/reload`, so neither form needs a random suffix.

Pause takes effect at the next safe boundary, before a provider turn or tool call. It does not interrupt a provider request or tool already in progress, so the state may remain `pause-requested` briefly.

## Tool-level controls

The parent model can stop or steer a running dispatch through the same `subagent` tool, so it never needs to shell-kill a child (which would leave `/px:agents` stale). A control call sets `action` and addresses exactly one of:

- `dispatchId` — every active run of that dispatch;
- `runId` — one child.

| `action` | target | behavior |
|----------|--------|----------|
| `stop` | dispatch | Aborts the detached controller (or every active run for a blocking dispatch). The normal aggregate completion still arrives, marked `aborted`. Repeating `stop` forces termination. |
| `stop` | run | Aborts just that child. Sibling runs continue; for an async dispatch the aggregate status reflects the aborted child. Repeating `stop` forces termination. |
| `steer` | dispatch | Delivers `message` to every active run over the child's native RPC `steer`. |
| `steer` | run | Delivers `message` to that child. |

The first `stop` asks the child to abort cooperatively; if it does not settle within a bounded grace period, the run is force-terminated so its registry entry cannot stay stale. `steer` requires a non-empty `message`. A control call cannot also include any dispatch field (`agent`, `task`, `tasks`, `chain`, `execution`, `cwd`, `agentScope`, `confirmProjectAgents`); omit `action` for a normal dispatch. A partial dispatch steer is reported as success plus the run ids that could not be reached.

Pi 0.85.1 only marks a tool result as an error when `execute` throws, so a control call that names no live target, or whose steers all fail, throws with a model-visible diagnostic. Unknown, finished, and pruned targets therefore surface as errors instead of silently starting work.

## Active subagents widget

While at least one child is running, `subagent` publishes a non-interactive
panel immediately above the input editor. It never calls `ctx.ui.setWidget`
itself: it emits `px:panels:content` with its formatted lines and a width
renderer, and the [panels coordinator](../panels/README.md) draws every panel
into the single `px-panels` widget. Detached async children keep the panel
visible until their dispatch settles; the content is cleared when the last child
finishes and on `session_shutdown`.

The coordinator owns `Alt+P` (forward) and `Alt+Shift+P` (reverse), which cycle
every registered panel and then collapse them all. The subagent panel registers
as id `subagents`, order `10`. Every panel starts collapsed, so the widget shows
a one-line summary until the user selects `subagents`; while another panel (for
example `processes`) is active the summary stays collapsed. After the selected
panel disappears, all panels stay collapsed until the user presses a cycle key;
a later subagent run does not auto-expand it. Opening a floating Watch panel
temporarily suppresses the widget; closing it re-derives the state from the
coordinator's current selection, so a cycle change made while Watch was open is
not undone.

```text
󰚩  Subagents (1 active, 1 finished)
 ● [red-panda-00k3w9fz2q] · worker-fast · openai/gpt-5 (minimal)
 │ running 34s, 3 turns · ctx:10% $0.0266
 │ Implement validation and update the related tests…
 ✓ [calm-otter-01ab4cd9xy] · researcher-fast · openai/gpt-5 (low)
 │ finished 12s
 │ Check API behavior
```

The bold title uses the Nerd Font robot glyph and the theme's purple
thinking-level brand color. The first run line contains the state icon, run id,
agent, model, and effort. Runtime details follow, then the task preview on one
dim line. The `│` border, run id, separators, activity, and task text use
the theme's dim color. Agent, model, and effort use the brighter muted color.
Running and successful icons use success, waiting and canceled icons use
warning, failed icons use error, and a starting icon uses muted. While any run
in a dispatch is alive, its successful, failed, and canceled siblings remain
listed and are counted separately in the title. The whole dispatch disappears
when its last live run settles.

Fields and complete lines are capped to keep the widget compact. Truncation
works on Unicode code points so it does not split a surrogate pair. Pi limits
each widget to 10 lines. The formatter keeps complete run blocks and reserves
a final dim `… N more` line when every visible run cannot fit.

The display refreshes on registry changes (start/complete) and on progress
updates (state, waiting approval, model, and usage). While at least one run is
active the widget also owns one bounded one-second timer that re-renders
elapsed time during silent periods; the timer stops when the last run settles
and on `clear()`/`reset()`, so it cannot leak. `session_tree` resets the dedup
state and forces a republish so a restored tree is never hidden by an
unchanged snapshot.

### TUI mode behavior

- **Regular mode (default)**: the widget sits at the live bottom, just above
the editor. New messages push history up, and scrolling into terminal history
naturally hides the widget.
- **Fullscreen mode**: the editor dock is sticky, so the widget stays visible
while the transcript scrolls.

Pi does not expose transcript scroll position to extensions, so hiding the
widget while scrolling in fullscreen mode is not reliably implementable. The
widget is intentionally non-interactive; use `/px:agents` to inspect and control
runs.

`subagent` no longer publishes a `status-bar` row, so `status-bar` is not
required for this feature.

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

**Async acknowledgement**: The `subagent` tool result for a detached dispatch is a short `started in the background` note listing the dispatch id, run ids, tasks, and working directory. When a blocking dispatch is detached mid-turn the same shape is returned, but the text says it was detached and continues in the background. It is not a result. Live progress stays in the active-subagents widget and `/px:agents`.

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

Each role ships as a family of stable `<role>-<tier>` profiles. The `-fast`
profiles are the everyday defaults used by the workflow prompts; `-xfast` trades
reasoning for speed, `-strong` uses `gpt-5.6-sol`, and the `-explicit` profiles
are opt-in only (see below). The table lists the original sample-agent name for
each renamed profile; newly added profiles have a blank Existing name.

| Existing name | New name | Model | Thinking/Effort |
|---------------|----------|-------|-----------------|
| `scout` | `scout-fast` | `opencode-go/deepseek-v4.1-flash` | low |
|  | `scout-xfast` | `opencode-go/deepseek-v4.1-flash` | minimal |
| `planner` | `planner-fast` | `opencode-go/deepseek-v4.1-flash` | high |
|  | `planner-strong` | `openai-codex/gpt-5.6-sol` | medium |
|  | `planner-ultra-explicit` | `openai-codex/gpt-5.6-sol` | high |
| `worker` | `worker-fast` | `opencode-go/deepseek-v4.1-flash` | high |
|  | `worker-xfast` | `opencode-go/deepseek-v4.1-flash` | minimal |
|  | `worker-strong-explicit` | `openai-codex/gpt-5.6-sol` | medium |
| `reviewer` | `reviewer-fast` | `opencode-go/deepseek-v4.1-flash` | high |
|  | `reviewer-xfast` | `opencode-go/deepseek-v4.1-flash` | minimal |
|  | `reviewer-strong` | `openai-codex/gpt-5.6-sol` | high |
| `ultra-reviewer-explicit` | `reviewer-ultra-explicit` | `openai-codex/gpt-5.6-sol` | high |
|  | `reviewer-xultra-explicit` | `openai-codex/gpt-5.6-sol` | xhigh |
| `researcher` | `researcher-fast` | `opencode-go/deepseek-v4.1-flash` | high |
|  | `researcher-strong` | `openai-codex/gpt-5.6-sol` | high |

Explicit-only profiles (`worker-strong-explicit`, `planner-ultra-explicit`,
`reviewer-ultra-explicit`, and `reviewer-xultra-explicit`) must never be
auto-selected. Only route to them when the user's own words explicitly ask for a
strong worker, an ultra plan, or an ultra/xultra review.
Use `planner-fast`/`planner-strong` for ordinary plans and
`reviewer-fast`/`reviewer-strong` for ordinary reviews.

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout-fast → planner-fast → worker-fast |
| `/scout-and-plan <query>` | scout-fast → planner-fast |
| `/implement-and-review <query>` | worker-fast → reviewer-fast → worker-fast |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: Aborting asks the child to stop, then terminates it with bounded escalation
- **Chain mode**: Stops at the first failing step and reports which step failed. The async completion message lists later unstarted steps as `not run` and counts them in the summary; blocking chain results only report the failing step.
- **Async dispatch**: A partial failure is delivered as a completed aggregate that keeps successful sibling output, and an orchestration failure becomes one failed completion message. No completion is emitted after session shutdown begins.
- **Control calls**: `action: "stop"`/`"steer"` requires exactly one of `dispatchId`/`runId`, and `steer` requires `message`. A control call rejects dispatch fields. Unknown, finished, or pruned targets throw a tool error instead of starting work, matching Pi 0.85.1's throw-to-signal-error contract. A repeated `stop` escalates to forced termination, and a first `stop` escalates on a bounded grace timer, so the registry cannot stay stale.

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
- Herdr-backed runs add the constraints above: explicit opt-in only, no fallback, no resumable detached work, and retained panes are terminal evidence rather than a live session
