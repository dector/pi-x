# pi-nvim (pi extension)

Unix-socket bridge for sending prompts into a running pi session.

## Compatibility and inspiration

- Inspired by the upstream `pi-nvim` extension/plugin project: https://github.com/carderne/pi-nvim
- This extension is wire-compatible with that Neovim plugin (commands like `:PiPing`, `:PiSend`, `:PiSessions`).

## Protocol (newline-delimited JSON)

Supported requests:

- `{"type":"ping"}`
- `{"type":"prompt","message":"your prompt"}`

Responses:

- `{"ok":true,"type":"pong"}`
- `{"ok":true}`
- `{"ok":false,"error":"..."}`

## Runtime artifacts

- Sockets dir: `/tmp/pi-nvim-sockets`
- Latest symlink: `/tmp/pi-nvim-latest.sock`
- Session metadata: `<socket>.info`

`.info` is single-line JSON and contains:

- `protocolVersion`
- `cwd`
- `pid`
- `startedAt`
- `socketPath`

## Session discovery behavior (for Neovim clients)

Recommended selection order:

1. Scan `/tmp/pi-nvim-sockets/*.info`
2. Prefer live socket whose `.info.cwd` matches current Neovim `cwd`
3. If none match, pick newest live socket
4. Fallback to `/tmp/pi-nvim-latest.sock`

## Quick test (CLI)

```bash
# Ping latest session
printf '{"type":"ping"}\n' | socat - UNIX-CONNECT:/tmp/pi-nvim-latest.sock

# Send prompt
printf '{"type":"prompt","message":"hello from nvim bridge"}\n' | socat - UNIX-CONNECT:/tmp/pi-nvim-latest.sock
```

### Smoke test script (repo)

From repo root, run:

```bash
scripts/pi-nvim-smoke.sh
```

Optional args/env:

```bash
# Custom prompt text
scripts/pi-nvim-smoke.sh "hello from smoke test"

# Override socket path
PI_NVIM_SOCKET_PATH=/tmp/pi-nvim-latest.sock scripts/pi-nvim-smoke.sh
```

In pi:

- `/pi-nvim-info` shows active socket path.

## Compatibility test matrix (Neovim)

Run these with your compatible plugin (e.g. `carderne/pi-nvim`):

1. `:PiPing`
   - Expected: success notification (`pong`/alive)
2. `:PiSend`
   - Expected: prompt arrives in active pi session
3. `:PiSessions`
   - Expected: lists live sessions
   - Expected routing: cwd-matching session preferred, newest live session fallback
