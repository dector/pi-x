# status-bar (pi extension)

Centralized status-bar renderer for producer extensions.

## Dependency role

`status-bar` is a shared dependency for other extensions in this repository.
Install and enable it first so producer extensions can render their status output.

## Contract

### Availability

- `status-bar:ping` with `{ id }`
- `status-bar:pong` with `{ id }`

When `status-bar` receives a valid ping payload, it emits a pong payload echoing the same `id`.

### Second line sections (unchanged)

- Sections: `left`, `center`, `right`
- Default order:
  - `left: ["safe-mode", "switch-thinking"]`
  - `center: []`
  - `right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"]`
- `context-watcher-*` IDs are computed internally by `status-bar` from active context usage/model.
- Token label format: `↑<input>/↓<output>/<cacheRead>`.
- Cost suffix: for providers in the cost-display whitelist (currently `deepseek`), the label gains a cumulative session cost suffix ` ($<price>)`, for example `↑12k/↓3.4k/45k ($0.0023)`.
  - Cost comes from pi's per-message `usage.cost.total` (derived from the model price table), summed over the active branch.
  - Precision is capped at 2 decimals (for example `$0.05`); non-zero amounts below half a cent render as `<$0.01`.
  - No suffix is rendered when cost is unavailable or zero.
- Events:
  - `status-bar:set` with `{ id, content }`
  - `status-bar:clear` with `{ id }`
- Item delimiter inside a section: ` · `
- Section delimiter: two spaces (`  `)

### First line sections

- Sections: `left`, `center`, `right`
- Events:
  - `status-bar:first-line:set` with `{ id, content, section?, priority? }`
  - `status-bar:first-line:clear` with `{ id }`
- Compatibility: omitted `section` defaults to `left`.
- Resolution inside each section:
  - highest `priority` first (default `0`)
  - tie-breaker: stable first-registration order
  - item delimiter: ` · `
- If no first-line producer exists, fallback to the built-in cwd/branch/session line.
- If producers exist but none provide left-section content, the built-in cwd/branch/session line remains on the left.

### Editor frame

`status-bar` also replaces the editor component with a `CustomEditor` subclass.
The input frame is drawn with side borders and corner characters, and compact
labels are rendered in the frame corners:

```
┌── <working status> ──────────────────── gpt-5 ─┐
│ ... input ...                                   │
└─ MED | 15.9% (210k, 0.03$) ────────── [SMART] ─┘
```

- The inner editor is rendered 2 columns narrower and wrapped with `│` side
  borders and `┌ ┐ └ ┘` corners. The autocomplete list stays outside the frame and
  is indented to line up with the editor interior.
- Mouse coordinates are translated by one column so click-to-position keeps working.
- **bottom-left** — thinking level, context usage, and cost.
  - Format: `─ <thinking> | <percent> (<tokens>, <cost>)`.
  - `thinking`: current thinking level abbreviated to 3-4 uppercase symbols
    (`OFF`, `MIN`, `LOW`, `MED`, `HIGH`, `XHI`, `MAX`; unknown levels are truncated to 4 chars).
  - `percent`: current context usage percent, one decimal (for example `15.9%`), or `--` when unknown.
  - `tokens`: current context usage tokens, compact (for example `210k`), or `--` when unknown.
  - `cost`: cumulative session cost with a trailing `$` (for example `0.03$`).
    Zero/unavailable renders as `0.00$`; non-zero below half a cent renders as `<0.01$`.
  - The frame label is independent of the second-line cost whitelist: it always shows
    accumulated `usage.cost.total` from the active branch.
  - The label uses the same context-usage color rules as the status-bar context items:
    `muted` up to 20%, `text` up to 30%, `warning` up to 50%, `error` above 50%.
    It stays uncolored when context percent is unknown.
- **bottom-right** — `safe-mode` status content (`[SMART]`, `[READER]`, `[YOLO]`,
  `[PARANOID]`, plus `+` when outer access is on). Rendered only while the
  `safe-mode` producer has published content.
- **top-right** — active model ID (`ctx.model.id`), rendered in the frame border
  color. Hidden when no model is active.
- Corner labels are prefixed with a space and followed by one border dash before
  the corner. They are dropped when the terminal is too narrow; the top-right model
  label also reserves extra room while the working status is embedded in the top border.
- The working status spinner stays embedded in the top border (pi >= 0.85).
- When the editor is scrolled, the `↓ N more` indicator sits to the left of the
  bottom-right label; the `↑ N more` indicator stays in the top border.
- On `session_shutdown` the previously configured editor factory is restored.

## Implementation

`status-bar` renders via a custom footer: `ctx.ui.setFooter(...)`.

The footer renders two lines:

1. First line from first-line section events plus built-in cwd + git branch + optional session name on the left when no producer owns the left section
2. status-bar line with true left/center/right alignment

## Alignment and width behavior

- Uses ANSI-aware helpers from `@earendil-works/pi-tui`:
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
- `attension-core` (special-case: when active, its content is still prefixed before cwd/branch)

## Dev helper commands

- `/status-bar-contract`
  - Opens a read-only settings-style view with contract, ping/pong availability events, and renderer details.
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
