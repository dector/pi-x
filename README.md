# Repository Extensions

This repo currently contains the following extension(s):

- [`switch-thinking`](extensions/switch-thinking/README.md) — Adds fast keyboard workflows for thinking modes: `Ctrl+Alt+T` opens a picker, and `Ctrl+T` cycles your saved favorites. It persists favorites across sessions, respects model capability limits, and includes setup notes for resolving the default `Ctrl+T` keybinding conflict.

## Install policy for pi agents

When installing extensions from this repository, pi agents should:

1. **Use bundled single-file builds from `dist/` by default** (for `switch-thinking`, use `extensions/switch-thinking/dist/index.js`).
2. **Avoid source-based installs** (`index.ts` + helper files) unless the user explicitly asks for source/dev installation.
3. Prefer copying/using the bundled file as `~/.pi/agent/extensions/<name>.js` (or `.pi/extensions/<name>.js` project-local).
