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
  right: [],
}
```

## Events

Producers publish content to the shared event bus:

- `status-bar:set`
  - payload: `{ id: string, content: string }`
- `status-bar:clear`
  - payload: `{ id: string }`

Where `id` is the producer ID (for example `safe-mode`, `switch-thinking`).

## Rendering rules

Status-bar stores latest content per producer (`id -> content`) and renders by section order.

Rules:

- Include only non-empty producer content.
- Join items **inside a section** with ` · `.
- Omit empty sections.
- Join rendered sections with two spaces (`  `).
- Do not wrap content with synthetic decorators (no `[]`, no added `|...|`).

## Responsibility split

### Producer extensions

- Own their text/formatting.
- Emit `status-bar:set` when content changes.
- Emit `status-bar:clear` when content should disappear.

### Status-bar extension

- Own layout and joining only.
- Never reinterpret producer formatting.
- Never add business logic (priority/TTL/sorting policies).
