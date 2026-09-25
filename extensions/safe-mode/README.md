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
- non-paranoid + `outerAccess=false`: `SMART`, `READER`, `YOLO`
- non-paranoid + `outerAccess=true`: `SMART+`, `READER+`, shield-only `󰕥` for `yolo+`
- paranoid always: `PARANOID`

In the new editor border, all modes render as rounded pills (`󰕥 MODE`):
SMART is purple, READER green, PARANOID blue, YOLO bright red, and the shield-only
`yolo+` pill is dark red with muted rose text. Legacy status-line labels retain producer formatting.

Notifications and list output keep the safe-mode name (for example `YOLO+` in UI notifications). The status bar displays only a shield for `yolo+`; Quick Actions calls the toggle `DANGER mode`.

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

The [`sqlite`](../sqlite/README.md) extension owns the `sqlite` risk rules and
registers as a hub `perm:tool` provider; `safe-mode` asks hub instead of
hardcoding them.

- read-only query (`SELECT`, `WITH ... SELECT`, read `PRAGMA`, `EXPLAIN`, `VALUES`) is treated as a read operation
- mutating/unknown query (`INSERT`, `UPDATE`, `DELETE`, DDL, transaction control, write `PRAGMA`, etc.) is treated as a write-like operation
- file-backed DB path is scoped against project root (`ctx.cwd`)
- in-memory DB (`memory=true`) is treated as in-repo scope

So in `reader`/`smart`, read-only sqlite queries can auto-allow (subject to outer-access/path scope), while mutating queries require approval.

## `proc` tool auto-allow

`safe-mode` classifies the [`proc`](../proc/README.md) tool:

- `list`, `status`, `logs` are read-only and auto-allow in `reader`/`smart`.
- `run` re-validates its `command` with the bash classifier, so read-only commands auto-allow while mutating commands require approval. A `cwd` outside the project root requires approval.
- `stop`, `kill`, `write`, `forget` require approval in `reader`/`smart` (mutating process state).
- `paranoid` asks for every `proc` call; `yolo` allows in-scope calls.

## HTTP, network, and memoryfs

Network disposition (method trust and policy) is owned by
[`permissions-core`](../permissions-core/README.md) and reached through the hub
`perm:net` capability. Safe-mode only owns the non-network (filesystem) parts of
these tools via `perm:tool`.

- Memoryfs reads through `http`, `http_md`, and `web_search` (`memfs: { id, offset?, limit? }`) never touch the network; they are auto-allowed in `reader`/`smart`/`yolo` and still ask in `paranoid`.
- Plain `web_search` and `http`/`http_md` requests follow the effective network policy. Under Auto that means:
  - `reader` and `paranoid`: ask for every valid request;
  - `smart`: allow `GET`/`HEAD`/`OPTIONS`; ask for other methods;
  - `yolo`: allow `GET`/`HEAD`/`OPTIONS`; block other methods.
- Under `yolo`, other (untrusted) methods are blocked, not allowed.
- Invalid URLs or methods block instead of prompting; malformed requests never become approvals.
- `http_md` with `spillMode: "to_file"` requires approval.
- `http` file output (`outputFile`, `curlArgs` `-o`, or `curlArgs` `--output`) requires approval in `reader`/`smart`.
- In `yolo`, `http` file output is allowed inside the project root and asks for outside-project output.
- In `YOLO!` (`yolo` with `outerAccess=true`), `http` file output is allowed both inside and outside the project root. This is the only `http` output-file case that skips the outside-project approval; `YOLO!` still does not relax the `http_md` `spillMode: "to_file"` approval.

### Execution authorization handoff

`safe-mode` uses the hub `perm:tool` provider only to classify. To make sure a
provider `allow` cannot outlive safe-mode's own policy, safe-mode emits a
one-time `px:safe-mode:tool-authorized` event
(`{ toolCallId, toolName, source: "safe-mode" }`) only after its final
decision is an allow or the user approves. The `http` capability requires the
`safe-mode` source, consumes the event at execution time, and blocks without it.
This also covers hub absence, timeouts, denied/non-UI prompts, and changed
arguments.

A built-in allow that only happened because the hub timed out does **not** emit
the handoff. Combined with the consumer storing its ticket only immediately
before the provider reply, a timeout-fallback authorization can never authorize
a late ticket.

Under `paranoid`, a provider `block` stays a `block` (invalid or denied
requests are never converted into an approval prompt); provider `allow` and
`confirm` are still overridden to ask. See
[`../hub/PROTOCOL.md`](../hub/PROTOCOL.md).

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
| `http`/`http_md`/`web_search` memoryfs read | ❓ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `http` output file **inside repo** | ❓ | ❓ | ❓ | ❓ | ❓ | ✅ | ✅ |
| `http` output file **outside repo** | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ✅ |
| `http_md` `spillMode: "to_file"` | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ |

