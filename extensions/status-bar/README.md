# status-bar (pi extension)

Centralized status-bar renderer for producer extensions.

## Dependency role

`status-bar` is a shared dependency for other extensions in this repository.
Install and enable it first so producer extensions can render their status output.

## Contract

### Availability

- `px:status-bar:ping` with `{ id }`
- `px:status-bar:pong` with `{ id }`

When `status-bar` receives a valid ping payload, it emits a pong payload echoing the same `id`.

### Second line sections

- Sections: `left`, `center`, `right`
- Default order (used by `legacy` display mode):
  - `left: ["safe-mode", "switch-thinking"]`
  - `center: []`
  - `right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"]`
- `new` display mode uses an empty second line (see [Display mode](#display-mode)) because
  context/model/safe-mode are shown on the editor frame border and the token breakdown
  moves to the first line.
- `context-watcher-*` IDs are computed internally by `status-bar` from active context usage/model.
- Token label format: `↑<input>/↓<output>/<cacheRead>`.
- Cost suffix: for providers in the cost-display whitelist (currently `deepseek`), the label gains a cumulative session cost suffix ` ($<price>)`, for example `↑12k/↓3.4k/45k ($0.0023)`.
  - Cost comes from pi's per-message `usage.cost.total` (derived from the model price table), summed over the active branch.
  - Precision is capped at 2 decimals (for example `$0.05`); non-zero amounts below half a cent render as `<$0.01`.
  - No suffix is rendered when cost is unavailable or zero.
- Events:
  - `px:status-bar:set` with `{ id, content }`
  - `px:status-bar:clear` with `{ id }`
- Item delimiter inside a section: ` · `
- Section delimiter: two spaces (`  `)

### First line sections

- Sections: `left`, `center`, `right`
- Events:
  - `px:status-bar:first-line:set` with `{ id, content, section?, priority? }`
  - `px:status-bar:first-line:clear` with `{ id }`
- Compatibility: omitted `section` defaults to `left`.
- Resolution inside each section:
  - highest `priority` first (default `0`)
  - tie-breaker: stable first-registration order
  - item delimiter: ` · `
- If no first-line producer exists, fallback to the built-in cwd/branch/session line.
- If producers exist but none provide left-section content, the built-in cwd/branch/session line remains on the left.
- `new` display mode appends the context token breakdown (`↑<input>/↓<output>/<cacheRead>`,
  no cost suffix) to the first-line right section, after the producer items
  (that is, after the `SKILLS: n/m` counter when present).

### Extra rows

- Events:
  - `px:status-bar:row:set` with `{ id, content, order? }`
  - `px:status-bar:row:clear` with `{ id }`
- Each registered id renders as its own footer line **after** the two built-in
  lines, sorted by `order` ascending (default: stable first-registration order).
- Content is rendered verbatim (already colored by the producer); each line is
  sanitized (newlines/tabs collapsed) and truncated to the terminal width.
- Empty/whitespace-only content is skipped. Rows are hidden while no producer
  has published content.
- Rows are display-mode agnostic (rendered in both `new` and `legacy`).
- Current producer: [`proc`](../proc/README.md) (id `proc`, order `100`).

### Editor frame

`status-bar` also replaces the editor component with a `CustomEditor` subclass.
The input frame is drawn with side borders and corner characters, and compact
labels are rendered in the frame corners:

```
╭-< cdx/5.6-sol >────────────────────────────────────╮
│ ... input ...                                         │
╰-< 🢁 HIGH · 15.9% 210k · 0.03$ >-------< SMART >-╯
```

- The inner editor is rendered 2 columns narrower and wrapped with `│` side
  borders and rounded corners (`╭ ╮ ╰ ╯`). The editor uses one column of
  horizontal padding (`paddingX: 1`), so input sits at `│ <input> │`. The
  autocomplete list stays outside the frame and is indented to line up.
- Every border text label is delimited with ASCII angle tacks on both sides:
  `-< <label> >-`.
- Mouse coordinates are translated by one column so click-to-position keeps working.
- **bottom-left** — thinking level, context usage, and cost.
  - Format: `-< <thinking> · <percent> <tokens> · <cost> >-`.
  - `thinking`: arrow indicator plus the 3-4 uppercase level symbol:
    `off` → `✘ OFF`, `minimal` → `🡻🡻 MIN`, `low` → `🡻 LOW`, `medium` → `🡺 MED`,
    `high` → `🢁 HIGH`, `xhigh` → `🢁🢁 XHI`, `max` → `🢁🢁🢁 MAX`; unknown levels are
    truncated to 4 uppercase chars with no indicator.
  - `percent`: current context usage percent, one decimal (for example `15.9%`), or `--` when unknown.
  - `tokens`: current context usage tokens, compact (for example `210k`), or `--` when unknown.
  - `cost`: cumulative session cost with a trailing `$` (for example `0.03$`).
    Zero/unavailable renders as `0.00$`; non-zero below half a cent renders as `<0.01$`.
    When subagent usage changes the total, the label shows session | total:
    `0.01$ | 0.013$`. The total renders with three decimals to keep small
    subagent spend visible, and adds every subagent cost found in the branch,
    nested subagents included. The suffix is omitted while the total rounds to
    the same three-decimal value as the session cost.
  - The frame label is independent of the second-line cost whitelist: it always shows
    accumulated `usage.cost.total` from the active branch.
  - The label uses the same context-usage color rules as the status-bar context items:
    `muted` up to 20%, `text` up to 30%, `warning` up to 50%, `error` above 50%.
    It stays uncolored when context percent is unknown.
- **bottom-right** — `safe-mode` status content (`SMART`, `READER`, `YOLO`,
  `PARANOID`, plus `+` when outer access is on). Rendered only while the
  `safe-mode` producer has published content.
- **top-left** — active provider + model (`<ctx.model.provider>/<ctx.model.id>`, e.g.
  `deepseek/deepseek-chat`; id-only when provider is missing), rendered in the frame
  border color. Hidden when no model is active. Both parts go through the exact-name
  alias tables (see [Aliases](#aliases)), so the example above can render as
  `cdx/5.6-sol` or `opencode/4.1-flash`.
  - While streaming, a leading character of the model label is highlighted in the
    theme `text` color (bold) and bounces back and forth across the label. A fading
    3-character trail follows behind the direction of motion (`text` -> `muted` ->
    `dim`), for example `[c]dx/5.6-sol` -> `c[d]x/5.6-sol` -> ... -> `cdx/5.6-so[l]`
    -> ... -> `[c]dx/5.6-sol`. No spinner is shown and the word `Working` never
    appears. The highlight advances every 120 ms.
- Corner labels are prefixed with a space and followed by one border dash before
  the corner. They are dropped when the terminal is too narrow.
- When the editor is scrolled, the `↓ N more` indicator sits to the left of the
  bottom-right label; the `↑ N more` indicator sits on the right of the top border.
- On `session_shutdown` the previously configured editor factory is restored.

### Display mode

`displayMode` controls where context/model/safe-mode information lives:

- `new` (default) — border priority.
  - Editor frame shows the corner labels (bottom-left context, top-left model, bottom-right safe-mode).
  - Status line 2 is omitted (all sections empty): `left: []`, `center: []`, `right: []`.
  - The input/output/cache token breakdown moves to status line 1, right after the
    producer items (after the `SKILLS: n/m` counter), and omits the cost suffix
    because the border already shows cost.
  - `safe-mode`, `switch-thinking` (favorite thinking modes), model, and percent are hidden.
- `legacy` — status-bar priority.
  - Editor frame is the plain pi editor (horizontal borders only, no corner labels).
  - Status line uses the default layout: `left: ["safe-mode", "switch-thinking"]`,
    `right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"]`.

Set it with:

- `/px:status-bar-display-mode new` or `/px:status-bar-display-mode legacy`
- `~/.pi/agent/status-bar.json`: `{ "displayMode": "new" }`
- env override: `PI_STATUS_BAR_DISPLAY_MODE=new|legacy` (takes precedence over the file)

### Aliases

Short labels for the border `provider/model` text come from two exact-name tables
in `~/.pi/agent/status-bar.json`. Matching is by exact id only (no patterns).

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

- `providerAliases`: `ctx.model.provider` -> short label. Applied to the border label only.
- `modelAliases`: `ctx.model.id` -> short label. Applied wherever the model is shown
  (border and legacy `context-watcher-model`).
- Missing keys fall back to the raw provider/model id.
- Loaded at session start; edit the file and restart/reload to apply.

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

Extra-row producers:

- `proc` (id `proc`)

## Commands

- `/px:status-bar-contract`
  - Opens a read-only settings-style view with contract, ping/pong availability events, renderer details, and the active display mode/layout.
- `/px:status-bar-display-mode [new|legacy]`
  - Shows or sets the display mode and persists it to `~/.pi/agent/status-bar.json`.
- `/px:status-bar-set <id> <content>`
  - Sets test content for a second-line ID and re-renders.
- `/px:status-bar-clear <id>`
  - Clears test content for a second-line ID and re-renders.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/status-bar/`
- Project-local: `.pi/extensions/status-bar/`

Required files:

- `index.ts`
- `contract.ts`

Then run `/reload`.
