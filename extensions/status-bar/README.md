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
- In `new` display mode the git branch carries the border branch icon inside the
  parentheses (`~/pi-x ( trunk)`); the path itself gets no icon. `legacy`
  mode keeps the plain `~/pi-x (trunk)` form.
- When session rewiring is enabled, the first-line right section shows a red
  `󰚩 󰒟 <provider>/<model> · <effort>` immediately before the skills counter. Provider
  and model aliases are applied, for example `󰚩 󰒟 cdx/5.6-sol · high`.
- `new` display mode appends the context token breakdown to the first-line right
  section, after the producer items (that is, after the skills `󰐱 n/m` counter
  when present). It is prefixed with the total-usage icon and omits the cost
  suffix: `󰓡 ↑<input>/↓<output>/<cacheRead>`.

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
- Current producers:
  - [`proc`](../proc/README.md) (id `proc`, order `100`).
  - `hub-progress` (id `hub-progress`, order `50`) — see [Progress row](#progress-row).

### Progress row

`status-bar` observes the hub semantic-progress protocol and renders the active
progress text near the status bar. It subscribes to `hub:progress:changed` and,
on `session_start` and `session_tree`, issues a correlated
`hub:progress:query` after installing its `hub:progress:snapshot` listener. The
text is hidden while no tracker is active.

- Contract mirror: `status-bar` does not import hub runtime files; channels and
  snapshot types are mirrored locally in `progress.ts`.
- Every text field (`title`, `unit`, `label`, `phase`) is stripped of ANSI/OSC
  escapes and all C0/C1 controls by `sanitizeUntrustedProgressText` before
  rendering.
- Placement, in priority order:
  1. appended to the first line of the status bar when it fits;
  2. otherwise rendered as a leading footer line between the input and the
     status bar;
  3. on very narrow screens (for example a phone) the text is shortened
     (`Milestone` -> `M`, `Phase` -> `P`, `Step` -> `St`, ...) and wrapped to at
     most three lines, with a trailing `...` when it still does not fit.
- The text uses the editor frame's thinking-level border color (purple in the
  default style).
- Formats:
  - one flat active/blocked leaf:
    `Authentication · Stage 1/13: Database schema · reviewing`;
  - one hierarchical leaf:
    `Milestone 1/3 · Stage 2/4: Authentication · reviewing`;
    absent labels, path levels, and phases are omitted naturally;
  - several active/blocked: `Authentication · 4/13 done · 2 active · 1 blocked`
    (optional `blocked`/`failed`/`skipped` counts only when non-zero);
  - none active/blocked but pending remains:
    `Authentication · 4/13 done · 9 pending`;
  - all leaves terminal but unfinished:
    `Authentication · 13/13 settled · awaiting finish`.
- With several active trackers, the most recently updated tracker is rendered
  and ` · +N trackers` is appended.
- State is cleared on `session_shutdown`; late `changed` events are ignored so a
  previous session's row cannot reappear.

### Editor frame

`status-bar` also replaces the editor component with a `CustomEditor` subclass.
The input frame is drawn with side borders and corner characters, and compact
labels are rendered in the frame corners:

```
╭━╾ 󰙴 cdx/5.6-sol · high ╼━━╾ 󰐖 1 󰍵 2 󰦓 4 · 󰐖 150 󰍵 200 ╼━╮
┃ ... input ...                                  ┃
╰━╾ 󰕥 SMART · 󰅟 ✓? · 󰚩 ✓ ╼━╾ 󰊚 15.9% 210k · 󰇁 0.03 ╼━━━╾ 󰍡 1.2k ╼━╯
```

- The inner editor is rendered 2 columns narrower and wrapped with heavy `┃`
  side borders and light arc corners (`╭ ╮ ╰ ╯`). The editor uses one column of
  horizontal padding (`paddingX: 1`), so input sits at `┃ <input> ┃`. The
  autocomplete list stays outside the frame and is indented to line up.
- Corner style: Unicode has no heavy arcs, so the short arc is a slightly thinner
  stroke than the `━`/`┃` lines. Set `PI_STATUS_BAR_FRAME_CORNERS=square` (or
  change the `FRAME_CORNER_STYLE` constant) for the weight-matched heavy square
  corners `┏ ┓ ┗ ┛`.
- Border labels use spaces instead of angle tacks: `╭━╾ <left> ╼━╮`. The line
  itself is heavy, but wherever it touches a label the last glyph is a
  light/heavy half cell, so the light half always faces the text: `╾` when the
  line runs into a label, `╼` when it leaves one. Two labels sharing the
  bottom-left edge are bridged the same way on both ends:
  `╰━╾ <safe-mode> · <network> ╼━╾ <context> ╼━━━╯`.
  Safe mode and the network token always share one label and keep the spaced
  ` · ` separator even when the status line is crowded.
