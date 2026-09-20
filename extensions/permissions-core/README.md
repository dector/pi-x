# permissions-core (pi extension)

Headless network permission provider. This extension is the successor to
safe-mode's network disposition. Classification, disposition, and state are
pure and independently tested; `index.ts` wires the policy engine into the hub
and the local event bus.

Stage 2 status: loadable, provides `perm:net` through the hub, persists the
configured policy per session, observes safe-mode, and exposes a validated
state contract. HTTP enforcement and UI arrive in later stages.

## Model

Classification and disposition are separate layers.

### Trust classification

| Request | Trust |
| --- | --- |
| `GET`, `HEAD`, `OPTIONS` | trusted |
| other valid HTTP methods | untrusted |
| `web_search` | trusted |

There is no hostname filtering and localhost is not special in V1.

### Policy disposition

| Policy | Trusted | Untrusted |
| --- | --- | --- |
| `deny-all` | block | block |
| `ask-all` | confirm | confirm |
| `allow-trusted` | allow | block |
| `ask-untrusted` | allow | confirm |
| `allow-all` | allow | allow |

### Auto (safe-mode derived)

| Safe mode | Effective Auto policy |
| --- | --- |
| `paranoid` | `ask-all` |
| `reader` | `ask-all` |
| `smart` | `ask-untrusted` |
| `yolo` | `allow-trusted` |

`yolo+` is a UI label for `yolo` with outer access enabled. Outer access does
not affect network policy, so `yolo+` is **not** a distinct safe mode.

Safe modes must be the canonical lowercase values emitted by `safe-mode`.
Unknown, mixed-case, or whitespace-padded values fail closed: `deriveAutoNetworkPolicy`
returns `ask-all`, and `resolveNetworkPermissionState` forces effective `ask-all`
with `overriddenByParanoid` set. They never silently bypass PARANOID.

PARANOID forces `ask-all` while retaining the configured choice; leaving
PARANOID restores that choice or resumes Auto derivation.

## Hub contract

On `session_start` / `session_tree`, permissions-core registers as a hub
provider for `perm:net` (and unregisters on `session_shutdown`). Requests are
normalized and classified, then disposed under the current effective policy.

Request data (hub `CapRequest.data`):

```ts
{ toolName: "http" | "http_md" | "web_search"; operation: "request" | "search"; url?: string; method?: string; query?: string }
```

Response (`CapResult`): `{ what: "perm:net", action: "allow" | "confirm" | "block", reason?, summary? }`.

Guarantees:

- malformed envelopes and malformed/invalid request data always reply `block`;
- the provider always answers a `perm:net` cap it is targeted for (no unhandled
  request);
- the provider never emits its own `hub:ask`, so handling a request cannot
  recurse through the hub or deadlock;
- when permissions-core is absent the hub answers `block` (`no hub provider`).

`safe-mode` no longer advertises `perm:net`; only permissions-core answers it.

Stage 2 returns `confirm` but nothing consumes it yet. Stage 3 (HTTP
enforcement) must turn an effective `confirm` into `block` with a clear reason
when no UI is available, before/while routing `http`, `http_md`, and
`web_search` through `perm:net`. HTTP enforcement is intentionally not part of
Stage 2.

## State contract and persistence

Read-only and mutation channels (payloads validated by `contract.ts`):

| channel | direction | payload |
| --- | --- | --- |
| `px:permissions-core:net:state:request` | consumer → core | `{ id }` |
| `px:permissions-core:net:state:response` | core → consumer | `{ id, state }` |
| `px:permissions-core:net:state:set` | consumer → core | `{ setting, source? }` |
| `px:permissions-core:net:state:changed` | core → consumers | `{ configured, effective, overriddenByParanoid, source? }` |

`state` is `{ configured, effective, overriddenByParanoid }`. A changed event is
emitted only when the validated state actually changes. Session reset and
`session_tree` re-derivation go through the same path, so consumers are notified
whenever a new/resumed session changes the effective policy (they can never be
left rendering a previous session's state).

Safe mode is only observed, never changed:

- permissions-core queries `px:safe-mode:state:request` on session start
  (`querySafeModeSnapshot`, short timeout, never through the hub);
- it also tracks `px:safe-mode:state:changed` for live Auto/PARANOID updates.

New sessions start at `auto`. An explicit choice persists with
`pi.appendEntry("permissions-core-net", { configured })` and is restored from
the session branch on resume. A present but corrupt persisted choice fails
closed to `ask-all`.

## API

`policy.ts` exports validation/normalization (`parseNetworkPermissionRequest`,
`normalizeHttpMethod`, `normalizeNetworkUrl`), classification
(`classifyNetworkTrust`), policy mapping (`dispositionForPolicy`,
`evaluateNetworkPermission`), Auto derivation (`deriveAutoNetworkPolicy`),
state resolution (`resolveNetworkPermissionState`,
`createInitialNetworkPermissionState`), and serializable state helpers
(`parseNetworkPermissionState`, `serializeNetworkPermissionState`).

`provider.ts` exports `createNetworkPermissionService`, the side-effect-free
core used by `index.ts` and the tests. `contract.ts` exports the state event
names and payload parsers (`parseNetworkStateRequest`,
`parseNetworkStateResponse`, `parseNetworkStateSet`,
`parseNetworkStateChanged`). `safe-mode.ts` exports the read-only safe-mode
observer.

Malformed or unsupported requests always block. Invalid input never becomes an
approval prompt, and `allow-all` only applies to valid requests.

`classifyNetworkTrust` accepts a raw `unknown` and validates first, returning
`undefined` for malformed requests so callers cannot turn them into trusted
traffic. `normalizeNetworkUrl` rejects URLs containing userinfo (`user:pass@`),
and summaries never echo an unnormalized URL, so credentials cannot leak
through normalized output. Summary text strips every control character.

`parseNetworkPermissionState` rejects inconsistent persisted state: explicit
policies must be effective verbatim unless PARANOID is active, Auto effective
values must be derivable from a canonical safe mode, and PARANOID (or a
fail-closed unknown mode) must be `ask-all`.

## Tests

```sh
bun test
bun run typecheck
```

`provider.test.ts` covers provider registration, valid/malformed hub requests,
state requests/sets, PARANOID transitions, and persistence. `flow.test.ts`
loads the real hub and permissions-core with a fake event bus to cover the
selected request flow, real-hub multi-provider arbitration (block/confirm/allow
independent of order), and to assert there is no recursive `hub:ask`.
`index.test.ts` covers the `index.ts` wiring: `session_start`/`session_tree`
reset and restore, `session_shutdown` unregister, and state
request/response. `safe-mode.test.ts` covers the read-only observer, including
absent/malformed responses with a short injected timeout.
