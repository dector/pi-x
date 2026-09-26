# gust (pi extension)

TUI browser for [Gust](https://github.com/dector/gust) comment threads, backed
by `gust ctl comments`.

Each Gust comment is a thread: a root human request plus replies. The browser
lists unfinished threads, shows one in detail, and replies to / reviews /
resolves it through the real control socket.

## Requirements

- Gust running in the project directory with `--optin comments`:
  `gust -e '<app>' -p '?:?' --optin comments`.
- The socket is discovered from the current directory, so run Pi in the same
  directory Gust was launched from.
- Comments live in Gust's memory: if Gust exits, they are gone.

## Command

- `/px:gust` — open the thread browser.

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
| `w` | Dispatch a worker — not wired yet |
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

- Requires a Gust build with `comments --filter` (the browser asks for
  `--filter all` to include resolved threads).
- No auto-refresh: press `g` (Gust has no push channel; `comments --wait`
  blocks and would occupy the UI).
- `w` is a placeholder. The next step is spawning one async `pi` subagent per
  thread, which posts `review` on completion, plus a listener that keeps
  receiving re-opened threads until the human resolves them.

## Files

- `gust.ts` — `gust ctl` client (spawn, auto-detect, parse)
- `dialog.ts` — the TUI component
- `types.ts` — `Thread` / `ThreadMessage` / `ThreadState` (mirror the ctl JSON)
- `index.ts` — `/px:gust` registration
