# pi-nvim (pi extension)

Unix-socket bridge for sending prompts into a running pi session.

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

`.info` contains:

- `protocolVersion`
- `cwd`
- `pid`
- `startedAt`
- `socketPath`

## Quick test

```bash
# Ping latest session
printf '{"type":"ping"}\n' | socat - UNIX-CONNECT:/tmp/pi-nvim-latest.sock

# Send prompt
printf '{"type":"prompt","message":"hello from nvim bridge"}\n' | socat - UNIX-CONNECT:/tmp/pi-nvim-latest.sock
```

In pi:

- `/pi-nvim-info` shows active socket path.
