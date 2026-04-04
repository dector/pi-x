# git (pi extension)

Extension that registers:

- `git` tool
- `commit` tool
- `/git` command

Current support:

- `git` tool
  - `status`
    - Output style: porcelain passthrough from `git status --porcelain=v1 -b`
  - `log`
    - Default output: `--oneline --max-count 30`
    - Supported filters/flags: `-n/--max-count`, `--author`, `--since`, `--until`, `--grep`, `--no-merges`, `--decorate`, `--all`, and optional rev/range arguments

- `commit` tool
  - Required args:
    - `files: string[]` (explicit file list)
    - `message: string` (non-empty commit message)
  - Behavior:
    - Stages only the provided files via `git add -- <files...>`
    - Creates one commit via `git commit -m <message>`
    - Never runs `git add .`, never pushes/pulls/fetches
    - Returns a no-op message if requested files have no staged diff

Examples:

- `{ "files": ["README.md", "extensions/git/index.ts"], "message": "feat: add commit tool" }`
- `{ "files": ["src/app.ts"], "message": "fix: handle empty input" }`

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/git/`
- Project-local: `.pi/extensions/git/`

Then run `/reload`.
