# pi-ui (pi extension)

Small UI tweaks for pi.

## Current tweak

Replaces the default `Working...` loader with a centered animated dot indicator.

Features:

- Uses a **center dot** (`·`) as the moving ball
- Ball color transitions are smooth (truecolor HSV hue cycling)
- Indicator is centered horizontally
- Dynamic length per frame:
  - `max(width/3, minimumLength)`
  - if terminal width is below `minimumLength`, uses full width

## Configuration

### Env vars

- `PI_UI_WORKING_LENGTH` — minimum track length (default: `15`, range: `15-400`)
- `PI_UI_WORKING_INTERVAL_MS` — animation speed in ms (default: `80`)
- `PI_UI_WORKING_HUE_STEP_DEG` — hue change per frame in degrees (default: `3`)

Example:

```bash
PI_UI_WORKING_LENGTH=24 PI_UI_WORKING_INTERVAL_MS=120 PI_UI_WORKING_HUE_STEP_DEG=2 pi
```

### Runtime command

- `/pi-ui-working-length <15-400>` — change minimum length in current session

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/pi-ui/`
- Project-local: `.pi/extensions/pi-ui/`

Required file:

- `index.ts`

Then run `/reload`.
