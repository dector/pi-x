# Tunnel extension — v1 specification

Status: design agreed; not implemented.

## Goal

Continue working with the **active Pi session** from a phone on the same Tailscale tailnet. The phone sees the existing active conversation, receives live updates, and can send prompts. A browser UI and non-browser clients use the same documented API. Pi must remain running. V1 connects to **one Pi process**; a future Go gateway can aggregate multiple terminals/projects behind one URL.

## Deployment and commands

- The Pi extension owns an HTTP server (native Bun HTTP transport; Elysia was prototyped but conflicts with Pi's bundled TypeBox) listening on `127.0.0.1` on a configurable, stable port. The default port is to be selected during implementation and documented. A port conflict fails clearly; never silently pick another port. No automatic Tailscale configuration or public binding.
- The user configures **Tailscale Serve HTTPS** to proxy to that local port. The UI requires a secure origin over the tailnet; the localhost origin is available for local setup/testing. Tailscale is transport, not the only authorization boundary.
- `/px:tunnel on`: start or report the existing server; display local address, external URL if configured, and a fresh six-digit pairing code with expiry. Repeating `on` must not silently revoke clients or reconfigure Serve.
- `/px:tunnel pair`: generate a new code to add another device; older unused code is invalidated. `/px:tunnel status`: show port, active session identity, pairing expiry, and paired-client count **without printing bearer credentials**. `/px:tunnel off`: close server/streams and revoke all credentials.
- No automatic start on fresh Pi startup. Pi exit closes the server and invalidates credentials. The implementation uses Bun's built-in HTTP server to run inside Pi's bundled runtime; do not require a separate gateway or an incompatible Elysia dependency for v1.

## Pairing and authorization

- Generate a uniform random **six-digit decimal code**, including leading zeroes, using a cryptographic RNG. Valid for five minutes from generation; single-use, atomically consumed on success. Five failed guesses invalidate that code; a new one requires `/px:tunnel pair`. Apply a modest request-rate limit as well. Return generic errors that do not reveal whether a code exists.
- A successful exchange issues a high-entropy, opaque **per-client credential** held only in Pi-process memory. Each paired client has the same read/write access; multiple devices can pair with fresh codes. Credentials survive browser reconnects, active-session switches/forks/tree navigation, and Pi `/reload`, but never `/px:tunnel off` or Pi exit. The six-digit code does **not** need to be re-entered on each reconnect.
- Browser pairing establishes an `HttpOnly`, `Secure`, `SameSite=Strict` session cookie; the UI must not store a bearer token in localStorage or a URL. Non-browser clients can exchange a code for a bearer token and send it in `Authorization`. Document both exchange modes and never put tokens in logs, query strings, or SSE URLs.
- For browser writes, enforce JSON content type, exact configured/validated Origin and CSRF protections; do not enable wildcard CORS or trust arbitrary proxy/forwarded headers. Define a configured external HTTPS origin for Tailscale Serve, with strict localhost handling for local tests. Unpaired clients cannot access conversation data or mutate Pi. Rate-limit pairing independently of authenticated requests. All paired clients may see **full Pi data**, including thinking, tool arguments/results, command output, and potential secrets; no tunnel-specific redaction.
- The Tailscale Serve hostname and URL configuration are user-managed. Document that direct HTTP exposure to an untrusted network is unsupported.

## Session lifecycle

- Paired clients follow **whatever session is active in the same Pi process**. After switch/new/fork/clone or tree navigation, notify clients of a session/branch change and refresh the active-branch snapshot; clearly show the new session identity, and do not silently concatenate old and new histories. V1 cannot browse or control past sessions from the phone.
- Pi tears down/reloads extension instances on session replacement and `/reload`. Preserve server and in-memory credentials in a process-level owner across handoffs, or briefly restart the server while preserving credentials and reconnecting clients. Never invoke a stale Pi API/context: unbind old handlers and bind new ones. During a handoff, writes fail transiently rather than being sent to an unknown session. If the extension fails to reload, fail closed. Quit/off must clean up the process-level owner.
- Session identity should include enough to distinguish the active conversation (e.g., session ID/name and cwd) without allowing the client to supply a routing target. Only the Pi process's current branch is exposed in v1; old sessions are not independently queryable. Do not persist credentials, copies of conversation history, or a server-side event journal to disk.

## Prompt and control behavior

- Send text prompts through Pi's native `pi.sendUserMessage`, not through a second agent or custom queue. When idle, Send starts a normal prompt. While busy, present explicit **Queue** (`deliverAs: "followUp"`), **Steer** (`deliverAs: "steer"`), and **Don't send** choices; Queue is the default. Steer takes effect at Pi's next turn boundary and cannot undo a running tool. Use Pi's native ordering/queue behavior on session changes; do not invent tunnel-specific rules or promise queue editing/status unavailable from Pi.
- V1 has no cancellation/reordering of individual queued prompts. A **Stop** control uses Pi's native abort behavior for the current run; warn that external side effects may already have happened. Do not implement remote approval of interactive permission prompts: show **Needs attention in Pi terminal** when detectable; avoid falsely claiming that an agent is finished while blocked.
- API requests must distinguish accepted from completed prompts. On errors, report whether Pi accepted the prompt; for retries use an idempotency key or equivalent per-client deduplication so reconnecting a phone cannot accidentally send twice. Validate prompt length and request body size; text-only submission in v1. Pi may still have earlier image content in history.

## HTTP API and event delivery

- Serve the phone UI and a documented `/api/v1` API from the same server. Proposed endpoints: `POST /api/v1/pair`, `GET /api/v1/session` (identity, active-branch snapshot, status), `GET /api/v1/events` (SSE live events), `POST /api/v1/prompts` (text + `mode: "normal" | "followUp" | "steer"`), and `POST /api/v1/abort`. Define response/error/status codes and authentication for each endpoint in the implementation contract; do not expose an unrestricted command execution endpoint. UI must consume this API rather than private extension internals.
- Prefer Pi's native message/event content shapes instead of inventing a parallel chat schema. The wire envelope only needs protocol version, session/branch identity, event sequence or equivalent resync marker, and event kind. Preserve Pi's message roles/content blocks, including thinking, tool calls, and tool results when straightforward. Document any fields omitted or transformed, message ordering, and compatibility expectations: `/api/v1` versions the **transport**, not arbitrary upstream Pi types. Escape/sanitize untrusted Markdown/HTML and tool output in the browser.
- A newly paired/reconnected client reads the **entire current branch**, including messages from before tunnel activation, then receives streaming updates. Use a gap-free snapshot-to-SSE handoff (subscribe/buffer-before-snapshot or cursor-based reconciliation); on disconnect, resnapshot and deduplicate. No durable event replay log required. Handle partial assistant updates, completion, errors, session changes, tool activity, and busy/idle state. Keep SSE connections alive and enforce bounded buffers/backpressure and limits for oversized messages; specify visible truncation or explicit errors rather than silent data loss. Client should not confuse transient disconnect with completion.
- Do not assume a tunnel prompt is the only producer: terminal prompts, other paired clients, and extension-origin messages must appear as supported by Pi's events and active branch. API clients should be able to consume the same authenticated stream without the web UI.

## Phone-first UI

- Responsive single-column conversation, readable Markdown/code blocks with copy actions, accessible tap targets, safe-area and virtual-keyboard-aware composer. Keep the latest output visible without forcing auto-scroll when the user is reading older content. Display session identity/cwd, connection/reconnecting state, and busy/working/terminal-attention state.
- Pairing page accepts the six-digit code. After pairing, load the existing conversation without losing position unnecessarily. After phone sleep/network change, reconnect, refresh the active branch, and resume live updates. Clearly announce branch/session changes. Never imply an unsent draft in Pi's terminal editor has moved to the phone: drafts stay local to each input surface.
- Include Send, explicit Queue/Steer choice when busy, and Stop. Render tool/thinking information if available; prioritize accurate event mirroring over polished per-tool UI in v1. Show errors and retry safely. No photo/image uploads or remote session navigation/approvals in v1.

## V2 boundaries

- A separate small **Go gateway** can own one stable Tailscale Serve endpoint, register several Pi processes, and offer session/project selection. The v1 extension and API should keep session identity explicit and avoid global single-session assumptions inside the wire format, but v1 requires neither a gateway nor cross-process discovery.
- Consider session navigation from the phone, queue editing, image uploads, and remote interactive approvals separately. Do not imply these work in v1.

## Acceptance checks

1. Start on an available port; second `on` is idempotent; an occupied port fails without changing another Pi process.
2. A code expires after five minutes, is single-use, locks after five failed guesses, and a new code can pair another client without logging out the first. `off` and Pi quit revoke all clients.
3. Unpaired requests, cross-origin browser writes, invalid tokens, and direct credential-less SSE access cannot read history or send prompts.
4. Phone loads pre-tunnel active-branch history and receives terminal-origin and remote-origin responses, including streamed text; thinking/tool data is included where feasible and not secretly filtered by the API.
5. Busy Queue and Steer use Pi's modes, Stop aborts the active run; request retries cannot duplicate a prompt. Terminal-only approvals show a blocked/attention state where detectable.
6. On switch/fork/tree navigation and `/reload`, authenticated clients retain access and see the correct new active branch without sending into a stale context. Off/quit closes connections and cleans up the port.
7. Phone resumes from sleep/network interruption without missing or duplicating completed messages, and stays usable on a narrow screen above the virtual keyboard.
