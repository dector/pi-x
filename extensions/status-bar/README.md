# status-bar (pi extension)

Centralized status-bar renderer for producer extensions.

## Dependency role

`status-bar` is a shared dependency for other extensions in this repository.
Install and enable it first so producer extensions can render their status output.

## Contract

### Second line sections (unchanged)

- Sections: `left`, `center`, `right`
- Default order:
  - `left: ["safe-mode", "switch-thinking"]`
  - `center: []`
  - `right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"]`
- `context-watcher-*` IDs are computed internally by `status-bar` from active context usage/model.
- Events:
  - `status-bar:set` with `{ id, content }`
  - `status-bar:clear` with `{ id }`
- Item delimiter inside a section: ` · `
- Section delimiter: two spaces (`  `)

### First line provider (new)

- Events:
  - `status-bar:first-line:set` with `{ id, content, priority? }`
  - `status-bar:first-line:clear` with `{ id }`
- Resolution:
  - highest `priority` wins (default `0`)
  - tie-breaker: stable first-registration order
  - if no provider exists, fallback to built-in cwd/branch/session line

## Implementation

`status-bar` renders via a custom footer: `ctx.ui.setFooter(...)`.

The footer renders two lines:

1. First line from first-line provider events (or fallback to cwd + git branch + optional session name)
2. status-bar line with true left/center/right alignment

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

Second-line producers:

- `safe-mode`
- `switch-thinking`

Context usage (`context-watcher-*` IDs) is now produced internally by `status-bar`.

First-line producers (example):

- `repo-stats`
- `attension-core` (special-case: when active, its bell is prefixed before cwd/branch)

## Dev helper commands

- `/status-bar-contract`
  - Opens a read-only settings-style view with contract and renderer details.
- `/status-bar-set <id> <content>`
  - Sets test content for a second-line ID and re-renders.
- `/status-bar-clear <id>`
  - Clears test content for a second-line ID and re-renders.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/status-bar/`
- Project-local: `.pi/extensions/status-bar/`

Required files:

- `index.ts`
- `contract.ts`

Then run `/reload`.
