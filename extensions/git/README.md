# git (pi extension)

Extension that registers:

- `git` tool
- `/git` command

Current support:

- `status` only
- Output style: porcelain passthrough from `git status --porcelain=v1 -b`

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/git/`
- Project-local: `.pi/extensions/git/`

Then run `/reload`.
