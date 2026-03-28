# pi-ui (pi extension)

Small UI tweaks for pi.

## Current tweak

Replaces the default `Working...` loader text with an animated bracket track:

- `[·    ]`
- `[ ·   ]`
- `[  ·  ]`
- ...

Features:

- Uses a **center dot** (`·`) as the moving ball
- Ball color changes every frame (rainbow palette)
- Track length is configurable

## Configuration

### Env vars

- `PI_UI_WORKING_LENGTH` — track length (default: `5`, range: `2-40`)
- `PI_UI_WORKING_INTERVAL_MS` — animation speed in ms (default: `160`)

Example:

```bash
PI_UI_WORKING_LENGTH=8 PI_UI_WORKING_INTERVAL_MS=120 pi
```

### Runtime command

- `/pi-ui-working-length <2-40>` — change track length in current session

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/pi-ui/`
- Project-local: `.pi/extensions/pi-ui/`

Required file:

- `index.ts`

Then run `/reload`.
