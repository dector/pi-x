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

`id` is the producer ID (for example `safe-mode`, `switch-thinking`). The git dirty totals and the skill counter are produced internally and are not part of this contract; the first-line ids `repo-stats` and `skill-stats` are ignored.

## Rendering path

Status-bar is rendered via `ctx.ui.setFooter(...)` (custom footer component), not `ctx.ui.setStatus(...)`.

Footer lines:

1. first-line sections (left/center/right), keeping cwd + git branch + optional session name on the left when no producer owns the left section. In `new` display mode the git branch carries the border branch icon (`~/pi-x ( trunk)`) and the context token breakdown, prefixed with the total-usage icon (`󰓡 ↑0/↓0/0`), is appended to the right section after the producers.
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
- Safe mode, effective network, and subagent depth form one group: they are joined
  by exactly ` · ` (muted) even when a crowded line switches the other items to
  compact `·`. The group is placed at the `safe-mode` position.
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
  the producer items), prefixed with the total-usage icon and with no cost suffix.
  `safe-mode`, `switch-thinking`, `context-watcher-model`, and
  `context-watcher-percent` are hidden. The git dirty totals also move
  from the first line to the frame top-right.
- `legacy` (status-bar priority): editor frame is the plain pi editor (no side
  borders, no corner labels); status line uses the default layout with the
  effective network token inserted directly after `safe-mode`.

The effective network token (from `permissions-core`) is rendered on exactly one
surface: the editor frame bottom-left in `new` mode, the status line in `legacy`
mode. It is never duplicated across both. `safe-mode` and the token always share
one label joined by exactly ` · `. The review-level producer uses
`px:status-bar:review-level:set` with `{ level }` and
`px:status-bar:review-level:clear`; its icon follows model effort in the top-left label.

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
full frame (heavy `┃` sides + light arc `╭ ╮ ╰ ╯` corners; set
`PI_STATUS_BAR_FRAME_CORNERS=square` or change the source constant
`FRAME_CORNER_STYLE` for the heavy square `┏ ┓ ┗ ┛` corners), enables one column of
horizontal editor padding (`paddingX: 1`), and renders:

- top-left: the model icon `󰙴 ` then active provider + model ID and thinking level (`󰙴 <ctx.model.provider>/<ctx.model.id> · <thinking>`, id-only when provider is missing; e.g. `󰙴 cdx/5.6-sol · high`), with exact-name aliases applied, colored with the frame border color. For explicit review levels, the review icon follows effort after a frame-colored ` · ` and uses the same frame-border color: off `󰛑`, minimal `󱀧`, normal `󰛐`, high `󰡬`. Auto is hidden, though its `󰈈` mapping remains in code. The thinking level is always the full level name (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); it is never abbreviated and has no arrow-only fallback, so on a frame too narrow for the label the model segment is dropped like any other. While streaming the model/effort portion runs a configurable animation (source constant `WORKING_ANIMATION`, env `PI_STATUS_BAR_WORKING_ANIMATION`): `comet` moves a bright lead with a fading trail across the label, `glitch` swaps a few random characters for matrix blocks (`▓▒░`, denser = brighter) with independent lifetimes; no spinner and no `Working` word.
- top-right: git dirty totals, collected internally by `git-stats.ts` and rendered
  only when the repo is dirty. They are split into two icon groups, files first then
  changed lines, separated by ` · `: `󰐖 1 󰍵 2 󰦓 4 · 󰐖 150 󰍵 200`. The counters are
  collected as numbers, so the `+`/`-`/`M` prefixes become Nerd Font icons
  (additions `󰐖`, removals `󰍵`, modified `󰦓`) with no format parsing; the files group
  also carries the modified-file count. Zero values render in
  the subdued accent (a darkened shade of the thinking color `thinkingOff`), while
  non-zero values use the shared git palette. On narrow
  frames the compact split form drops the spaces (`󰐖1󰍵2󰦓4·󰐖150󰍵200`), then the
  changed-line group is dropped to keep the files group (`󰐖1󰍵2󰦓4`). The model label
  remains visible whenever it fits, and labels sharing the top edge need only one
  heavy border dash between them. In `new` mode these totals stay on the border;
  in `legacy` mode they move to the first line right section as
  `+1 -2 M4 · +150 -200`.
- bottom-left: context usage and cumulative cost, prefixed with the context icon
  `󰊚 ` and the price icon `󰇁 ` (`━━ 󰊚 15.9% 210k · 󰇁 0.03 `). The border form has no
  trailing `$`. The label is colored with the subdued accent (a darkened thinking
  color) <=20%, `text` <=30%, `warning` <=50%, and `error` >50%. When subagent
  usage changes the total, cost
  renders as session then total, each with its own icon
  (`󰇁 0.01 Tot󰇁 0.013`), the total with three decimals so small
  subagent spend stays visible. It includes every subagent in the branch, nested
  ones included, and the total is omitted while it rounds to the same three-decimal
  value as the session cost.
- bottom-left, before context: `safe-mode` producer content (for example `SMART`)
  followed by compact network and subagent indicators, joined to the context label
  by the tapered border bridge (`━╾ 󰕥 SMART · 󰅟 ✓? · 󰚩 ✓ ╼━╾ 󰊚 15.9% `). The
  group uses exactly ` · ` between items, which is preserved under crowding. The
  safe-mode text is prefixed with `󰕥 `, which shares its color; `SMART` uses the
  frame border color, while other modes keep the producer color on icon and text.
  Network uses one color for the full indicator and one space after its icon:
  muted `󰅟 ×` for deny-all, the subdued accent (a darkened thinking color) for
  ask-all `󰅟 ?`, allow-trusted `󰅟 ✓`, and ask-untrusted `󰅟 ✓?`, and red
  `󰅟 !` for allow-all. Subagent depth follows network: muted `󰚩 ×` when disabled,
  the subdued accent `󰚩 ✓` for top-level only, and warning-colored `󰚩 N` for
  recursive delegation.
- bottom-right: the unsent message token size in the normal text color, prefixed
  with the message icon `󰍡 ` (`󰍡 1.2k`). Text uses pi's conservative chars/4
  heuristic on the paste-expanded editor text, so it matches what will be sent.
  Pasted image paths are detected, their pixel size is read from the file header
  (PNG/JPEG/GIF/WebP), and the result is converted with DeepSeek's published
  vision calculator (upscale below ~544×544, downscale to ~1300×1300, 1024-token
  cap); this is a first estimate, since other providers tokenize images
  differently. The label is hidden while the editor is empty and dropped before
  the bottom-left labels when the frame is too narrow.

Border labels use spaces instead of angle tacks (`╭━╾ left ╼━╮`).
The frame line is heavy, but every point where it touches a label tapers to a
light half cell so the light side faces the text: `╾` running into a label, `╼`
leaving one. Two bottom-left labels are bridged the same way at both ends
(`╰━╾ A ╼━╾ B ╼━━━╯`).
The frame corner style is switchable: default is `round` (`╭ ╮ ╰ ╯`); set
`PI_STATUS_BAR_FRAME_CORNERS=square` or change the source constant
`FRAME_CORNER_STYLE` for the weight-matched heavy square corners `┏ ┓ ┗ ┛`.
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
