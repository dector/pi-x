# gust (pi extension)

TUI browser and worker orchestrator for [Gust](https://github.com/dector/gust)
comment threads, backed by `gust ctl comments`.

Each Gust comment is a thread: a root human request plus replies. The browser
lists threads, shows one in detail, and replies to / reviews / resolves it
through the real control socket. `/px:gust process` runs a deterministic
orchestrator that watches thread updates and drives one persistent Pi worker
session per thread.

## Requirements

- Gust running in the project directory with `--optin comments`:
  `gust -e '<app>' -p '?:?' --optin comments`.
- The socket is discovered from the current directory, so run Pi in the same
  directory Gust was launched from.
- Comments persist in a per-project state file and survive restarts.

## Commands

- `/px:gust` — open the thread browser.
- `/px:gust list` — open the live worker activity monitor.
- `/px:gust model` — choose the default model for **new** worker threads.
- `/px:gust process` — start the worker orchestrator.
- `/px:gust process stop` — stop it.
- `/px:gust status` — print a one-line status.
- `/gust hold [folder]` (also `/px:gust hold [folder]`) — toggle automatic reload coordination.

## Automatic reload hold

Opt in with `/gust hold`. Use `/gust hold docs` to discover the socket in
`./docs` instead of the current directory. Relative folders resolve from Pi's
cwd; absolute paths also work. The selected directory survives `/new` and
`/reload` with the toggle. `GUST_SOCKET` still overrides socket discovery.
Enabling without a folder uses the default directory (`GUST_CWD` or Pi's cwd).
Gust continues auto-reloading while Pi is idle.
When the agent starts working, the extension runs `gust ctl pause`. At
`agent_settled` (after all model/tool rounds and automatic continuations), it
runs `gust ctl resume`. Gust performs one catch-up reload if files changed;
there is no forced reload when nothing changed.

The toggle stays enabled across `/new`, session switches, and `/reload` in the
same Pi process. It is not saved to disk. Run `/gust hold` again to disable it.
Neo-bar shows a purple `󰖝` wind icon after the model/review label whenever
Gust is running in the project, even with hold disabled. The icon turns muted
yellow while automatic reloads are paused, and returns to purple on release.
It is hidden when Gust is unavailable. Detection has a 500 ms timeout and
refreshes every 3 seconds, plus after hold actions.
Orderly shutdown releases any pause owned
by the extension. An existing manual Gust pause is left untouched. The footer
shows `gust: hold` while enabled.

Requires Gust with `ctl status`, `pause`, and `resume` support. Uses the same
`GUST_CMD`, `GUST_CWD`, and `GUST_SOCKET` overrides as the comment browser.
Control failures produce warnings rather than stopping the agent.

V1 coordinates only the foreground agent in one Pi process per Gust instance.
Concurrent sessions, detached subagents, and comment workers are not covered.
Manual `gust ctl rerun` bypasses the hold. A Pi crash can leave Gust paused
(recover with `gust ctl resume`); restarting Gust resets its pause state.

## Worker orchestration

`/px:gust process` starts a deterministic, in-process orchestrator (no LLM of
its own). It blocks on `gust ctl comments watch --since <cursor>`, and for each
newly submitted thread it:

1. claims the thread with `gust ctl comments seen <id>`;
2. runs one worker as `pi --mode rpc --no-extensions --session-dir <dir>
   --session-id <id>`, which resumes the thread's existing session and posts
   the reply + `review` itself.

Workers run serially (one at a time) to avoid concurrent edits to the same
working tree, and headless (`--no-extensions`), so no extension dialog can block
them. A thread maps to one persistent session, so a later human reply resumes
the same worker context instead of starting over:

| Setting | Default |
| --- | --- |
| Session dir | `~/.pi/gust/sessions` (override `GUST_SESSION_DIR`) |
| Session id | `gust-<rootHash>-<threadId>` |

The footer shows the orchestrator phase and the widget lists tracked threads.
Inside the browser the counts line shows `workers <phase>▶<id>`, and `⚙` marks
the thread a worker is currently handling. Press `w` to start or stop workers
without leaving the browser.

## Live activity monitor

`/px:gust list` loads all Gust threads, even before workers start. Each row
shows the truncated starting/root message. `Enter` opens that thread's live
assistant text, tool calls, results and errors. Hidden reasoning is never shown.
Worker states are `idle`, `running`, `completed`, `failed` and `stopped`.
Threads with activity remain available even if removed from Gust's list.

| Key | Action |
| --- | --- |
| `j` / `k` or `↓` / `↑` | Select a thread, or scroll activity one line |
| `Enter` | Open selected thread activity |
| `gg` | Scroll to the start |
| `G` | Scroll to the end and follow live output |
| `shift+j` / `shift+k` (`J` / `K`) | Scroll activity five lines |
| `Esc` | Activity → thread list → close |

Output follows the tail while at the bottom. Scrolling up pauses following;
returning to the bottom resumes it. History is in-memory only, capped at 500
entries and 65,536 text characters per thread; oldest output is discarded. Closing the
monitor does not stop workers. History survives process stop/start within the
extension, but not extension/session shutdown.

## Worker models

`/px:gust model` lists available `provider/id` models plus **Inherit chat model**
(the default). Inheritance reads the foreground chat's current model when a
thread is first dispatched, not when the orchestrator starts. If no chat model
is available, the thread fails explicitly; choose a model before retrying.

The choice is a process-local default for **new threads only**; it is not saved
as global configuration. Each thread's first assignment is saved as a `.model.json`
sidecar in the worker session directory (`~/.pi/gust/sessions`, or
`GUST_SESSION_DIR`). Reopened threads retain that model across process restarts,
using `--provider` and `--model`. Legacy sessions without a sidecar keep their
existing session model rather than having today's default forced onto them.

## Invocation discovery

The client auto-detects how to call Gust and caches the first working one:

1. `GUST_CMD` (if set), e.g. `go tool gust` or `/usr/bin/gust`
2. `gust` on `PATH`
3. `go tool gust`

Overrides:

| Variable | Effect |
| --- | --- |
| `GUST_CMD` | Full invocation to use (skip detection). |
| `GUST_SOCKET` | Explicit socket path, passed as `ctl -S <socket>`. |
| `GUST_CWD` | Directory to run `ctl` from (defaults to the process cwd). |

## Layout

```
──────────────────────────────────────────────────────────────
 Gust comments  gust · (socket from cwd)          filter: all
 ✎ 0  ○ 2  ◐ 1  ● 1  ✓ 0   5 threads
──────────────────────────────────────────────────────────────
 ▌ ○ /docs/install  The install snippet…   │ /docs/install
   ○ /extensions/subagent  This paragraph… │ submitted · thread id 8f21a4
   ◐ /extensions  On narrow screens the…   │ created 2026-09-26 14:02
   ● /  Hero subtitle reads…               │ ▌ human  14:02
──────────────────────────────────────────────────────────────
 ↑↓ select · shift+j/k scroll · enter/r reply · …
```

The left pane lists unfinished threads (state glyph + page path + text
preview); the right pane shows the selected thread's meta, locator, captured
HTML, and message timeline. Below 84 columns it collapses to a single pane:
`enter` opens a thread, `esc` goes back.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓` or `k`/`j` | Move the selection |
| `shift+j` / `shift+k` | Scroll the thread pane |
| `enter` / `r` | Reply (as `human` by default) |
| `tab` | In the reply box: toggle the reply author (`human` / `agent`) |
| `s` | Agent reply and mark the thread `review` |
| `x` | Resolve the thread (`gust ctl comments done`, `y`/`n` confirm) |
| `g` | Refresh from Gust |
| `w` | Start/stop the worker orchestrator |
| `f` | Cycle the state filter (all → open → submitted → seen → review → done) |
| `esc` | Close, go back, or cancel |

Replies typed here are sent as `gust ctl comments reply <id> <text> --human`;
`tab` drops the flag for an agent reply. `s` always uses
`gust ctl comments review <id> <text>` (agent). A human reply to a `review`
thread reopens it as `submitted` and creates a fresh batch for the agent inbox.

## State glyphs

| Glyph | State | Meaning |
| --- | --- | --- |
| `✎` | `created` | Draft, not submitted — not work yet |
| `○` | `submitted` | Waiting for an agent |
| `◐` | `seen` | Claimed by an agent |
| `●` | `review` | Agent replied, waiting for the human |
| `✓` | `done` | Resolved by the human |

## Limitations / next steps

- Requires a Gust build with `comments --filter`, `comments seen`, and
  `comments watch`.
- The browser has no auto-refresh: press `g` to reload.
- The orchestrator serializes workers; per-thread `git worktree` isolation for
  real parallelism is a later step.
- The release build of Gust is required if you do not run it as a Go tool.

## Files

- `gust.ts` — `gust ctl` client (spawn, auto-detect, parse, `seen`, `watch`)
- `dialog.ts` — the TUI component
- `orchestrator.ts` — watch loop, thread reconciliation, serial dispatch
- `worker.ts` — per-thread Pi invocation, session id, prompt
- `types.ts` — `Thread` / `ThreadMessage` / `ThreadState` (mirror the ctl JSON)
- `index.ts` — command registration, hold lifecycle hooks, and status widget
- `hold.ts` — serialized pause ownership and process-local opt-in toggle
- `hold.test.ts` — hold lifecycle and failure tests
- `orchestrator.test.ts` — unit tests (`bun test`)
