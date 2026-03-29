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

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/pi-ui/`
- Project-local: `.pi/extensions/pi-ui/`

Required file:

- `index.ts`

Then run `/reload`.
