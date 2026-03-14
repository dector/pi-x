# status-bar (pi extension)

Simple centralized status-bar contract.

## M1 scope (implemented)

This extension currently freezes the contract only:

- Sections: `left`, `center`, `right`
- Default order:
  - `left: ["safe-mode", "switch-thinking"]`
  - `center: []`
  - `right: []`
- Events:
  - `status-bar:set` with `{ id, content }`
  - `status-bar:clear` with `{ id }`
- Item join rule inside a section: ` · `

## Current behavior (M4 implementation)

- Keeps in-memory producer content map: `id -> content`.
- Listens on shared extension event bus for:
  - `status-bar:set`
  - `status-bar:clear`
- Renders only non-empty sections.
- Sections are separated by two spaces: `  `.
- Inside each section, items are joined by ` · `.
- Empty sections are omitted (not rendered).

## Dev helper commands

- `/status-bar-contract`
  - Shows current contract (events, join rule, default layout).
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
