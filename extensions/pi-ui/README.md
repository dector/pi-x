# pi-ui (pi extension)

Small UI tweaks for pi.

## Current tweaks

### 1) Working indicator replacement

Replaces the default `Working...` loader with a centered animated thick-pipe indicator.

Features:

- Marker uses in-cell left/center/right phases: `▌ ┃ ▐`
- Smooth truecolor hue cycling
- Indicator is centered horizontally
- Full-width length per frame:
  - always uses full terminal width
- Fast defaults

### 2) Bell when user input is expected (default: on)

Triggers a terminal bell (`\a`) whenever pi is waiting for user input, including:

- when the agent finishes and returns to input mode
- extension-driven prompts (`select`, `confirm`, `input`, `editor`, `custom`)
- session transitions that return to input mode (`session_start`, `session_switch`, `session_fork`, `session_tree`)

### 3) Ctrl+, action dialog (extensible command palette shell)

`pi-ui` owns `Ctrl+,` and toggles a centered overlay dialog intended as a **future expansion point** for quick actions.

Current dialog items:

- **Prompts & Notes**
  - `s - prompt stash…` (opens a stash submenu)
  - `p - prompt history…` (opens the tabbed history dialog)
  - `n/N - new note / browse notes…` (`n` opens the `/px:notes` editor, `N` opens the `/px:notes:list` browser)
- **Agents**
  - `a - subagents…` (opens the `/px:agents` batch list)
  - `Ctrl+R - agents rewiring…` (opens the rewiring menu)
  - `Ctrl+r - rewire agents` (toggle)
- **Access & Safety**
  - `r - toggle reader mode`
  - `+ - toggle outer mode`
  - `! - YOLO+ mode`
- `/ - search all main and prompt-stash actions`
- `↑/↓ - move selection`
- `Enter - run selected action`
- `Esc - close`
- `Ctrl+, - close (toggle)`

Behavior details:

- The dialog uses the status-bar frame language: purple heavy lines (`━`/`┃`), rounded light corners, and tapered `╾`/`╼` joins where the border touches the title.
- Terminal-background filling spans the full overlay width around the compact centered frame, with one empty row above and below. Actions are arranged under non-selectable **Prompts & Notes**, **Agents**, and **Access & Safety** headings. Shortcuts and indicators are right-aligned in one column, with a four-space gutter after the widest action name; `→` and an ellipsis mark actions that open another screen, and `●`/`○` show toggle state.
- The selected row uses the same purple as the frame. Arrow navigation skips group headings.
- Pressing `Esc` or `Backspace` in the main dialog closes it with no side effects.
- Pressing `Ctrl+,` also closes the dialog (same toggle hotkey).
- Pressing `↑/↓` (or `k/j`) moves selection in the action list.
- Pressing `/` enters search. Search covers both main and prompt-stash actions, shows up to eight matches at a time, and does not change any direct hotkeys.
  - Type to filter by action label or shortcut.
  - `↑/↓` moves through results and `Enter` runs the selected result.
  - `Esc` cancels search and returns to the previous menu; `Backspace` does the same when the query is empty.
- Pressing `Enter` executes the currently selected action and closes the dialog, unless the action opens a submenu.
- Pressing `s` (or `S`) opens the prompt-stash submenu:
  - `s` — emits event `px:prompt-stash:stash` and closes the dialog.
  - `o` — emits event `px:prompt-stash:pop` and closes the dialog.
  - `l` — emits event `px:prompt-stash:list` and closes the dialog. The list is selectable; `Enter` restores the selected stash.
  - `x` — emits event `px:prompt-stash:clear-all` and closes the dialog.
  - `<-` / `Backspace` — returns to the main action dialog.
- Pressing `Ctrl+r` runs **Rewire agents**, emits event `px:subagent:rewire:toggle`, and closes the dialog.
- Pressing `Ctrl+R` runs **Agents rewiring…**, emits event `px:subagent:rewire:menu`, closes the dialog, and opens the rewiring menu.
- Pressing `r` (or `R`) emits event `px:safe-mode:toggle-reader` and closes the dialog.
- Pressing `+` emits event `px:safe-mode:toggle-outer` and closes the dialog.
- Pressing `!` emits event `px:safe-mode:set-yolo-plus` and closes the dialog.
- Pressing `p` (or `P`) opens a full-width, tabbed prompt-history dialog in the same visual style:
  - **User prompts** starts at the latest prompt; `↑`/`PgUp` moves back to `-1`, `-2`, and older prompts, while `↓`/`PgDn` moves newer.
  - **First prompt** is the initial, centered tab and shows the first user prompt on the current branch.
  - **Agent responses** starts at the latest final response; it excludes tool-calling/intermediate assistant messages and browses older/newer responses with `↑`/`PgUp` and `↓`/`PgDn`.
  - `←`/`→` or `h`/`l` switches tabs. Each history tab shows its current position and total count.
  - `j`/`k` scrolls the current prompt or response down/up by five lines.
  - The dialog closes via `Esc`, `Enter`, `q`, or `Ctrl+,`.
