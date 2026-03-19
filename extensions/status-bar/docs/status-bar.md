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

`id` is the producer ID (for example `safe-mode`, `switch-thinking`).

## Rendering path

Status-bar is rendered via `ctx.ui.setFooter(...)` (custom footer component), not `ctx.ui.setStatus(...)`.

Footer lines:

1. cwd + git branch + optional session name (pi default first line)
2. status-bar line (left/center/right)

## Status-line rendering rules

Status-bar stores latest content per producer (`id -> content`) and resolves section values by `DEFAULT_STATUS_BAR_LAYOUT`.

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
- Never reinterpret producer business meaning.
- Never add business logic (priority/TTL/sorting policies).
