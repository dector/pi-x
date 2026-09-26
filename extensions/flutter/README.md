# flutter (pi extension)

Owns a single `flutter run --debug` process and exposes fast hot reload/restart controls from pi.

The extension only loads when a Flutter project is detected, so it stays out of the way in non-Flutter repositories. Detection checks, in order:

- the current working directory,
- the git repository root,
- the configured `workdir` (see [Configuration](#configuration)).

A directory counts as a Flutter project when it contains a `pubspec.yaml` that mentions `flutter`. Otherwise `/px:flutter` and the shortcuts are not registered.

## Features

- `/px:flutter run` starts `flutter run --debug` in the configured Flutter app workdir, or the current pi cwd when no workdir is configured.
- `/px:flutter run android` starts `flutter run --debug -d android`.
- `/px:flutter run linux` starts `flutter run --debug -d linux`.
- `/px:flutter run <device-id>` passes any other device id to `-d`.
- `/px:flutter reload` or `Alt+R` sends `r` to Flutter stdin for hot reload.
- `/px:flutter restart` or `Alt+Shift+R` sends `R` to Flutter stdin for hot restart.
- `/px:flutter stop` stops the owned process (`q`, then `SIGTERM`, then `SIGKILL` fallback).
- `/px:flutter status` shows pid/device/runtime, resolved Flutter path, and all captured stdout/stderr lines from the current or previous run.
- `/px:flutter env` shows pi cwd, Flutter cwd, resolved Flutter path, PATH, and `flutter --version` from pi's extension environment.
- `/px:flutter doctor` runs `flutter doctor -v` from the same Flutter cwd using the same resolved Flutter binary.
- The running process remains owned, visible, and controllable across `/reload`, `/new`, `/resume`, and `/fork`.

## Status bar

This extension publishes first-line status via the shared [`neo-bar`](../neo-bar/README.md) contract.

It renders in the first-line `right` section with priority `200`, which places it before the neo-bar git totals (`100`) and skill counts (`-100`) in the same section.

Example status:

```text
● Flutter (pid 12345)
```

## Configuration

For monorepos, configure the Flutter app directory so `/px:flutter run`, `/px:flutter env`, and `/px:flutter doctor` do not execute from the repository root.

Create `<repo>/.pi/memory/flutter/config.json`:

```json
{
  "workdir": "apps/mobile"
}
```

`workdir` may be relative to the repo root (when loaded from `<repo>/.pi/memory/flutter/config.json`) or absolute.

## Commands

```text
/px:flutter run [android|linux|device-id]
/px:flutter reload
/px:flutter restart
/px:flutter stop
/px:flutter status
/px:flutter env
/px:flutter doctor
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
- `neo-bar` extension for first-line status rendering

Then run `/reload`.
