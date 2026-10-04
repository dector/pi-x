# attension-core (pi extension)

Minimal attention extension that emits a terminal bell when the agent run ends.

## Behavior (MVP)

- On `agent_end`, writes terminal BEL (`\u0007`) only in TUI mode with TTY stdout and `ctx.hasUI`.
- RPC (even under a PTY), JSON, print, and missing/unknown modes never write BEL. Missing mode fails closed, matching neo-bar/focus-mode compatibility guards.
- Applies a small cooldown of **1 second** to avoid rapid repeated bells.
- On `session_shutdown`, clears in-memory state.

## Optional state reset events

For stability across session transitions, state is reset on:

- `session_start` (also covers new, resume, fork, and reload)
- `session_tree`

## Command

- `/px:attension-core-test` — rings the terminal bell immediately in a TUI terminal (bypasses cooldown).
- Outside a TUI terminal, skips the write and reports why through `ctx.ui.notify` when `ctx.hasUI`, preserving RPC notifications.

## Tests

Run `bun test extensions/attension-core`. The PTY regression tests require Python 3 on Unix and exercise real TTY streams without a model/API call.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/attension-core/`
- Project-local: `.pi/extensions/attension-core/`

Then run `/reload`.
