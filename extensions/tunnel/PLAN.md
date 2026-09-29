# Implementation plan — phone-first tunnel

Delivery target: run `/px:tunnel on` in an interactive Pi terminal, pair a phone through manually configured Tailscale Serve HTTPS, view the existing active branch, send prompts, steer or queue while busy, and stop a run. V1 is one Pi process per fixed local port; no gateway.

## Architecture and boundaries

```
Pi event handlers + command (index.ts)
    ⇅  disposable current-session adapter (never hold stale Pi API)
Process-local server owner (server.ts, native Bun HTTP)
    ├── in-memory pairing/client credentials (auth.ts)
    ├── versioned JSON API + SSE broadcaster
    └── same-origin mobile UI (web/*)
127.0.0.1:fixed-port ← user-managed Tailscale Serve HTTPS ← phone
```

The process-local owner holds the port and credentials across Pi session replacement and `/reload`; each new extension instance rebinds the current-session adapter and event handlers. Writes during handoff reject with a retriable response, never route to an old session. All network entry points validate auth and input before touching Pi. The adapter reads Pi's active branch (native entries) and reports events from Pi; the server does not invent a separate conversation or prompt queue.

### Protocol contract to implement

- `POST /api/v1/pair`: browser JSON `{code}` → HttpOnly cookie; non-browser bearer exchange with explicit mode. One use/five minutes/five failed attempts; no credentials in URL.
- `GET /api/v1/session`: authenticated `{sessionId,cwd,name?,entries,busy,seq}`. Entries are native Pi active-branch entries.
- `GET /api/v1/events`: authenticated SSE `{seq,sessionId,kind,data}`; event kinds minimally `message_start`, `message_update`, `message_end`, `agent_start`, `agent_end`, `session_change`, `attention`. Live messages carry native Pi data.
- `POST /api/v1/prompts`: `{text,mode,idempotencyKey}`, where mode is `normal`, `followUp`, or `steer`. `normal` rejects when busy; other modes use Pi's native delivery options. Acknowledgement means accepted, not completed.
- `POST /api/v1/abort`: Pi native abort on the active session.
- Snapshot/live handoff: server buffers events during snapshot or offers monotonically increasing sequence and reconciliation; UI resnapshots on any reconnect/session change.

## Stages and commit boundaries

1. **Transport/auth** (server/auth/tests/package): verify the HTTP transport runs in installed Pi's runtime (Elysia failed bundled Pi's TypeBox compatibility check, so use native Bun HTTP), define narrow adapter interface, implement localhost bind, pairing cookie/bearer, Origin/CSRF checks, bounded request/stream buffers, idempotency, snapshot/SSE/prompt/abort routes. Tests cover expiration, guessing lockout, token revocation, auth, cross-origin writes, lifecycle rebinding, duplicate submissions. Commit `feat(tunnel): add authenticated local API server`.
2. **Phone web UI** (web assets): pairing and reconnect flows, native history and live message rendering (thinking/tool content safely escaped), mobile keyboard/safe areas, copyable code, explicit Queue/Steer/Don't send and Stop, honest status/attention UI. Independent of Pi internals except documented API. Commit `feat(tunnel): add mobile-first chat client`.
3. **Pi bridge** (index.ts + bridge tests): `/px:tunnel on|off|status|pair`, port/origin config, process owner/rebind on session switch/fork/tree/reload; session snapshots, Pi events, native send modes/abort. Test fake Pi event emitter for stale contexts and branch changes. Commit `feat(tunnel): connect server to active Pi session`.
4. **Delivery integration** (install, README, tests/fixes): add extension to install whitelist/dependency flow; document Bun HTTP runtime setup, Tailscale Serve manual setup, secret handling, API examples, phone pairing and second terminal port conflict. Smoke Pi locally, API security/integration tests, run broad regression checks, address issues in narrow follow-up commits. Commit `docs(tunnel): document install and phone pairing` plus focused fix commits if needed.

## Acceptance and release gates

- Automated: Bun tests of auth/API/bridge, static JS syntax/HTML checks, install script syntax, no committed node_modules, no credentials in logs or repository.
- Live smoke: run Pi with extension, start tunnel, pair, read preexisting conversation, send while idle, Queue/Steer while busy, stop, switch active session and `/reload` without repairing, verify off/restart revokes cookies. Confirm narrow phone viewport and sleep/reconnect UX with browser if available.
- Security: direct unauthenticated API/SSE denied; rate-limited pairing; cross-origin writes denied; fixed loopback binding; redacted server logs; stale Pi runtime calls rejected during handoff.
- Constraints: exact rendering of Pi's richer blocks and permission-attention detection depend on available Pi events; document any measured limitations rather than silently claiming support. Do not require Go gateway in v1.
