# repo-stats (pi extension)

Publishes repository summary for the **status-bar first line**.

## What it shows

For the current `ctx.cwd`:

- directory path
- git branch
- if dirty: total line additions/removals

Examples:

- `~/pi-x (trunk) +150/-200:+1/-2/M4`
- `~/pi-x (main)`

## How it works

`repo-stats` emits first-line events consumed by `status-bar`:

- `status-bar:first-line:set` with `{ id, content, priority }`
- `status-bar:first-line:clear` with `{ id }`

Producer id:

- `repo-stats`

Priority used:

- `100` (so this line wins over lower-priority first-line producers)

## Dirty totals

- line totals: `+<added>/-<removed>`
- file totals suffix: `:+<new>/-<removed>/M<modified>`
- zero-value file parts are omitted (example: `:+2/M5`)
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
