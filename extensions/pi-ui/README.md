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

- `r - toggle reader mode`
- `+ - toggle outer mode`
- `! - YOLO+ mode`
- `↑/↓ - move selection`
- `Enter - run selected action`
- `Esc - close`
- `Ctrl+, - close (toggle)`

Behavior details:

- Pressing `Esc` closes the dialog with no side effects.
- Pressing `Ctrl+,` also closes the dialog (same toggle hotkey).
- Pressing `↑/↓` (or `k/j`) moves selection in the action list.
- Pressing `Enter` executes the currently selected action and closes the dialog.
- Pressing `r` (or `R`) emits event `safe-mode:toggle-reader` and closes the dialog.
- Pressing `+` emits event `safe-mode:toggle-outer` and closes the dialog.
- Pressing `!` emits event `safe-mode:set-yolo-plus` and closes the dialog.
- Rows show live status badges (`[ON]`/`[OFF]`) from current `safe-mode` state.
  - `YOLO+` uses warning-colored `[ON]`; non-risk actions use success-colored `[ON]`.
- The event payload includes the current extension context (`{ ctx }`) so listeners can apply changes in the active session.
- If `safe-mode` is not installed/enabled, these keys simply close the dialog (no listener handles the event).
- Overlay sizing is responsive (`~62%` width, `minWidth: 40`, centered).

Integration contract (important):

- Event names used by `pi-ui`:
  - `safe-mode:toggle-reader`
  - `safe-mode:toggle-outer`
  - `safe-mode:set-yolo-plus`
- Expected listener behavior (implemented in `safe-mode`):
  - if mode is not `reader`: switch to `reader` and remember previous mode
  - if mode is `reader` and previous mode exists: restore previous mode
  - if mode is `reader` and no remembered previous mode: no-op
  - for `safe-mode:toggle-outer`: toggle `outerAccess`
  - for `safe-mode:set-yolo-plus`: toggle `yolo+` (enter `yolo+` and remember previous state; if already in `yolo+`, restore previous state when available)

This dialog is intentionally minimal now, but should be treated as the primary place for adding additional keyboard-triggered UI actions over time.

## Configuration

### Env vars

- `PI_UI_WORKING_LENGTH` — minimum track length (default: `15`, range: `15-400`) (kept for compatibility; full-width mode still uses terminal width)
- `PI_UI_WORKING_INTERVAL_MS` — animation speed in ms (default: `16`, minimum: `5`)
- `PI_UI_WORKING_HUE_STEP_DEG` — hue change per frame in degrees (default: `8`)
- `PI_UI_BELL` — enable/disable bell notifications (default: `true`)
- `PI_UI_BELL_DEBOUNCE_MS` — minimum milliseconds between bells (default: `250`, range: `0-5000`)

Example:

```bash
PI_UI_WORKING_LENGTH=24 PI_UI_WORKING_INTERVAL_MS=16 PI_UI_WORKING_HUE_STEP_DEG=8 PI_UI_BELL=true PI_UI_BELL_DEBOUNCE_MS=250 pi
```

### Runtime command

- `/pi-ui-working-length <15-400>` — set compatibility minimum length (full-width mode still uses terminal width)
- `/pi-ui-bell [on|off|toggle|status]` — control bell notifications

### Shortcut

- `Ctrl+,` — toggle the `pi-ui` action dialog
  - `↑/↓` (or `k/j`) — move selection
  - `Enter` — run selected action
  - `r` — request safe-mode reader toggle via `safe-mode:toggle-reader`
  - `+` — request safe-mode outer toggle via `safe-mode:toggle-outer`
  - `!` — request safe-mode `yolo+` toggle via `safe-mode:set-yolo-plus`
  - `Esc` — close dialog
  - `Ctrl+,` — close dialog (toggle)

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/pi-ui/`
- Project-local: `.pi/extensions/pi-ui/`

Required file:

- `index.ts`

Then run `/reload`.
