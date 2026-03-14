# safe-mode (pi extension)

Intercepts tool calls and applies configurable approval policies.

## Modes

- `paranoid`
  - Every tool call asks for confirmation.
- `reader`
  - Auto-allows read-only operations (`read`, `ls`, `grep`, plus allowlisted read-only `bash` commands).
  - Auto-allows read-only `bash` pipelines when **every stage** is allowlisted and read-only (for example: `ls -la | grep policy`, `git log --oneline | head -n 20`).
  - `find` requires confirmation (including in pipelines).
  - Everything else asks for confirmation.
- `smart`
  - Includes all `reader` behavior.
  - Also auto-allows `edit`/`write` when the target path is inside the project root (`ctx.cwd`).
  - Other operations ask for confirmation.
- `yolo`
  - Allows everything.

## Commands

- `/safe-mode`
  - Show current mode.
- `/safe-mode <paranoid|reader|smart|yolo>`
  - Set mode.
- `/safe-mode cycle`
  - Cycle modes.

## Shortcut

- `Alt+M`
  - Cycle safe modes.

## Approval dialog

When approval is required:
- `y` confirms (allow tool call)
- `n` or `N` rejects (block tool call)
- Existing selection navigation (arrows / j / k) remains unchanged

## CLI flag

- `--safe-mode <paranoid|reader|smart|yolo>`
- Default: `smart`

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

Status rendering is emitted via status-bar events (`status-bar:set` with `id: "safe-mode"`) rather than direct `ui.setStatus`.

Read-only bash matching is intentionally strict.

- Allowed automatically: single read-only commands and read-only pipelines (`|`) where each stage is read-only.
- Requires confirmation: control-flow chaining (`&&`, `||`, `;`, newline, `&`), redirections (`>`, `>>`, `<`, `<<`), substitutions (`` `...` ``, `$()`), unknown commands, or mixed pipelines (e.g. `ls | rm -rf tmp`).
