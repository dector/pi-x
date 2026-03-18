# Shitty Extensions

for [shittycodingagent.ai](https://shittycodingagent.ai/).

<p align="center">
  <img src="docs/images/pi-x.webp" alt="pi-x" />
</p>

This repo currently contains the following extension(s):

- [`status-bar`](extensions/status-bar/README.md) — **Required shared dependency** for other status-producing extensions in this repo. Install this first.
- [`switch-thinking`](extensions/switch-thinking/README.md) — Adds fast keyboard workflows for thinking modes: `Ctrl+Alt+T` opens a picker, and `Ctrl+T` cycles your saved favorites. Depends on `status-bar` for status rendering.
- [`safe-mode`](extensions/safe-mode/README.md) — Intercepts tool calls and enforces approval policies with four modes: `paranoid`, `reader`, `smart`, and `yolo`. Depends on `status-bar` for status rendering.
- [`context-watcher`](extensions/context-watcher/README.md) — Shows current context-window usage in the status bar (`CTX:10.0%`) with threshold-based colors. Depends on `status-bar`.
- [`repo-stats`](extensions/repo-stats/README.md) — Publishes first-line repo info (`path (branch)` and dirty totals like `+150/-200`) for the status bar. Depends on `status-bar`.
- [`http`](extensions/http/README.md) — Adds an `http` tool backed by Node native fetch, with HTTPie-like structured request fields and curl-compatible args support.

## Install policy for pi agents

When installing extensions from this repository, pi agents should use the standard pi extension layout:

1. **Install from source directory** (not bundled artifacts).
2. Copy the full extension folder to one of:
   - Global: `~/.pi/agent/extensions/<name>/`
   - Project-local: `.pi/extensions/<name>/`
3. Ensure `index.ts` exists at the extension root (or `<name>/index.ts`).
4. Run `/reload` after copying/updating the extension.
