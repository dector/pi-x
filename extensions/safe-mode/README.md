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
  - Exception: in `reader`/`smart`, read-only access to trusted read roots is auto-allowed (installed pi docs and loaded skills).
  - Pi docs auto-discovery is most reliable when pi is installed via **mise** (other install layouts are best-effort).
- `outerAccess=true`
  - `reader`/`yolo`: mode rules also apply to outside paths.
  - `smart`: read rules apply outside paths, but `edit`/`write` remain inside-project only.

Status bar indicator:
- non-paranoid + `outerAccess=false`: `[SMART]`, `[READER]`, `[YOLO]`
- non-paranoid + `outerAccess=true`: `[SMART!]`, `[READER!]`, `[YOLO!]`
- paranoid always: `[PARANOID]`

## Read-only `git` tool auto-allow

`safe-mode` applies an explicit read-only allowlist for the `git` tool.

- In `reader`, `smart`, and `yolo`: recognized read-only `git` calls are auto-allowed.
- In `paranoid`: all `git` calls still require approval.
- Unknown, malformed, or non-read-only `git` forms require approval (except in `yolo`, which allows any in-scope operation).

Currently auto-allowed read-only `git` subtools:

- `status`, `log`, `diff`, `show`, `blame`, `grep`, `shortlog`
- `rev-parse`, `rev-list`, `merge-base`, `describe`, `name-rev`, `symbolic-ref`, `show-ref`, `for-each-ref`
- `ls-files`, `ls-tree`, `cat-file`, `check-ignore`
- list-only forms of `branch`, `tag`, `remote`, and viewing forms of `reflog`
- read-only `config` forms (`--get`, `--get-all`, `--list`, optional `--show-origin` / `--show-scope`)
- `count-objects`, `fsck`, `verify-commit`, `verify-tag`

Notes:
- allowlisting is conservative and validator-based for ambiguous subtools (`branch`, `tag`, `remote`, `config`, `diff`, `reflog`)
- default is deny when not explicitly recognized as read-only

## Read-only `sqlite` tool auto-allow

`safe-mode` classifies `sqlite` queries and applies mode rules:

- read-only query (`SELECT`, `WITH ... SELECT`, read `PRAGMA`, `EXPLAIN`, `VALUES`) is treated as a read operation
- mutating/unknown query (`INSERT`, `UPDATE`, `DELETE`, DDL, transaction control, write `PRAGMA`, etc.) is treated as a write-like operation
- file-backed DB path is scoped against project root (`ctx.cwd`)
- in-memory DB (`memory=true`) is treated as in-repo scope

So in `reader`/`smart`, read-only sqlite queries can auto-allow (subject to outer-access/path scope), while mutating queries require approval.

## HTTP and memoryfs auto-allow

- Memoryfs reads through `http`, `http_md`, and `web_search` (`memfs: { id, offset?, limit? }`) are auto-allowed in `reader`, `smart`, and `yolo`; `paranoid` still asks.
- `web_search` queries are auto-allowed in `reader`, `smart`, and `yolo`; `paranoid` still asks.
- `http` and `http_md` are auto-allowed in `reader`/`smart` only for `GET`, `HEAD`, and `OPTIONS` requests.
- Other HTTP methods require approval in `reader`/`smart`; `yolo` keeps its normal allow behavior.
- `http_md` with `spillMode: "to_file"` requires approval.
- `http` file output (`outputFile`, `curlArgs` `-o`, or `curlArgs` `--output`) requires approval in `reader`/`smart`.
- In `yolo`, `http` file output is allowed only inside the project root; outside-project output still requires approval, including in `YOLO!`.

## Auto-approval matrix

Legend: ✅ auto-allow, ❓ asks for approval.

| Operation | PARANOID | READER | READER! | SMART | SMART! | YOLO | YOLO! |
|---|---|---|---|---|---|---|---|
| `read`/`ls`/`grep` **inside repo** | ❓ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `read`/`ls`/`grep` **outside repo** | ❓ | ❓* | ✅ | ❓* | ✅ | ❓ | ✅ |
| `edit`/`write` **inside repo** | ❓ | ❓ | ❓ | ✅ | ✅ | ✅ | ✅ |
| `edit`/`write` **outside repo** | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ✅ |
| read-only `bash` **inside repo** | ❓ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| read-only `bash` targeting **outside repo** | ❓ | ❓* | ✅ | ❓* | ✅ | ❓ | ✅ |
| `http`/`http_md` `GET`/`HEAD`/`OPTIONS` without file output | ❓ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `web_search` query | ❓ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `http`/`http_md`/`web_search` memoryfs read | ❓ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `http_md` `spillMode: "to_file"` | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |

