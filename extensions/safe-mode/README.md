# safe-mode (pi extension)

Intercepts tool calls and applies configurable approval policies.

## Dependency

Requires [`status-bar`](../status-bar/README.md) to be installed and enabled for status indicator rendering.

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
  - Auto-allows `edit`/`write` only when target path is inside project root (`ctx.cwd`).
  - Other operations ask for confirmation.
- `yolo`
  - Allows everything within project-scope rules.

## Outer access modifier

- `outerAccess=false` (default)
  - Mode auto-approvals apply inside project root (`ctx.cwd`) only.
  - If an operation clearly targets paths outside the project root, approval is required.
- `outerAccess=true`
  - `reader`/`yolo`: mode rules also apply to outside paths.
  - `smart`: read rules apply outside paths, but `edit`/`write` remain inside-project only.

Status bar indicator:
- non-paranoid + `outerAccess=false`: `[SMART]`, `[READER]`, `[YOLO]`
- non-paranoid + `outerAccess=true`: `[SMART!]`, `[READER!]`, `[YOLO!]`
- paranoid always: `[PARANOID]`

## Auto-approval matrix

Legend: ✅ auto-allow, ❓ asks for approval.

| Operation | PARANOID | READER | READER! | SMART | SMART! | YOLO | YOLO! |
|---|---|---|---|---|---|---|---|
| `read`/`ls`/`grep` **inside repo** | ❓ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `read`/`ls`/`grep` **outside repo** | ❓ | ❓ | ✅ | ❓ | ✅ | ❓ | ✅ |
| `edit`/`write` **inside repo** | ❓ | ❓ | ❓ | ✅ | ✅ | ✅ | ✅ |
| `edit`/`write` **outside repo** | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ✅ |
| read-only `bash` **inside repo** | ❓ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| read-only `bash` targeting **outside repo** | ❓ | ❓ | ✅ | ❓ | ✅ | ❓ | ✅ |

Notes:
- `SMART!` does **not** allow outside `edit`/`write`; it only extends read-style approvals outside repo.
- For `reader`/`smart`, non-read-only operations still ask for approval.
- For `yolo`, `outerAccess=false` still gates outside-repo targets; `YOLO!` allows those too.

## Commands

- `/safe-mode`
  - Show current mode and outer access status.
- `/safe-mode <paranoid|reader|smart|yolo>`
  - Set mode.
- `/safe-mode cycle`
  - Cycle modes.
- `/safe-mode outer on|off|toggle`
  - Configure outside-project behavior.
- `/safe-mode-list`
  - Open an interactive manager for exact `bash` command lines auto-approved for the current session.
  - Keys:
    - `j` / `k`: move cursor
    - `space`: select/unselect command
    - `d`: remove current command (or all selected commands)
    - `u`: restore last removed command before current cursor position
    - `D` (`Shift+d`): clear all commands (with `y/n` confirmation)
    - `Esc`: close manager
  - Footer shows selection count as `N/M selected`.

## Shortcut

- `Ctrl+Shift+M`
  - Cycle safe modes.
- `Ctrl+Alt+Shift+M`
  - Toggle outer access modifier.

## Approval dialog

When approval is required:
- `Y` or `y` confirms once (allow this tool call)
- `N` or `n` rejects (block tool call)
- `A` or `a` remembers the exact `bash` command line for this session and auto-approves exact repeats
- `Esc` blocks the tool call, prompts for steering text, and sends it to the agent as a steer message
- Existing selection navigation (arrows / j / k) remains unchanged

## CLI flag

- `--safe-mode <paranoid|reader|smart|yolo>`
  - Default: `smart`
- `--safe-mode-outer-access <true|false>`
  - Default: `false`

## Persistence

Mode and outer access changes are persisted in session history via custom entries (`safe-mode`) and restored on resume/tree navigation/fork.

## Non-interactive behavior

If a tool call requires approval but no UI is available (`ctx.hasUI === false`), the call is blocked fail-safe with an explicit reason.

## Agent visibility

The extension does not inject safe-mode metadata into the agent prompt.
Blocking/steering reasons are generic and do not mention safe mode.

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
For non-paranoid modes, `!` indicates `outerAccess=true`.

Read-only bash matching is intentionally strict and AST-based (via `bash-parser`).

- Allowed automatically: read-only commands and composed read-only chains (`|`, `&&`, `||`, `;`, newline) where each segment is read-only.
- Requires confirmation: redirections (`>`, `>>`, `<`, `<<`), substitutions (`` `...` ``, `$()`), unknown commands, mixed chains (e.g. `ls | rm -rf tmp`), and `find` forms that can mutate (`-exec`, `-delete`, etc).
