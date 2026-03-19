# context-watcher (pi extension)

Shows current context-window usage in the shared status bar as split entities:

- `↑21k/↓1.5k/37k · gpt-5.3 · 10.0%`

## Dependency

Requires [`status-bar`](../status-bar/README.md) to be installed and enabled.

## Behavior

- Publishes to status-bar producer IDs:
  - `context-watcher-tokens`
  - `context-watcher-model`
  - `context-watcher-percent`
- Intended placement: **right** section (configured by `status-bar` default layout)
- Display format: `↑<input>/↓<output>/<cache-read> · <model> · <context-percent>%`
  - `↑<input>`: cumulative input tokens
  - `↓<output>`: cumulative output tokens
  - `<cache-read>`: cumulative cache-read tokens
  - `<model>`: active model id (for example `gpt-5.3`)
  - `<context-percent>%`: current context-window usage percent
- Color thresholds:
  - `<= 20%` → muted
  - `<= 30%` → white/text
  - `<= 50%` → yellow/warning
  - `> 50%` → red/error

If context usage is unavailable (`ctx.getContextUsage()?.percent` is missing), it clears all of its status entries.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/context-watcher/`
- Project-local: `.pi/extensions/context-watcher/`

Required file:

- `index.ts`

Then run `/reload`.