Notes:
- `SMART!` does **not** allow outside `edit`/`write`; it only extends read-style approvals outside repo.
- For `reader`/`smart`, non-read-only operations still ask for approval.
- `*` For `reader`/`smart` with `outerAccess=false`, trusted read roots are a narrow read-only exception.
- For `yolo`, `outerAccess=false` still gates outside-repo targets; `YOLO!` allows those too.

## Trusted read roots

When `outerAccess=false`, `reader`/`smart` can still auto-allow read-only operations against trusted read roots outside the project:

- installed pi package documentation roots: package `README.md`, `docs/`, and `examples/`
- loaded skill roots: skill `baseDir` when available, with `filePath` / `sourceInfo.path` as fallback

This covers normal skill loading via `read` of `SKILL.md` plus sibling/reference files under a loaded skill directory. It does not permit writes, execution, mutating bash commands, or any operation in `paranoid`.

## Commands

- `/safe` (alias: `/safe-mode`)
  - Show current mode and outer access status.
- `/safe <paranoid|reader|smart|yolo>[+]`
  - Set mode (`+` enables outer access, e.g. `smart+`).
- `/safe cycle`
  - Cycle modes.
- `/safe outer on|off|toggle`
  - Configure outside-project behavior.
- `/safe default`
  - Show saved default mode from settings.
- `/safe default <paranoid|reader|smart|yolo>[+]`
  - Save default mode in settings for future sessions.
- `/safe default reset`
  - Clear saved default (falls back to built-in `smart`).
- `/yolo`
  - Quick command to set `yolo+`.
- `/safe-mode-list`
  - Open an interactive manager for exact `bash` command lines auto-approved for this session and this project.
  - Project-persistent entries are shown first with `(project)` prefix.
  - Project-persistent entries are editable only in `smart`/`smart!`; in other modes they are shown muted/read-only.
  - Keys:
    - `j` / `k`: move cursor
    - `space`: select/unselect command
    - `d`: remove current command (or all selected commands)
    - `u`: restore last removed command
    - `D` (`Shift+d`): clear all session commands (with `y/n` confirmation)
    - `Esc`: close manager
  - Footer shows selection count as `N/M selected`.

## Shortcut

- `Ctrl+Shift+M`
  - Cycle safe modes.
- `Ctrl+Alt+Shift+M`
  - Toggle outer access modifier.

## Approval dialog

When approval is required:
- `Y` confirms once (allow this tool call)
- `N` rejects (block tool call)
- `A` remembers the exact `bash` command line for this session and auto-approves exact repeats
- `P` permanently allows the exact `bash` command for this project (**only shown in `smart`/`smart!`**)
- `Esc` blocks the tool call, prompts for steering text, and sends it to the agent as a steer message
- Existing selection navigation (arrows / j / k) remains unchanged

## CLI flag

- `--safe-mode <paranoid|reader|smart|yolo>`
  - Default: `smart`
- `--safe-mode-outer-access <true|false>`
  - Default: `false`

## Persistence

- Mode and outer access changes are persisted in session history via custom entries (`safe-mode`) and restored on resume/tree navigation/fork.
- Optional global defaults from `/safe default ...` are stored at:
  - `~/.pi/agent/extensions/safe-mode/settings.json`
  - shape: `{ "mode": "smart", "outerAccess": true }`
- Resolution order on startup: CLI flags (`--safe-mode`, `--safe-mode-outer-access`) → session persisted state → saved defaults → built-in defaults.
- Smart-mode project allowlist is persisted per repository at:
  - `<repo>/.pi/memory/safe-mode/smart-allowlist.json`
  - format: `{ "allow": ["..."], "allowAny": ["flutter"], "deny": [] }` (`deny` currently ignored)
  - `allow` contains exact `bash` command lines saved from approvals.
  - `allowAny` is a manually editable section for executable names that may run with any arguments, e.g. `"flutter"` allows `flutter test` and `flutter foo`.
  - For shell chains, every parsed command segment must match either an exact `allow` entry or an `allowAny` executable name. Redirects, dynamic arguments, command substitution, and path executables like `./flutter` still require approval unless normal policy allows them.
  - file is created only when project-level approvals are actually saved; if absent, built-in default rules apply

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
