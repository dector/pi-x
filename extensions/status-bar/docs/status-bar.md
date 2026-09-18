# Status Bar (Final Spec)

Centralized status rendering for extensions.

## Layout

Three ordered sections:

- `left`
- `center`
- `right`

Default layout (`legacy` display mode):

```ts
{
  left: ["safe-mode", "switch-thinking"],
  center: [],
  right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"],
}
```

`new` display mode (default) omits status line 2. Context/model/safe-mode
are shown on the editor frame border, and `switch-thinking` (favorite thinking
modes) is redundant with the border thinking level. The input/output/cache token
breakdown moves to status line 1, after the producer items, without a cost suffix:

```ts
{
  left: [],
  center: [],
  right: [],
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
- `status-bar:ping`
  - payload: `{ id: string }`
- `status-bar:pong`
  - payload: `{ id: string }`

When `status-bar` receives a valid `status-bar:ping`, it emits `status-bar:pong` echoing the same `id`.

`id` is the producer ID (for example `safe-mode`, `switch-thinking`, `repo-stats`).

## Rendering path

Status-bar is rendered via `ctx.ui.setFooter(...)` (custom footer component), not `ctx.ui.setStatus(...)`.

Footer lines:

1. first-line sections (left/center/right), keeping cwd + git branch + optional session name on the left when no producer owns the left section. In `new` display mode the context token breakdown is appended to the right section after the producers.
2. status-bar line (left/center/right)

## Status-line rendering rules

Status-bar stores latest content per producer (`id -> content`) and resolves second-line section values by `DEFAULT_STATUS_BAR_LAYOUT`.

For `context-watcher-*` IDs, status-bar now computes values internally from the active context/session.

### Cost display

The token item (`context-watcher-tokens`) renders `↑<input>/↓<output>/<cacheRead>`.

When the active provider is in the cost-display whitelist (currently `deepseek` only), status-bar appends the cumulative session cost:

```
↑12k/↓3.4k/45k ($0.0023)
```

- Cost source: pi's per-message `usage.cost.total` (from the model price table), summed over the active branch.
- Precision capped at 2 decimals: `$0.05`. Non-zero totals below half a cent render as `<$0.01`.
- Omitted when cost is zero or unavailable, or for other providers.

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

## Display mode

`displayMode` (`new` | `legacy`, default `new`) controls which surface owns the
context/model/safe-mode info:

- `new` (border priority): editor frame shows the corner labels; status line 2 is
  omitted and the input/output/cache token breakdown moves to status line 1 (after
  the producer items) with no cost suffix. `safe-mode`, `switch-thinking`,
  `context-watcher-model`, and `context-watcher-percent` are hidden.
- `legacy` (status-bar priority): editor frame is the plain pi editor (no side
  borders, no corner labels); status line uses the default layout.

Setup:

- `/status-bar-display-mode new|legacy`
- `~/.pi/agent/status-bar.json` -> `{ "displayMode": "new" }`
- `PI_STATUS_BAR_DISPLAY_MODE=new|legacy` env override (wins over the file)

## Aliases

Exact-name alias tables in `~/.pi/agent/status-bar.json` shorten the border labels:

- `providerAliases`: `ctx.model.provider` -> short label (border label only).
- `modelAliases`: `ctx.model.id` -> short label (border + legacy `context-watcher-model`).

```json
{
  "providerAliases": { "openai-codex": "cdx", "deepseek": "dseek", "opencode-go": "go" },
  "modelAliases": {
    "gpt-5.6-sol": "5.6-sol",
    "deepseek-v4.1-flash": "ds-4.1-fl",
    "deepseek-v4-pro": "ds-4-pro"
  }
}
```

Matching is exact id only (no patterns); missing keys fall back to the raw id.
Aliases load at session start, so reload/restart after editing the file.

## Editor frame

Status-bar replaces the editor component with a `CustomEditor` subclass, draws a
full frame (`│` sides + rounded `╭ ╮ ╰ ╯` corners), enables one column of horizontal
editor padding (`paddingX: 1`), and renders:

- bottom-left: thinking level, context usage, and cumulative cost (`─ MED 🡺 | 15.9% (210k, 0.03$)`),
  colored with the same context-usage rules as the status-bar context items
  (`muted` <=20%, `text` <=30%, `warning` <=50%, `error` >50%)
- bottom-right: `safe-mode` producer content (for example `[SMART]`)
- top-right: active provider + model ID (`<ctx.model.provider>/<ctx.model.id>`, id-only when provider is missing), with exact-name aliases applied, colored with the frame border color

The top border keeps the working status spinner from pi (>= 0.85).
The inner editor renders 2 columns narrower and applies `paddingX: 1`; autocomplete
stays outside the frame and is indented to match. Mouse coordinates are shifted back by one
column. Right-corner labels render as ` <label> ─` and are dropped when the terminal
is too narrow. When the editor is scrolled, `↓ N more` sits left of the bottom-right label.

## Responsibility split

### Producer extensions

- Own their text/formatting.
- Emit `status-bar:set` when content changes.
- Emit `status-bar:clear` when content should disappear.

### Status-bar extension

- Own layout, joining, alignment, and truncation.
- Resolve first-line left/center/right sections, ordered by priority descending then stable registration order.
- Compute built-in context watcher values (`context-watcher-*`) from active session/model/context usage.
