# context-watcher (pi extension)

Shows current context-window usage in the shared status bar as:

- `gpt-5.3: 10.0%`

## Behavior

- Publishes to status-bar producer ID: `context-watcher`
- Intended placement: **right** section (configured by `status-bar` default layout)
- Color thresholds:
  - `<= 20%` → muted
  - `<= 30%` → white/text
  - `<= 50%` → yellow/warning
  - `> 50%` → red/error

If context usage is unavailable (`ctx.getContextUsage()?.percent` is missing), it clears its status entry.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/context-watcher/`
- Project-local: `.pi/extensions/context-watcher/`

Required file:

- `index.ts`

Then run `/reload`.