- Mouse coordinates are translated by one column so click-to-position keeps working.
- Pressing the configured interrupt key (Escape by default) while an agent operation is active opens a `y/n` confirmation instead of aborting immediately. Declining (or pressing Escape again) keeps the operation running, and idle Escape behavior is unchanged.
- **top-right** — git dirty totals from `repo-stats`, rendered as two icon groups,
  files first then changed lines, separated by ` · `:
  `󰐖 1 󰍵 2 󰦓 4 · 󰐖 150 󰍵 200 ━━`. Rendered only when the repo is dirty. The
  producer's `[ ]`/`|` markers and `+`/`-`/`M` prefixes are replaced by Nerd Font
  icons (additions `󰐖`, removals `󰍵`, modified `󰦓`); the files group also carries
  the modified-file count. Zero values render in the subdued accent (a darkened
  shade of the thinking color `thinkingOff`), while non-zero values keep the
  producer's colors. On narrow frames the compact split form drops
  the spaces (`󰐖1󰍵2󰦓4·󰐖150󰍵200`), then the changed-line group is dropped, keeping the
  files group (`󰐖1󰍵2󰦓4`). The model label remains visible whenever it fits. Labels
  sharing the top edge need only one heavy border dash between them. In `new` mode
  the totals are hidden from the first line to avoid duplication; in `legacy` mode
  they stay on the first line.
