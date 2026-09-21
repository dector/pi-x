# hub roadmap

Status: hub provides `register`/`unregister`/`ask`/`request`/`reply`/`answer`,
a capability registry, most-restrictive arbitration, an explicit user-wait
registry, and `/px:hub`. Permissions are the first domain. See
[`PROTOCOL.md`](PROTOCOL.md).

## Principles

- Hub routes and arbitrates; it never holds policy.
- Policy lives in the provider that owns the capability.
- Requester never knows provider names.
- Permissive: data-only, malformed dropped, unknown caps tolerated.
- Order-independent: listeners registered in factories, collect on `session_start`.
- Fail safe: no provider → `block`; no `perm:tool` opinion → safe-mode built-in.

## Done

- [x] hub bootstrap, protocol, registry, routing, arbitration, `/px:hub`
- [x] `perm:agent`: `subagent` asks, `safe-mode` decides interactively
- [x] `perm:tool`: `safe-mode` asks, `http` classifies `http`/`http_md`/`web_search`, `sqlite` classifies `sqlite`
- [x] HTTP risk rules moved out of safe-mode
- [x] explicit user-wait registry (`hub:user-wait:set`/`clear`/`changed`/`ack`), `/px:hub` wait listing, and the `herdr:blocked` compatibility adapter
- [x] `safe-mode` migrated to `withUserWait` for `perm:agent`, tool approvals, and steering input

## 1. Finish permission migration

Move per-tool risk rules from `safe-mode/policy.ts` to the owning extension,
each registering as a `perm:tool` provider.

- [x] `http` — non-network safeguards via `perm:tool`, network via `perm:net`
- [ ] `git` — `classifyGitToolCall`
- [x] `sqlite` — `classifySqliteToolCall`
- [ ] `proc` — `classifyProcToolCall`
- [ ] `flutter` — tool classification
- [ ] `commit` (git ext) — file scope rules
- [ ] `bash` — decide whether `bash-policy` stays in safe-mode (likely yes; it is general, not tool-owned)
- [ ] core file tools (`read`/`write`/`edit`/`ls`/`grep`/`find`) — decide owner; probably stays in safe-mode as built-in

## 2. Wire more requesters

- [ ] `interactive-bash` — gate user `!` commands via `perm:shell`
- [x] subagent child processes — snapshot mode/outer-access through the safe-mode state contract; relay approval UI over child RPC (not through hub)
- [ ] `proc` spawn actions — ask hub instead of relying on safe-mode's built-in table
- [ ] any extension spawning a process or writing outside project — use `perm:shell`/`perm:io`

## 3. Permissions beyond `perm:tool`

- [ ] `perm:shell` — real requester + provider path (currently registered, never asked)
- [ ] `perm:io` — path read/write requests for non-tool callers
- [ ] `perm:net` — non-tool outbound requests (http currently only answers `perm:tool`)
- [ ] capability naming/ownership rules (who may provide which `perm:*`)

## 4. Other hub domains

- [ ] **Action registry** — replace `pi-ui`'s hardcoded key→event map; peers register actions
- [ ] **Status capability** — replace `status-bar`'s private ping/pong + duplicated constants
- [ ] **Presence** — generic availability query instead of per-extension handshakes
- [ ] **Observers** — `status-bar`, `herdr` subscribe to hub traffic for badges/telemetry
  - [x] **Explicit user-wait signal** — `hub:user-wait:set`/`clear`/`changed`/`ack`; observers read the aggregate snapshot and never infer waits from pending requests. Hub maps aggregate crossings to the external `herdr:blocked` event.
  - [x] **Herdr tab status** — adjacent, not hub traffic: hub mirrors Herdr's `pane.agent_status_changed` onto its own tab label ([`herdr-tab.ts`](herdr-tab.ts); see [README](README.md#herdr-tab-status)). It does not use the capability registry.
  - [x] **Semantic progress** — hub `progress` tool + `hub:progress:*` registry, immediate-child relay, and `status-bar` observer/formatter ([`progress.ts`](../status-bar/progress.ts), `formatProgressRow`). Automated tests cover the full path (interactive TUI smoke test in [`idea-progress.md`](idea-progress.md) section 12 remains manual).
    - [ ] Persist progress across Pi restarts (session state or sidecar file).
    - [ ] Parse a milestone document into tracker/chunk definitions.
  - [ ] **status-bar** observer over the user-wait aggregate (badges/telemetry)

## 5. Protocol / open items

- [ ] Provider trust/attribution (any extension can claim any cap)
- [ ] Typed "no opinion" sentinel instead of string matching `"no hub provider"` / `"no provider answered"`
- [ ] Programmatic provider/pending query (beyond `/px:hub`)
- [ ] Per-capability timeout vs interactive prompts (currently: requester timeout 10 min, hub TTL 30 min)
- [ ] `ctx` passing convention (already used; document limits)
- [ ] Reload/shutdown edge cases (unregister on reload, stale providers)

## 6. Known issues

- [ ] `perm:tool` ask adds ~300 ms when hub is absent (short timeout); consider skipping when hub never registered
- [ ] Integration tests use an in-process event bus; the documented TUI smoke test still requires manual execution
- [ ] Without an http provider, HTTP execution fails closed because no authorization ticket is issued
- [ ] Without a sqlite provider, read-only `sqlite` queries now `confirm` (stricter than before)
- [ ] Repeated event-constant duplication across extensions (no shared contract imports)
