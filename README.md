# Shitty Extensions

for [shittycodingagent.ai](https://shittycodingagent.ai/).

This repo currently contains the following extension(s):

- [`switch-thinking`](extensions/switch-thinking/README.md) — Adds fast keyboard workflows for thinking modes: `Ctrl+Alt+T` opens a picker, and `Ctrl+T` cycles your saved favorites. It persists favorites across sessions and respects model capability limits.
- [`safe-mode`](extensions/safe-mode/README.md) — Intercepts tool calls and enforces approval policies with four modes: `paranoid`, `reader`, `smart`, and `yolo`.
- [`status-bar`](extensions/status-bar/README.md) — Defines a simple centralized status-bar contract (left/center/right layout + `status-bar:set` / `status-bar:clear` events).
- [`context-watcher`](extensions/context-watcher/README.md) — Shows current context-window usage in the status bar (`CTX:10.0%`) with threshold-based colors.
- [`repo-stats`](extensions/repo-stats/README.md) — Publishes first-line repo info (`path (branch)` and dirty totals like `+150/-200`) for the status bar.

## Install policy for pi agents

When installing extensions from this repository, pi agents should use the standard pi extension layout:

1. **Install from source directory** (not bundled artifacts).
2. Copy the full extension folder to one of:
   - Global: `~/.pi/agent/extensions/<name>/`
   - Project-local: `.pi/extensions/<name>/`
3. Ensure `index.ts` exists at the extension root (or `<name>/index.ts`).
4. Run `/reload` after copying/updating the extension.
