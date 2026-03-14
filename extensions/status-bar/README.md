# status-bar (pi extension)

Centralized status-bar renderer for producer extensions.

## Contract (unchanged)

- Sections: `left`, `center`, `right`
- Default order:
  - `left: ["safe-mode", "switch-thinking"]`
  - `center: []`
  - `right: ["context-watcher"]`
- Events:
  - `status-bar:set` with `{ id, content }`
  - `status-bar:clear` with `{ id }`
- Item delimiter inside a section: ` · `
- Section delimiter: two spaces (`  `)

## Implementation

`status-bar` now renders through a **custom footer** via `ctx.ui.setFooter(...)`.

The footer renders two lines:

1. cwd + git branch + optional session name (equivalent to pi default first line)
2. status-bar line with true left/center/right alignment

Status-bar producer content is still stored as `id -> content`, resolved by `DEFAULT_STATUS_BAR_LAYOUT`, and joined per section with `STATUS_BAR_JOIN_SEPARATOR`.

## Alignment and width behavior

- Uses ANSI-aware helpers from `@mariozechner/pi-tui`:
  - `visibleWidth(...)`
  - `truncateToWidth(...)`
- Placement priority for the status line:
  1. exact left + centered + right-aligned (no overlap)
  2. left + right (drop center)
  3. truncated left/right variants
  4. left-only fallback
- Narrow terminal widths degrade gracefully by truncating and/or dropping center.

## Producer compatibility

No producer changes required.

Existing producers continue to work unchanged:

- `safe-mode`
- `switch-thinking`
- `context-watcher`

## Dev helper commands

- `/status-bar-contract`
  - Shows current contract and renderer details.
- `/status-bar-set <id> <content>`
  - Sets test content for an ID and re-renders.
- `/status-bar-clear <id>`
  - Clears test content for an ID and re-renders.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/status-bar/`
- Project-local: `.pi/extensions/status-bar/`

Required files:

- `index.ts`
- `contract.ts`

Then run `/reload`.