- Pressing `n` emits event `px:notes:open` and closes the dialog; `notes` then opens its editor.
- Pressing `N` emits event `px:notes:list` and closes the dialog; `notes` then opens its list browser.
- Both notes actions are shown as a single row (`n/N`); pressing `Enter` on it defaults to `n` (editor).
- Toggle dots use severity colors whether on (`●`) or off (`○`):
  - Reader mode: normal/success (green).
  - Outer access: warning (orange/amber from the active theme).
  - YOLO+ and agent rewiring: danger (red).
- Safe-mode rows read live state from the current `safe-mode` session data.
- Agent rewiring mirrors the subagent extension's published rewire status.
- The event payload includes the current extension context (`{ ctx }`) so listeners can apply changes in the active session.
- If `prompt-stash` or `safe-mode` are not installed/enabled, their keys simply close the dialog (no listener handles the event).
- The main overlay spans the available terminal width; its compact frame remains centered and is capped at 38 columns, with a responsive narrow-terminal fallback.
- Prompt-history dialog uses the full available overlay width (`width: 100%`, `minWidth: 40`) and the quick-actions frame language.

Integration contract (important):

- Event names used by `pi-ui`:
  - `px:prompt-stash:stash`
  - `px:prompt-stash:pop`
  - `px:prompt-stash:list`
  - `px:prompt-stash:clear-all`
  - `px:safe-mode:toggle-reader`
  - `px:safe-mode:toggle-outer`
  - `px:safe-mode:set-yolo-plus`
  - `px:notes:open`
  - `px:notes:list`
  - `px:subagent:rewire:toggle`
  - `px:subagent:rewire:menu`
- Expected prompt-stash listener behavior (implemented in `prompt-stash`): save, pop, list/restore, or clear prompt stashes for the active context.
- Expected notes listener behavior (implemented in `notes`): open the `/px:notes` editor for `px:notes:open`, and the `/px:notes:list` browser for `px:notes:list`.
- Expected subagent listener behavior (implemented in `subagent`): toggle the current session rewire for `px:subagent:rewire:toggle`, and open `/px:agents:rewire` for `px:subagent:rewire:menu`.
- Expected safe-mode listener behavior (implemented in `safe-mode`):
  - if mode is not `reader`: switch to `reader` and remember previous mode
  - if mode is `reader` and previous mode exists: restore previous mode
  - if mode is `reader` and no remembered previous mode: no-op
  - for `px:safe-mode:toggle-outer`: toggle `outerAccess`
  - for `px:safe-mode:set-yolo-plus`: toggle `yolo+` (enter `yolo+` and remember previous state; if already in `yolo+`, restore previous state when available)

This dialog is intentionally minimal now, but should be treated as the primary place for adding additional keyboard-triggered UI actions over time.

### 4) Transcript selection, toggle, and navigation (Alt+J, Alt+K, Alt+O)

`Alt+J` / `Alt+K` move a transcript selection one entry down / up and scroll that entry to the top of the viewport. Every visible entry counts, collapsed or not: user messages, assistant messages, tool calls, `!` bash runs, custom messages and entries, summaries, and skill invocations.

Entries with nothing to show are skipped, so navigation follows what you actually see:

- zero-height entries (for example an assistant message with no rendered content)
- assistant messages that only request tools while thinking is hidden — pi renders those as a `Thinking...` placeholder plus padding

The selected entry is marked by the active **selection marker** (`PI_UI_SELECTION_MARKER`, or `/px:pi-ui-marker` at runtime). The default `chip` marker draws a right-aligned intense purple pill with pure white text, framed by Nerd Font chevrons (`nf-md-chevron_down` / `nf-md-chevron_up`), e.g. `󰅀 tool · 310/312 󰅁`: the entry label is italic, the background is a fixed branded purple (`#5b21b6`) on truecolor terminals and the theme's own purple on 256-colour terminals, it appears at the entry's own screen row, and it disappears after 1.5 s. The `none` marker draws nothing. Adding a marker is a single entry in `SELECTION_MARKERS` in `index.ts`.

`Alt+End` and `Alt+O` select the last entry; `Alt+Home` (Alt+Start on keyboards that label the key that way) selects the first.

`Ctrl+Alt+O` toggles **the selected entry** — nothing else, and it never falls back to "the latest entry". It behaves like clicking that entry's result area:

- tool calls (read/bash/edit/write/grep/find/ls and extension tools)
- `!` bash mode executions
- custom messages and custom entries from other extensions
- compaction and branch summaries
- skill invocation messages

