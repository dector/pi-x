# proc (pi extension)

Runs and manages long-lived background processes for the agent. Start a dev server,
watcher, or build; read its output on demand; check exit status; and see what is
running in the Processes widget above the editor.

## Features

- `proc` tool for the agent: run, list, status, logs, stop, kill, write, forget.
- Processes run detached in their own process group, so stopping a process also
  stops its children (no orphaned `node`/`npm` holding ports).
- Ordered stdout/stderr ring buffer per process with independent read cursors:
  read only what is new since the last read, or replay from the start.
- Non-interactive Processes widget above the input editor: collapsed summary
  by default, expands to a bounded list while the `processes` panel is active.
- Processes survive `/reload`, `/new`, `/resume`, and `/fork`; they are stopped
  when pi quits.
- `safe-mode` integration: read-only actions auto-allow, mutations ask.

## Tool

Single umbrella tool `proc` with an `action` enum.

| action | args | description |
| --- | --- | --- |
| `run` | `command`, optional `name`, `cwd`, `env` | Start `bash -lc "<command>"` detached. Returns `{name, pid}`. |
| `list` | — | Table of all known processes. |
| `status` | `name` | Detail for one process, including the last 20 log lines. |
| `logs` | `name`, optional `from`, `lines`, `filter`, `wait` | Read buffered output. |
| `stop` | `name`, optional `signal` | SIGTERM the process group, escalate to SIGKILL after ~3s. |
| `kill` | `name`, optional `signal` | SIGKILL the process group immediately. |
| `write` | `name`, `input`, optional `newline`, `close` | Send text to the process stdin. |
| `forget` | `name` | Drop an exited process from memory. |

### Names

The short name is the id. It defaults to the command's first word (`npm run dev`
→ `npm`, `./serve.sh` → `serve`), sanitized to `[a-z0-9_-]`. Pass `name` to
override it. Collisions with a running process get a numeric suffix (`vite`,
`vite-2`). `run` with an explicit name that is already running fails; an exited
name is replaced.

### `logs`

- `from`: `"last"` (default) returns only lines after this reader's cursor;
  `"start"` returns the earliest retained lines; a number is random access.
- `lines`: max lines returned (default 200, max 2000).
- `filter`: `"out"` or `"err"`.
- `wait`: wait up to 0–30 seconds for new output before returning (default 0).

Output starts with a header, for example:

```text
proc=vite state=running pid=1234 cursor=812 dropped=0 more=true
out: VITE v5.4.0  ready in 320 ms
err: warn ...
```

`from:"last"` advances the `agent` cursor. `/px:proc logs` uses the separate
`user` cursor, so viewing logs by hand does not consume what the agent sees.

## Processes widget (panels)

`proc` publishes its non-interactive Processes content to the [`panels`](../panels/README.md)
coordinator. The coordinator renders all panels in a fixed order inside one
above-editor widget. `proc` no longer uses the `status-bar` extension.

The widget is **collapsed by default** to a single summary line with an expand
icon:

```text
   Processes (2 running, 1 exited) 󰕏
```

It expands while the `processes` panel is the active panel. The collapsed and
expanded states are driven by the [`panels`](../panels/README.md) contract:

- `proc` emits `px:panels:register` with
  `{ id: "processes", label: "Processes", order: 20, visible }`.
- `proc` emits `px:panels:visibility` with `{ id: "processes", visible }`
  whenever the panel's visibility changes (no visible process ↔ at least one).
- `proc` listens for `px:panels:active` with `{ activeId }` and expands only
  when `activeId === "processes"`.
- `proc` emits `px:panels:content` with its formatted lines and width renderer;
  the coordinator orders them independently of process refreshes.
- On `session_start` and `session_tree`, `proc` emits `px:panels:sync` to ask
  `panels` to replay its current active state.

Expanded output is bounded to 10 lines:

```text
   Processes (2 running, 1 exited)
  󰁚 vite  pid 48231  running  12s  +3
  󰄬 npm   pid 48255  exited   8s  code 0
```

Each process shows its name, pid, state, elapsed time, and details (exit code or
signal, plus an unread count). Status glyphs match the Subagents widget:
green arrow-circle for `running`, yellow pause-circle for `stopping`, gray
check for `exited (0)`, red close for `exited (non-zero/signal)`. The title
uses the same purple and left inset as Subagents. Running
processes are listed first, then exited by most recent end time. Exited
processes stay in the widget for `exitedRetentionMs` (default 60s), then drop
off; they remain in `list` until `forget`. When more processes are visible than
fit, the last line shows `… N more`.

The `proc` tool works without `panels`; the Processes widget requires it.

## Configuration

Optional global config at `~/.pi/agent/proc.json`:

```json
{
  "maxProcesses": 8,
  "logLines": 5000,
  "logBytes": 2000000,
  "exitedRetentionMs": 60000,
  "exitedCap": 20
}
```

- `maxProcesses` — concurrent running processes; `run` fails at the cap.
- `logLines` / `logBytes` — per-process ring buffer limits (whichever hits first).
- `exitedRetentionMs` — how long an exited process stays in the widget.
- `exitedCap` — how many exited processes are retained (oldest dropped first).

The retired `statusRow` option is still honored as a compatibility fallback:
`"statusRow": false` hides the Processes widget and keeps the panel out of the cycle.

## Safety

`safe-mode` classifies `proc` like its other tools:

- `list`, `status`, `logs` — read-only, auto-allowed in `reader`/`smart`.
- `run` — its `command` is re-validated with the bash classifier, so read-only
  commands auto-allow while mutating ones ask. A `cwd` outside the project root
  requires approval.
- `stop`, `kill`, `write`, `forget` — require approval in `reader`/`smart`.

## Commands

```text
/px:proc                                interactive process manager
/px:proc list                           plain-text list
/px:proc logs <name> [lines] [--start]  read logs (user cursor)
/px:proc stop|kill|forget [name]        manage a process
```

When `<name>` is omitted, a picker is shown.

### Interactive manager (`/px:proc`)

Opens a live view of all processes (refreshes every ~300ms).

```text
────────────────────────────────────────────────
Processes (2)
────────────────────────────────────────────────
▸ ● vite      running  pid 1234  12s      +3
  ● npm       exited   pid 1222  8s  code 0
────────────────────────────────────────────────
↑↓/j k navigate • enter logs • d stop/kill • esc close
```

- `↑`/`↓` or `j`/`k` — move the cursor.
- `enter` — open the scrollable log viewer for the selected process.
- `d` — delete: for a running process, asks `Stop "<name>"? (y/N)` first
  (`y` confirms, `n`/`esc` cancels), then stops it (SIGTERM, escalates to
  SIGKILL after ~3s) and removes it from the list once it exits. An already
  exited process is removed immediately (same as `forget`).
- `esc` or `q` — close the manager.

Inside the log viewer:

- `↑`/`↓` or `j`/`k` — scroll one line.
- `pageUp`/`pageDown` — scroll a page.
- `g`/`home` and `G`/`end` — jump to the top or bottom. New output follows
  automatically while at the bottom.
- `esc` or `q` — return to the process list.

Viewing logs in the manager reads the buffered lines directly, so it does not
consume what the agent sees.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/proc/`
- Project-local: `.pi/extensions/proc/`

Dependencies:

- `panels` extension for the Processes widget and panel shortcuts

Then run `/reload`.
