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
- Join rule (for later rendering milestone): ` | `

## Notes

- This milestone does **not** implement centralized aggregation/rendering yet.
- For test visibility, it sets a temporary placeholder status: `[status-bar: no producer output yet]`.
- Full rendering and migration are planned in later milestones (`extensions/status-bar/docs/status-bar.plan.md`).

## Dev helper command

- `/status-bar-contract`
  - Shows current M1 contract (events, join rule, default layout).

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/status-bar/`
- Project-local: `.pi/extensions/status-bar/`

Required files:

- `index.ts`
- `contract.ts`

Then run `/reload`.
