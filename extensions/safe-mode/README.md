# safe-mode (pi extension)

Intercepts tool calls and applies configurable approval policies.

## Modes

- `paranoid`
  - Every tool call asks for confirmation.
- `reader`
  - Auto-allows read-only operations (`read`, `ls`, `find`, `grep`, plus allowlisted read-only `bash` commands).
  - Everything else asks for confirmation.
- `smart`
  - Includes all `reader` behavior.
  - Also auto-allows `edit`/`write` when the target path is inside the project root (`ctx.cwd`).
  - Other operations ask for confirmation.
- `yolo`
  - Allows everything (default pi behavior).

## Commands

- `/safe-mode`
  - Show current mode.
- `/safe-mode <paranoid|reader|smart|yolo>`
  - Set mode.
- `/safe-mode cycle`
  - Cycle modes.

## Shortcut

- `Ctrl+M`
  - Cycle safe modes.

## CLI flag

- `--safe-mode <paranoid|reader|smart|yolo>`
- Default: `yolo`

## Persistence

Mode changes are persisted in session history via custom entries (`safe-mode`) and restored on resume/tree navigation/fork.

## Non-interactive behavior

If a tool call requires approval but no UI is available (`ctx.hasUI === false`), the call is blocked fail-safe with an explicit reason.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/safe-mode/`
- Project-local: `.pi/extensions/safe-mode/`

Required files:

- `index.ts`
- `policy.ts`

Then run `/reload`.

## Notes

Read-only bash matching is intentionally strict. Ambiguous command chains or redirections require confirmation.
