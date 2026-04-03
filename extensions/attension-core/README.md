# attension-core (pi extension)

Minimal attention extension that emits a terminal bell when the agent run ends.

## Behavior (MVP)

- On `agent_end`, writes terminal BEL (`\u0007`) to stdout.
- Applies a small cooldown of **1 second** to avoid rapid repeated bells.
- On `session_shutdown`, clears in-memory state.

## Optional state reset events

For stability across session transitions, state is reset on:

- `session_start`
- `session_switch`
- `session_tree`
- `session_fork`

## Command

- `/attension-core-test` — rings the terminal bell immediately (bypasses cooldown).

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/attension-core/`
- Project-local: `.pi/extensions/attension-core/`

Then run `/reload`.