- **bottom-left** — safe-mode status followed by effective network policy, subagent depth, and context usage/cost.
  - Format: `━╾ 󰕥 <safe-mode> · <network> · <subagents> ╼━╾ 󰊚 <percent> <tokens> · 󰇁 <cost> `. The
    network-to-context bridge is tapered on both label sides, so the line reads
    as one heavy stroke that thins out where it meets either label. The safe-mode
    and network parts are omitted when their producer/core is absent.
  - **network** — compact effective policy from `permissions-core`, shown only
    after safe mode and joined with exactly ` · ` (the dot uses the frame border
    color). One space follows the prefix icon. The complete indicator uses one
    color: deny-all is muted `󰅟 ×`; ask-all, allow-trusted, and ask-untrusted use
    the subdued accent (a darkened thinking color): `󰅟 ?`, `󰅟 ✓`, `󰅟 ✓?`;
    allow-all is red `󰅟 !`. It reflects effective state only, so
    PARANOID renders `󰅟 ?`. In `legacy` mode the existing `NET`/`NET?`/`NET+`
    token moves to the status line instead (see [Display mode](#display-mode));
    exactly one surface renders it.
  - **subagents** — compact delegation depth immediately after network. One
    space follows the prefix icon. Disabled is muted `󰚩 ×`, top-level-only uses
    the subdued accent `󰚩 ✓`, and recursive delegation is warning-colored `󰚩 N`.
  - `percent`: current context usage percent, one decimal (for example `15.9%`), or `--` when unknown.
  - `tokens`: current context usage tokens, compact (for example `210k`), or `--` when unknown.
  - `cost`: cumulative session cost, prefixed with the price icon `󰇁 ` and with no
    trailing `$` in border mode (for example `󰇁 0.03`). Zero/unavailable renders as
    `󰇁 0.00`; non-zero below half a cent renders as `󰇁 <0.01`. When subagent usage
    changes the total, the label shows session then total, each with its own icon:
    `󰇁 0.01 Tot󰇁 0.013`. The total renders with three decimals to keep small subagent
    spend visible, and adds every subagent cost found in the branch, nested
    subagents included. The total is omitted while it rounds to the same
    three-decimal value as the session cost.
  - The frame label is independent of the second-line cost whitelist: it always shows
    accumulated `usage.cost.total` from the active branch.
  - The label uses the subdued accent (a darkened thinking color) up to 20%,
    `text` up to 30%, `warning` up to 50%, and `error` above 50%.
    It stays uncolored when context percent is unknown.
- **safe-mode** (bottom-left, before context) — the `󰕥 ` icon followed by
  `SMART`, `READER`, `YOLO`, `PARANOID`, plus `+` when outer access is on.
  Rendered only while the `safe-mode` producer has published content. `SMART` and
  its icon are colored with the frame border color; other modes keep the producer's
  own color on both the icon and the text.
- **top-left** — the model icon `󰙴 ` followed by provider + model + thinking level
  joined with ` · ` (`󰙴 <provider>/<model> · <thinking>`, e.g.
  `󰙴 deepseek/deepseek-chat · high`; id-only when provider is missing), rendered in
  the frame border color. Hidden when no model is active. Both parts go through the
  exact-name alias tables (see [Aliases](#aliases)), so the example above can render
  as `󰙴 cdx/5.6-sol · high` or `󰙴 opencode/4.1-flash · high`.
  - `effort`: 3-4 lowercase level symbol (`off` → `off`, `minimal` → `min`,
    `low` → `low`, `medium` → `med`, `high` → `high`, `xhigh` → `xhi`,
    `max` → `max`; unknown levels truncated to 4 lowercase chars). On narrow
    screens (e.g. a phone) the text is dropped and only the arrow indicator is
    shown: `off` → `✘`, `minimal` → `🡻🡻`, `low` → `🡻`, `medium` → `🡺`,
    `high` → `🢁`, `xhigh` → `🢁🢁`, `max` → `🢁🢁🢁` (for example
    `󰙴 cdx/5.6-sol · 🡺`).
  - While streaming, the label runs one of two animations (no spinner is shown and
    the word `Working` never appears):
    - `comet` — a leading character is highlighted in the theme `text` color
      (bold) and bounces back and forth across the label. A fading 3-character
      trail follows behind the direction of motion, blending from `text` into the
      label's own border color (the thinking-level color, e.g. purple), so the tail
      dissolves into the label: `[c]dx/5.6-sol` -> `c[d]x/5.6-sol` -> ... ->
      `cdx/5.6-so[l]` -> ... -> `[c]dx/5.6-sol`. Advances every 60 ms.
    - `glitch` — a few random characters (up to 3 at once) are swapped for
      matrix-like blocks (`▓▒░`) for a random number of ticks each. Denser glyphs
      render brighter, so `▓` uses the same bright lead color as `comet` while
      `▒`/`░` fade toward the border color. Cells appear and vanish out of sync.
      Advances every 70 ms.

    The active style is set in source (`WORKING_ANIMATION` in `index.ts`, default
    `comet`) and can be overridden for a quick preview with
    `PI_STATUS_BAR_WORKING_ANIMATION=comet|glitch`. A TUI setting is planned.
- **bottom-right** — unsent message token size in the normal text color,
  prefixed with the message icon `󰍡 ` (`󰍡 1.2k`). Text uses pi's conservative
  chars/4 heuristic on the paste-expanded editor text, so it reflects what will
  actually be sent. Pasted image paths are detected, their pixel size is read from
  the file header (PNG/JPEG/GIF/WebP), and the result is converted with DeepSeek's
  published vision calculator (upscale below ~544×544, downscale to ~1300×1300,
  1024-token cap). That is a first estimate only: other providers tokenize images
  differently, and the path text is counted too. Hidden while the editor is empty;
  dropped before the bottom-left labels when the frame is too narrow.
- Corner labels are separated from the border by spaces; the rest of the border is
  filled with dashes. Labels are dropped when the terminal is too narrow.
- When the editor is scrolled, the `↓ N more` indicator sits on the right of the
  bottom border; the `↑ N more` indicator sits on the right of the top border.
- On `session_shutdown` the previously configured editor factory is restored.

### Display mode

`displayMode` controls where context/model/safe-mode information lives:

- `new` (default) — border priority.
  - Editor frame shows the corner labels (top-left model icon + model · thinking, top-right git totals, bottom-left safe-mode · network + context).
  - Status line 2 is omitted (all sections empty): `left: []`, `center: []`, `right: []`.
  - The input/output/cache token breakdown moves to status line 1, right after the
    producer items (after the skills counter), prefixed with the total-usage icon,
    and omits the cost suffix because the border already shows cost.
  - `safe-mode`, the effective network token, `switch-thinking` (favorite thinking modes), model, and percent are hidden from the status line.
- `legacy` — status-bar priority.
  - Editor frame is the plain pi editor (horizontal borders only, no corner labels).
  - Status line uses the default layout: `left: ["safe-mode", "switch-thinking"]`
    with the effective network token inserted directly after `safe-mode`,
    `right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"]`.
  - The network token is colored by policy: `muted` for deny-all/ask-all and `userMessageText` for allow-trusted/ask-untrusted/allow-all. It is never also rendered on the border.
  - Safe mode and the network token share one item, so the spaced ` · ` between
    them is kept even when a crowded line switches its other items to the compact
    `·` separator. Late `changed` events after `session_shutdown` are ignored, so a
    closed session cannot restore a stale token.

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
- `modelAliases`: model id -> short label. Applied wherever the model is shown
  (border, legacy `context-watcher-model`, and the rewiring indicator).
- The rewiring indicator also applies `providerAliases` to its provider id.
- Missing keys fall back to the raw provider/model id.
- Loaded at session start; edit the file and restart/reload to apply.

## Implementation

`status-bar` renders via a custom footer: `ctx.ui.setFooter(...)`.

The footer renders two core lines (plus optional leading progress lines and extra rows):

1. First line from first-line section events plus built-in cwd + git branch + optional session name on the left when no producer owns the left section; the progress text is appended here when it fits
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

- `proc` (id `proc`, order `100`)

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
- `network.ts`
- `compose.ts`
- `image-tokens.ts`

Then run `/reload`.
