# Tunnel — Pi on your phone

**Status:** experimental. Control the active Pi session from a mobile browser. The server runs in the Pi process and listens only on `127.0.0.1`. The same versioned API is available to non-browser clients. See [SPEC.md](SPEC.md) for the design and [PLAN.md](PLAN.md) for implementation stages.

## Install and start

From this repository, run `./install` and restart Pi. Or copy `extensions/tunnel/` into `~/.pi/agent/extensions/tunnel/` and restart Pi. For development, launch `pi -e ./extensions/tunnel/index.ts` from this repo. The extension uses Pi's built-in Bun HTTP runtime and has no third-party runtime dependencies (Elysia could not load inside this Pi build).

In Pi:

```text
/px:tunnel on
/px:tunnel status
/px:tunnel pair      # fresh code for another device
/px:tunnel off       # revokes paired clients and closes the server
```

The default local port is **55555**. Set `PI_TUNNEL_PORT` in Pi's environment before starting Pi to choose another fixed port; a port conflict is an error, not an automatic fallback. The tunnel does not start until you run `on`. It remains active across Pi session switches and `/reload`; it closes on `off` or Pi exit.

## Phone access with Tailscale Serve

Configure Serve yourself on the **machine running Pi** (do not use Funnel or bind the extension to a public interface):

```sh
tailscale serve --bg --https=55555 55555
tailscale serve status
```

Open the resulting `https://<your-node>.<your-tailnet>.ts.net:55555` URL on your phone. The extension accepts `.ts.net` hosts without `PI_TUNNEL_ORIGIN`; browser writes must originate from the exact HTTPS host and port used to open the page. For a custom domain, set `PI_TUNNEL_ORIGIN` to its exact HTTPS origin before launching Pi. Enter the six-digit code shown by `/px:tunnel on`, then continue the current conversation. The code expires after five minutes and can be used once; `/px:tunnel pair` makes a new code. Five bad guesses invalidate the current code. Paired devices reconnect without entering a new code until `/px:tunnel off` or Pi exit.

The Pi process and Tailscale Serve must stay running. Tailscale provides transport; pairing controls who can read/write the Pi session. Paired clients can see sensitive thinking, tool arguments, command output, and file contents. Do not share the code or Serve URL with untrusted people. Never expose the local port directly on the internet.

## On your phone

The page loads the **entire active branch**, including prompts from before the tunnel started. It streams user/assistant/tool activity from Pi. When Pi is busy, choose **Queue** (native Pi follow-up; default), **Steer** (next turn boundary), or **Don't send**. **Stop** aborts the current run; it cannot undo completed tool side effects. Interactive terminal approval requests still require the terminal in v1. Pi does not currently expose a reliable permission-wait event to this extension, so the phone may continue to show “working” while the terminal needs attention. Text prompts only; no remote session navigation or queue editing yet. A session switch in Pi replaces the phone's active conversation while retaining the pairing.

## API for other clients

All routes live under `/api/v1` and are relative to the same Serve URL. JSON writes require `Content-Type: application/json`. Browser clients use an HttpOnly session cookie, non-browser clients exchange a pairing code for a bearer token:

```sh
# Do this with a fresh code, ideally locally; never place a token in a URL.
curl -sS -X POST http://127.0.0.1:55555/api/v1/pair \
  -H 'Content-Type: application/json' \
  -d '{"code":"123456","mode":"client"}'
# Response: {"token":"...","tokenType":"Bearer"}
```

Use `Authorization: Bearer TOKEN` for `GET /api/v1/session` (current branch entries/status) and `GET /api/v1/events` (SSE). A client can `POST /api/v1/prompts` with `{ "text": "...", "mode": "normal" | "followUp" | "steer" }`, or `POST /api/v1/abort` with `{}`. Both writes require an `Idempotency-Key` header containing a unique 8–128-character alphanumeric/underscore/hyphen value; retry with the **same** key, not a new one. Responses acknowledge acceptance, not completed generation. An SSE reconnect can resnapshot via `/session`; native Pi content is inside a thin `{seq,sessionId,kind,data}` event envelope. For a very large branch, the SSE stream emits `snapshot_omitted` instead of duplicating the full branch; use `/session` for the complete snapshot. Do not build clients that assume all native Pi event shapes remain stable between Pi upgrades.

## Limits / troubleshooting

- **Port in use:** another Pi may already serve on that port. Set a different `PI_TUNNEL_PORT` and configure a matching Serve endpoint. V1 has one Pi per local port; a future gateway will offer one URL for several terminals/projects.
- **Unauthorized:** pair again with a fresh code; `/px:tunnel off` and Pi exit revoke previous credentials.
- **After Pi `/reload` or session change:** allow the page to reconnect; if the extension did not reload successfully, the server fails closed.
- **No updates:** check that Pi is still running and `tailscale serve status` points at the selected local port.