Notes:
- Network requests (`http`, `http_md`, `web_search`) are classified and disposed by [`permissions-core`](../permissions-core/README.md), not by safe-mode. Under Auto they follow the effective policy for the current mode; see its policy matrix.
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

- `/px:safe` (alias: `/px:safe-mode`)
  - Show current mode and outer access status.
- `/px:safe <paranoid|reader|smart|yolo>[+]`
  - Set mode (`+` enables outer access, e.g. `smart+`).
- `/px:safe cycle`
  - Cycle modes.
- `/px:safe outer on|off|toggle`
  - Configure outside-project behavior.
- `/px:safe default`
  - Show saved default mode from settings.
- `/px:safe default <paranoid|reader|smart|yolo>[+]`
  - Save default mode in settings for future sessions.
- `/px:safe default reset`
  - Clear saved default (falls back to built-in `smart`).
- `/px:yolo`
  - Quick command to set `yolo+`.
- `/px:safe-mode-list`
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

## Herdr blocked state

Safe-mode owns three interactive waits that open a user dialog:

- hub-routed `perm:agent` approval;
- normal tool-call approval;
- steering input after a rejection.

Each wait goes through `withUserWait` (`user-wait.ts`), which:

1. generates a unique wait id;
2. registers a temporary `hub:user-wait:ack` listener;
3. emits `hub:user-wait:set` **before** opening the UI;
4. if hub acknowledges synchronously, marks the wait as `hub` mode; otherwise
   falls back to emitting the external `herdr:blocked { active: true, label }`
   directly and marks it `legacy` mode;
5. clears it in `finally` using exactly the same mode — `hub:user-wait:clear`
   for `hub`, `herdr:blocked { active: false }` for `legacy`.

Hub aggregates all owners' waits and, when the aggregate leaves zero, emits the
single `herdr:blocked { active: true }`; when the last wait clears it emits
`herdr:blocked { active: false }`. The direct path is only a fallback for an
absent or older hub. Safe-mode never emits both paths for one wait, which would
double-increment Herdr's counter.

The steering input opens **inside** the tool-approval wait, so the aggregate
never drops to zero across the picker -> steering transition. Hub emits one
block for the whole interval; nested-wait accounting stays in the aggregate
registry, not in Herdr.

The `herdr:blocked` event name is an external Herdr contract and intentionally
has **no** `px:` prefix; Herdr's managed integration owns and consumes it.
Safe-mode does not inspect Herdr environment variables or require Herdr to be
installed, and it does not require hub: the fallback keeps it working with an
absent or old hub.

Pending permission requests are not user waits. A `perm:tool`/`perm:net`
classification, an automatically allowed call, or a headless `confirm`-to-block
never sets wait state; only an actual open dialog does.

## CLI flag

- `--safe-mode <paranoid|reader|smart|yolo>`
  - Default: `smart`
- `--safe-mode-outer-access <true|false>`
  - Default: `false`

## Persistence

- Mode and outer access changes are persisted in session history via custom entries (`safe-mode`) and restored on resume/tree navigation/fork.
- Optional global defaults from `/px:safe default ...` are stored at:
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

## Subagent integration

Safe-mode publishes its current in-memory mode and outer-access setting on the local `pi.events` channels `px:safe-mode:state:*`. Subagents query this contract once while preparing a dispatch, before any child is spawned. Every child in that dispatch reuses the same snapshot, so a later parent change cannot leak into an accepted dispatch.

The same contract lets a running child change its own effective state without changing parent defaults.

RPC children relay approval dialogs to the parent UI. `[A]ll for this session` remains local to that child process. Project-persistent approvals still update the repository allowlist and can therefore affect later processes normally.

## Non-interactive behavior

If a tool call requires approval but no UI is available (`ctx.hasUI === false`), the call is blocked fail-safe with an explicit reason. A subagent with an RPC UI also fails closed when its parent cannot relay the dialog.

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

Status rendering is emitted via status-bar events (`px:status-bar:set` with `id: "safe-mode"`) rather than direct `ui.setStatus`.
For non-paranoid modes, `!` indicates `outerAccess=true`.

Read-only bash matching is intentionally strict and AST-based (via `bash-parser`).

- Allowed automatically: read-only commands and composed read-only chains (`|`, `&&`, `||`, `;`, newline) where each segment is read-only.
- Requires confirmation: redirections (`>`, `>>`, `<`, `<<`), substitutions (`` `...` ``, `$()`), unknown commands, mixed chains (e.g. `ls | rm -rf tmp`), and `find` forms that can mutate (`-exec`, `-delete`, etc).
