# PLAN: Neovim ↔ pi-x Session Bridge (Product Plan)

## Implementation status (current)
- [x] pi-x extension opens Unix socket on `session_start`.
- [x] NDJSON protocol supports `ping` and `prompt`.
- [x] Session discovery artifacts written (`.info`) in `/tmp/pi-nvim-sockets`.
- [x] Latest-session symlink maintained at `/tmp/pi-nvim-latest.sock`.
- [x] Graceful cleanup on `session_shutdown` and process `exit`.
- [x] Minimal docs with CLI verification examples.
- [x] In-agent introspection command `/pi-nvim-info`.

## Compatibility tasks for existing Neovim plugin (`~/.pi/tmp/extensions/pi-nvim`)
- [x] Write `.info` as **single-line JSON** (`JSON.stringify(obj)`), not pretty-printed multi-line JSON.
  - Why: plugin discovery reads only first line via `readfile(...)[1]` and decodes that line.
- [x] Confirm `.info` schema includes plugin-used fields: `cwd`, `pid`, `startedAt` (keep `protocolVersion` and `socketPath` as additive).
- [x] Keep socket/discovery paths exactly compatible:
  - `/tmp/pi-nvim-sockets/*.sock`
  - `/tmp/pi-nvim-sockets/*.sock.info`
  - `/tmp/pi-nvim-latest.sock`
- [x] Confirm protocol/response compatibility for plugin calls:
  - request `{"type":"ping"}` -> response `{"ok":true,"type":"pong"}`
  - request `{"type":"prompt","message":"..."}` -> response `{"ok":true}`
  - invalid payload -> `{"ok":false,"error":"..."}`
- [x] Add explicit compatibility test matrix in docs:
  - `:PiPing`
  - `:PiSend`
  - `:PiSessions` (cwd match preferred; newest fallback)
- [x] Optional parity: tolerate extra prompt fields (e.g. `images`) without error.


## 1) Goal
Recreate the **core user value** of `pi-nvim`: let users send prompts and editor context from Neovim to a live pi session with near-zero friction.

Success means:
- A user runs pi-x in one pane and Neovim in another.
- They can send prompt/file/selection/buffer context to pi-x in 1–2 keystrokes.
- Session discovery is automatic (no manual socket copy/paste).

---

## 2) Target Users & Jobs-to-be-Done
### Primary users
- Power users coding in Neovim + terminal multiplexers.
- People using pi-x as an interactive coding copilot.

### Jobs
- “Send selected code + question to assistant quickly.”
- “Attach current file context without leaving editor flow.”
- “Target the right running pi session when multiple repos are open.”

---

## 3) Functionality to Copy (User-facing)
From the referenced extension, we should match these product behaviors:

1. **Live bridge from external tool to active pi session**
   - A local IPC endpoint exists while session is running.
   - External client can send newline-delimited JSON messages.

2. **Prompt injection command**
   - External message `{type:"prompt", message:"..."}` appears in chat as a user message.

3. **Health check**
   - External message `{type:"ping"}` returns `{ok:true, type:"pong"}`.

4. **Automatic session discovery**
   - Session metadata written to a known temp directory.
   - Client can find all running sessions and prefer cwd-matching one.

5. **Latest-session convenience path**
   - A “latest” pointer for single-session workflows.

6. **Lifecycle cleanup**
   - Socket and metadata removed on shutdown/exit.

7. **Basic introspection command**
   - In-agent command to show active socket/bridge info.

---

## 4) Product Scope for pi-x
## MVP (must-have)
- pi-x extension that opens Unix socket on `session_start`.
- NDJSON protocol supporting `ping` and `prompt`.
- Session discovery artifacts in `/tmp/pi-nvim-sockets`-style dir.
- Graceful cleanup on `session_shutdown` and process exit.
- Minimal docs showing how a Neovim plugin (or CLI) can send messages.

## V1 (should-have soon after MVP)
- Session list + cwd preference behavior formally documented.
- Better error responses and compatibility checks.
- Optional richer prompt payload fields (e.g., source file, line range).

## V2 (nice-to-have)
- First-party Neovim plugin in this repo (or companion repo).
- Cross-platform transport abstraction (Unix socket + Windows named pipe).
- Security hardening (token/permission model).

---

## 5) Non-Goals (for first release)
- Full IDE integration across all editors.
- Remote/network transport.
- Multi-user shared sockets.
- Complex auth UX (keep local-only assumptions initially).

---

## 6) UX Requirements
1. **Zero-config default path**
   - User enables extension and it “just works” locally.
2. **Fast interaction**
   - Prompt send should be effectively instant.
3. **Clear failure mode**
   - If bridge unavailable, client gets actionable error.
4. **Multi-session clarity**
   - Distinguish sessions by cwd + pid + startedAt.

---

## 7) Technical/Product Decisions to Confirm
- **Socket directory contract:** keep compatibility with `/tmp/pi-nvim-sockets` vs. use `/tmp/pi-x-nvim-sockets`.
- **Protocol compatibility:** strict clone (`ping`, `prompt`) vs. additive fields.
- **Discovery format:** `.info` JSON schema (cwd, pid, startedAt, version).
- **Versioning strategy:** include protocol version in metadata.

Recommendation: keep wire protocol backward-compatible with existing `pi-nvim` behavior for easiest adoption.

---

## 8) Rollout Plan
### Phase 0 — Validation
- Confirm extension works when injected via `pitest --nvim` path (`$HOME/.pi/tmp/extensions/pi-nvim`).
- Verify behavior in single-session and multi-session scenarios.

### Phase 1 — MVP Release
- Ship bridge extension in repo (documented, tested manually).
- Provide CLI examples (`socat`/`nc`) for quick verification.
- Add troubleshooting section (permissions, stale socket cleanup, multiple sessions).

### Phase 2 — Editor UX
- Publish/port Neovim plugin commands:
  - `PiSend`, `PiSendFile`, `PiSendSelection`, `PiSendBuffer`, `PiPing`, `PiSessions`.
- Add default keymap recommendation.

### Phase 3 — Hardening
- Telemetry/logging hooks (opt-in) for reliability.
- Backward-compat test matrix across pi versions.

---

## 9) Acceptance Criteria
- User can send a prompt from external client and see it in live pi-x session.
- `ping` returns success reliably.
- Session is discoverable by cwd from metadata files.
- No stale artifacts remain after graceful shutdown.
- Documentation allows first successful send in <10 minutes.

---

## 10) Risks & Mitigations
- **Stale sockets** after crashes → startup cleanup + robust existence checks.
- **Confusing multi-session routing** → cwd-first selection and `PiSessions` chooser.
- **Terminal-specific quirks** (scrollback behavior) → make optional/guarded.
- **Security concerns** (local socket misuse) → document local trust boundary; plan token auth for later.

---

## 11) Metrics (Product)
- Time-to-first-successful-send.
- % successful sends vs failed sends.
- Frequency of session selection errors.
- Retention: users issuing >10 send actions/week.

---

## 12) Deliverables
1. `pi-x` bridge extension (protocol-compatible MVP).
2. User docs (install, usage, protocol, troubleshooting).
3. Optional Neovim plugin integration plan and command map.
4. Manual QA checklist for single/multi-session flows.
