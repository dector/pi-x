# Status Bar (Final Spec)

Centralized status rendering for extensions.

## Layout

Three ordered sections:

- `left`
- `center`
- `right`

Default layout:

```ts
{
  left: ["safe-mode", "switch-thinking"],
  center: [],
  right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"],
}
```

## Events (producer API)

Producers publish content to the shared event bus:

- `status-bar:set`
  - payload: `{ id: string, content: string }`
- `status-bar:clear`
  - payload: `{ id: string }`
- `status-bar:first-line:set`
  - payload: `{ id: string, content: string, section?: "left" | "center" | "right", priority?: number }`
  - omitted `section` defaults to `left`
- `status-bar:first-line:clear`
  - payload: `{ id: string }`

`id` is the producer ID (for example `safe-mode`, `switch-thinking`, `repo-stats`).

## Rendering path

Status-bar is rendered via `ctx.ui.setFooter(...)` (custom footer component), not `ctx.ui.setStatus(...)`.

Footer lines:

1. first-line sections (left/center/right), or cwd + git branch + optional session name when there are no first-line producers
2. status-bar line (left/center/right)

## Status-line rendering rules

Status-bar stores latest content per producer (`id -> content`) and resolves second-line section values by `DEFAULT_STATUS_BAR_LAYOUT`.

For `context-watcher-*` IDs, status-bar now computes values internally from the active context/session.

Rules:

- Include only non-empty producer content.
- Join items **inside a section** with ` · `.
- Omit empty sections.
- Keep section separator contract (`"  "`) as minimum inter-section gap/fallback join.
- Do not wrap content with synthetic decorators (no `[]`, no added `|...|`).

## Alignment + truncation behavior

The status line uses ANSI-aware width handling:

- `visibleWidth(...)`
- `truncateToWidth(...)`

Placement priority:

1. exact placement with no overlap:
   - left at column 0
   - center centered
   - right right-aligned to terminal edge
2. if overlap, render left + right (drop center)
3. if still too narrow, truncate left/right as needed
4. last fallback: left-only

## Responsibility split

### Producer extensions

- Own their text/formatting.
- Emit `status-bar:set` when content changes.
- Emit `status-bar:clear` when content should disappear.

### Status-bar extension

- Own layout, joining, alignment, and truncation.
- Resolve first-line left/center/right sections, ordered by priority descending then stable registration order.
- Compute built-in context watcher values (`context-watcher-*`) from active session/model/context usage.