Entries without a collapsed state (plain user and assistant messages) answer with a notification instead. After a reload, nothing is selected: press `Alt+K` once to select the newest entry, then `Alt+O`.

Implementation notes:

- Everything is read-only on pi's side. Entries are found by walking the transcript's layout tree from the primary `ScrollView` and matching known entry component class names; no component prototypes are patched and nothing is registered ahead of time, so session restore and `/reload` need no special handling.
- Entry line offsets come from the child heights recorded during the last render (`mouseLayout`); navigation then calls `scrollTo(line)`.
- The `chip` marker is an overlay (`showOverlay` with `row`, `col`, `width`, `nonCapturing`), so it marks a row without stealing keyboard focus. Its background is a fixed intense purple in truecolor mode and the theme's `thinkingHigh` colour reused as a background (`getFgAnsi` → `48;…`) otherwise; without a captured theme it falls back to inverse video, like pi's own flash messages.
- The TUI reference comes from a hidden zero-height widget registered with `setWidget`.
- Everything is coupled to pi internals and requires fullscreen TUI mode; if pi renames the components or moves the scroll view, the shortcuts report a notification instead of doing the wrong thing (`/px:pi-ui-nav` shows entry count, selection, and scroll-view state).

## Configuration

### Env vars

- `PI_UI_WORKING_LENGTH` — minimum track length (default: `15`, range: `15-400`) (kept for compatibility; full-width mode still uses terminal width)
- `PI_UI_WORKING_INTERVAL_MS` — animation speed in ms (default: `16`, minimum: `5`)
- `PI_UI_WORKING_HUE_STEP_DEG` — hue change per frame in degrees (default: `8`)
- `PI_UI_SELECTION_MARKER` — selection marker: `chip` (default) or `none`
- `PI_UI_BELL` — enable/disable bell notifications (default: `true`)
- `PI_UI_BELL_DEBOUNCE_MS` — minimum milliseconds between bells (default: `250`, range: `0-5000`)

Example:

```bash
PI_UI_WORKING_LENGTH=24 PI_UI_WORKING_INTERVAL_MS=16 PI_UI_WORKING_HUE_STEP_DEG=8 PI_UI_BELL=true PI_UI_BELL_DEBOUNCE_MS=250 pi
```

### Runtime command

- `/px:pi-ui-working-length <15-400>` — set compatibility minimum length (full-width mode still uses terminal width)
- `/px:pi-ui-bell [on|off|toggle|status]` — control bell notifications
- `/px:pi-ui-marker [chip|none|status]` — choose the selection marker
- `/px:pi-ui-nav` — show transcript entry count, the current selection, and scroll-view state

### Shortcut

- `Alt+J` / `Alt+K` — select and scroll to the next / previous transcript entry
- `Alt+End` / `Alt+O` — select the last transcript entry; `Alt+Home` (Alt+Start) — the first
- `Ctrl+Alt+O` — toggle the selected transcript entry (same as clicking it)
- `Ctrl+,` — toggle the `pi-ui` action dialog
  - `↑/↓` (or `k/j`) — move selection
  - `Enter` — run selected action
  - `/` — enter global action search (`Esc` cancels search)
  - `s` — open prompt-stash submenu
    - `s` — request prompt-stash stash via `px:prompt-stash:stash`
    - `o` — request prompt-stash pop via `px:prompt-stash:pop`
    - `l` — request prompt-stash list/restore via `px:prompt-stash:list`
    - `x` — request prompt-stash clear-all via `px:prompt-stash:clear-all`
    - `<-` / `Backspace` — return to main action dialog
  - `Ctrl+r` — request a subagent rewire toggle via `px:subagent:rewire:toggle`
  - `Ctrl+R` — request the subagent rewire menu via `px:subagent:rewire:menu`
  - `r` — request safe-mode reader toggle via `px:safe-mode:toggle-reader`
  - `+` — request safe-mode outer toggle via `px:safe-mode:toggle-outer`
  - `!` — request safe-mode `yolo+` toggle via `px:safe-mode:set-yolo-plus`
  - `p` — open the tabbed prompt-history dialog
    - `←`/`→` or `h`/`l` — switch between User prompts, First prompt, and Agent responses
    - `↑`/`PgUp` and `↓`/`PgDn` — browse older and newer entries on the history tabs
    - `j`/`k` — scroll the current text down/up by five lines
    - `Esc`, `Enter`, `q`, or `Ctrl+,` — close
  - `n/N` — request notes editor (`n`) or notes list (`N`) via `px:notes:open` / `px:notes:list`
  - `Esc` — close dialog
  - `Backspace` — close main dialog, or return from submenu to main dialog
  - `Ctrl+,` — close dialog (toggle)

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/pi-ui/`
- Project-local: `.pi/extensions/pi-ui/`

Required file:

- `index.ts`

Then run `/reload`.
