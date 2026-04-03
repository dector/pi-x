# attension-core (pi extension)

Shows an attention indicator and rings the terminal bell when the agent finishes and user attention is needed.

## Dependency

Requires [`status-bar`](../status-bar/README.md) to be installed and enabled.

## Behavior

- Publishes a first-line indicator (`🔔`) with high priority.
- Rings the terminal bell (`BEL`, `\u0007`) when attention flips from off → on.
- Clears the indicator when user input starts again.

## Triggers

Attention turns **on** when agent work appears complete:

- `agent_end` (when no active agents remain)
- `turn_end` (fallback)
- `message_end` (fallback)

Attention turns **off** on:

- `input`
- `turn_start`
- `agent_start`
- `message_start`
- session switches/forks/tree/start

## Command

- `/attension-core-test` — toggles the indicator for quick validation.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/attension-core/`
- Project-local: `.pi/extensions/attension-core/`

Then run `/reload`.
