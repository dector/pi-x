# repo-stats (pi extension)

Publishes repository summary for the **status-bar first line**.

## Dependency

Requires [`status-bar`](../status-bar/README.md) to be installed and enabled.

## What it shows

For the current `ctx.cwd`:

- directory path
- git branch
- if dirty: total line additions/removals

Examples:

- `~/pi-x (trunk) [+1 -2 M4 | +150 -200]`
- `~/pi-x (main)`

## How it works

`repo-stats` emits first-line events consumed by `status-bar` (displayed on the right side of first row):

- `status-bar:first-line:set` with `{ id, content, section: "right", priority }`
- `status-bar:first-line:clear` with `{ id }`

Producer id:

- `repo-stats`

Section and priority used:

- `right`
- `100` (so this item appears before lower-priority first-line right-section producers)

## Dirty totals

- combined dirty block format: `[+<new> -<removed> M<modified> | +<added> -<removed>]`
- files are shown first, line totals second
- file counters are always shown when dirty (including `+0 -0 M0`)
- line counters are always shown when dirty (including `+0 -0`)
- counters are colorized in UI:
  - `+...` = medium/darker green
  - `-...` = brighter red
  - `M...` = orange
- tracked changes: `git diff --numstat HEAD`
- untracked files: `git ls-files --others --exclude-standard -z` + line counting

## Refresh triggers

- `session_start`
- `session_switch`
- `session_tree`
- `session_fork`
- `turn_start`
- `turn_end`
- `input`
- `user_bash`

Updates are lightly debounced and emitted only when content changes.

## Debug command

- `/repo-stats-debug` — shows current computed payload details

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/repo-stats/`
- Project-local: `.pi/extensions/repo-stats/`

Then run `/reload`.
