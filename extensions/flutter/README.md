# flutter (pi extension)

Owns a single `flutter run --debug` process and exposes fast hot reload/restart controls from pi.

## Features

- `/flutter run` starts `flutter run --debug` in the current pi cwd.
- `/flutter run android` starts `flutter run --debug -d android`.
- `/flutter run linux` starts `flutter run --debug -d linux`.
- `/flutter run <device-id>` passes any other device id to `-d`.
- `/flutter reload` or `Alt+R` sends `r` to Flutter stdin for hot reload.
- `/flutter restart` or `Alt+Shift+R` sends `R` to Flutter stdin for hot restart.
- `/flutter stop` stops the owned process (`q`, then `SIGTERM`, then `SIGKILL` fallback).
- `/flutter status` shows pid/device/runtime, resolved Flutter path, and all captured stdout/stderr lines from the current or previous run.
- `/flutter env` shows cwd, resolved Flutter path, PATH, and `flutter --version` from pi's extension environment.
- `/flutter doctor` runs `flutter doctor -v` using the same resolved Flutter binary.
- The running process remains owned, visible, and controllable across `/reload`, `/new`, `/resume`, and `/fork`.

## Status bar

This extension publishes first-line status via the shared [`status-bar`](../status-bar/README.md) contract.

It renders in the first-line `right` section with priority `200`, which places it before `repo-stats` (`100`) and `skill-stats` (`-100`) in the same section.

Example status:

```text
● Flutter (pid 12345)
```

## Commands

```text
/flutter run [android|linux|device-id]
/flutter reload
/flutter restart
/flutter stop
/flutter status
/flutter env
/flutter doctor
```

## Shortcuts

- `Alt+R` — hot reload
- `Alt+Shift+R` — hot restart

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/flutter/`
- Project-local: `.pi/extensions/flutter/`

Dependencies:

- `flutter` CLI available on `PATH`
- `status-bar` extension for first-line status rendering

Then run `/reload`.
