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

- `px:status-bar:set`
  - payload: `{ id: string, content: string }`
- `px:status-bar:clear`
  - payload: `{ id: string }`
- `px:status-bar:first-line:set`
  - payload: `{ id: string, content: string, section?: "left" | "center" | "right", priority?: number }`
  - omitted `section` defaults to `left`
- `px:status-bar:first-line:clear`
  - payload: `{ id: string }`
- `px:status-bar:ping`
  - payload: `{ id: string }`
- `px:status-bar:pong`
  - payload: `{ id: string }`

When `status-bar` receives a valid `px:status-bar:ping`, it emits `px:status-bar:pong` echoing the same `id`.

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
- The `safe-mode` and effective network token are one group: they are joined by
  exactly ` · ` (muted) even when a crowded line switches the other items to the
  compact `·` separator. The group is placed at the `safe-mode` position, so the
  network token always follows safe mode immediately.
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
  `context-watcher-model`, and `context-watcher-percent` are hidden. The
  `repo-stats` dirty totals also move from the first line to the frame top-right.
- `legacy` (status-bar priority): editor frame is the plain pi editor (no side
  borders, no corner labels); status line uses the default layout with the
  effective network token inserted directly after `safe-mode`.

The effective network token (from `permissions-core`) is rendered on exactly one
surface: the editor frame bottom-left in `new` mode, the status line in `legacy`
mode. It is never duplicated across both. `safe-mode` and the token always share
one label joined by exactly ` · `.

Setup:

- `/px:status-bar-display-mode new|legacy`
- `~/.pi/agent/status-bar.json` -> `{ "displayMode": "new" }`
- `PI_STATUS_BAR_DISPLAY_MODE=new|legacy` env override (wins over the file)

## Aliases

Exact-name alias tables in `~/.pi/agent/status-bar.json` shorten the border labels:

- `providerAliases`: `ctx.model.provider` -> short label (border label only).
- `modelAliases`: `ctx.model.id` -> short label (border + legacy `context-watcher-model`).

```json
{
  "providerAliases": { "openai-codex": "cdx", "deepseek": "dseek", "opencode-go": "opencode" },
  "modelAliases": {
    "gpt-5.6-sol": "5.6-sol",
    "deepseek-v4.1-flash": "4.1-flash",
    "deepseek-v4-pro": "4-pro"
  }
}
```

Matching is exact id only (no patterns); missing keys fall back to the raw id.
Aliases load at session start, so reload/restart after editing the file.

## Editor frame

Status-bar replaces the editor component with a `CustomEditor` subclass, draws a
full frame (`│` sides + rounded `╭ ╮ ╰ ╯` corners), enables one column of horizontal
editor padding (`paddingX: 1`), and renders:

- top-left: active provider + model ID + effort (`<ctx.model.provider>/<ctx.model.id> (<effort>)`, id-only when provider is missing), with exact-name aliases applied, colored with the frame border color. The effort is the 3-4 lowercase level symbol; on narrow screens (e.g. a phone) the text is dropped and only the arrow indicator is shown. While streaming the label runs a configurable animation (source constant `WORKING_ANIMATION`, env `PI_STATUS_BAR_WORKING_ANIMATION`): `comet` moves a bright lead with a fading trail across the label, `glitch` swaps a few random characters for matrix blocks (`▓▒░`, denser = brighter) with independent lifetimes; no spinner and no `Working` word.
- top-right: `repo-stats` git dirty totals (`-< +1 -2 M4 · +150 -200 >-`), rendered only when the repo is dirty. The producer's `[ ]`/`|` are stripped and the file/line groups are separated by a `·` recolored to the frame border color. In `new` mode these totals are hidden from the first line; in `legacy` mode they stay there.
- bottom-left: context usage and cumulative cost (`-< 15.9% 210k · 0.03$ >-`),
  colored with the same context-usage rules as the status-bar context items
  (`muted` <=20%, `text` <=30%, `warning` <=50%, `error` >50%). When subagent
  usage changes the total, cost renders as session | total (`0.01$ | 0.013$`),
  the total with three decimals so small subagent spend stays visible. It
  includes every subagent in the branch, nested ones included, and is omitted
  while the total rounds to the same three-decimal value as the session cost.
- bottom-left, before context: `safe-mode` producer content (for example `SMART`)
  followed by the effective network token, joined to the context label by the two
  tacks with a centered dot (`-< SMART · NET? >-·-< 15.9% >-`). Safe mode and the
  network token share one label joined by exactly ` · `, which is preserved under
  crowding. `SMART` uses the frame border color; other modes keep the producer's
  own color. The network token keeps its policy color (`muted` for deny-all and
  ask-all; `text` for allow-trusted, ask-untrusted, and allow-all) and follows
  effective state only (PARANOID -> gray `NET?`).

Every border text label is delimited with ASCII angle tacks on both sides (`-< <label> >-`).
Two labels on the same edge are joined by the two tacks with a centered dot (`-< A >-·-< B >-`).
Labels are dropped when the terminal is too narrow.
The inner editor renders 2 columns narrower and applies `paddingX: 1`; autocomplete
stays outside the frame and is indented to match. Mouse coordinates are shifted back by one
column. When the editor is scrolled, `↓ N more` sits on the right of the bottom border
and `↑ N more` sits on the right of the top border.

## Responsibility split

### Producer extensions

- Own their text/formatting.
- Emit `px:status-bar:set` when content changes.
- Emit `px:status-bar:clear` when content should disappear.

### Status-bar extension

- Own layout, joining, alignment, and truncation.
- Resolve first-line left/center/right sections, ordered by priority descending then stable registration order.
- Compute built-in context watcher values (`context-watcher-*`) from active session/model/context usage.
