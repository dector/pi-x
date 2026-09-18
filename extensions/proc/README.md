# proc (pi extension)

Runs and manages long-lived background processes for the agent. Start a dev server,
watcher, or build; read its output on demand; check exit status; and see what is
running in the status bar.

## Features

- `proc` tool for the agent: run, list, status, logs, stop, kill, write, forget.
- Processes run detached in their own process group, so stopping a process also
  stops its children (no orphaned `node`/`npm` holding ports).
- Ordered stdout/stderr ring buffer per process with independent read cursors:
  read only what is new since the last read, or replay from the start.
- Own status-bar row: `● vite 48231  ·  ● npm 48255`.
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

## Status bar

Requires the [`status-bar`](../status-bar/README.md) extension and its
`px:status-bar:row:*` contract. `proc` publishes one extra footer row:

```text
● vite 48231  ·  ● npm 48255
```

The dot is colored by state: green `running`, yellow `stopping`, gray
`exited (0)`, red `exited (non-zero/signal)`. Running processes are listed
first. Exited processes stay in the row for `exitedRetentionMs` (default 60s),
then drop off; they remain in `list` until `forget`. If the row is too long it
shows at most 6 items plus `+N more`.

`proc` works without `status-bar`; it only loses the row.

## Configuration

Optional global config at `~/.pi/agent/proc.json`:

```json
{
  "maxProcesses": 8,
  "logLines": 5000,
  "logBytes": 2000000,
  "exitedRetentionMs": 60000,
  "exitedCap": 20,
  "statusRow": true
}
```

- `maxProcesses` — concurrent running processes; `run` fails at the cap.
- `logLines` / `logBytes` — per-process ring buffer limits (whichever hits first).
- `exitedRetentionMs` — how long an exited process stays in the status-bar row.
- `exitedCap` — how many exited processes are retained (oldest dropped first).
- `statusRow` — set `false` to disable the status-bar row.

## Safety

`safe-mode` classifies `proc` like its other tools:

- `list`, `status`, `logs` — read-only, auto-allowed in `reader`/`smart`.
- `run` — its `command` is re-validated with the bash classifier, so read-only
  commands auto-allow while mutating ones ask. A `cwd` outside the project root
  requires approval.
- `stop`, `kill`, `write`, `forget` — require approval in `reader`/`smart`.

## Commands

```text
/px:proc                                list processes
/px:proc logs <name> [lines] [--start]  read logs (user cursor)
/px:proc stop|kill|forget [name]        manage a process
```

When `<name>` is omitted, a picker is shown.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/proc/`
- Project-local: `.pi/extensions/proc/`

Dependencies:

- `status-bar` extension for the process row (optional but recommended)

Then run `/reload`.
