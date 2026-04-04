# git (pi extension)

Extension that registers:

- `git` tool
- `/git` command

Current support:

- `status`
  - Output style: porcelain passthrough from `git status --porcelain=v1 -b`
- `log`
  - Default output: `--oneline --max-count 30`
  - Supported filters/flags: `-n/--max-count`, `--author`, `--since`, `--until`, `--grep`, `--no-merges`, `--decorate`, `--all`, and optional rev/range arguments

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/git/`
- Project-local: `.pi/extensions/git/`

Then run `/reload`.
