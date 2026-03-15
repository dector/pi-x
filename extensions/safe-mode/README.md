# safe-mode (pi extension)

Intercepts tool calls and applies configurable approval policies.

## Modes

- `paranoid`
  - Every tool call asks for confirmation.
- `reader`
  - Auto-allows read-only operations (`read`, `ls`, `grep`, plus allowlisted read-only `bash` commands).
  - Auto-allows composed read-only `bash` commands (`|`, `&&`, `||`, `;`, newline) when **every segment** is read-only (for example: `ls -la | grep policy`, `ls && pwd`, `git log --oneline | head -n 20`).
  - `find` is auto-allowed only for safe read-only forms (e.g. no `-exec`/`-delete`/dynamic args).
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

- `Ctrl+Shift+M`
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
- `package.json`
- `bun.lock` (or regenerate with install)

Install dependencies in the extension directory:

- `cd ~/.pi/agent/extensions/safe-mode && bun install`
  - or `cd .pi/extensions/safe-mode && bun install`

Then run `/reload`.

## Notes

Status rendering is emitted via status-bar events (`status-bar:set` with `id: "safe-mode"`) rather than direct `ui.setStatus`.

Read-only bash matching is intentionally strict and AST-based (via `bash-parser`).

- Allowed automatically: read-only commands and composed read-only chains (`|`, `&&`, `||`, `;`, newline) where each segment is read-only.
- Requires confirmation: redirections (`>`, `>>`, `<`, `<<`), substitutions (`` `...` ``, `$()`), unknown commands, mixed chains (e.g. `ls | rm -rf tmp`), and `find` forms that can mutate (`-exec`, `-delete`, etc).
