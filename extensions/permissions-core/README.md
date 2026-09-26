# permissions-core (pi extension)

Headless network permission provider. This extension is the successor to
safe-mode's network disposition. Classification, disposition, and state are
pure and independently tested; `index.ts` wires the policy engine into the hub
and the local event bus.

Status: provides `perm:net` through the hub, persists the configured policy per
session, accepts an inherited `--network-policy` session flag, observes
safe-mode, and exposes a validated state contract. The
`http`, `http_md`, and `web_search` tools consume this provider, the
`/px:net` selector in [`../permissions-ui/`](../permissions-ui/README.md) reads
and changes the state through the same contract, and `neo-bar` renders the
effective token.

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

- malformed/invalid request data always replies `block`;
- malformed hub envelopes are dropped and callers fail closed through bounded
  timeouts;
- the provider always answers a valid `perm:net` cap it is targeted for (no
  unhandled request);
- the provider never emits its own `hub:ask`, so handling a request cannot
  recurse through the hub or deadlock;
- when permissions-core is absent the hub answers `block` (`no hub provider`).

`safe-mode` no longer advertises `perm:net`; only permissions-core answers it.

The `http`, `http_md`, and `web_search` tools route through this provider. An
effective `confirm` becomes a `block` when no UI is available, and the HTTP
extension additionally requires a one-time execution authorization from
safe-mode (see [`../http/README.md`](../http/README.md)). Without safe-mode's
final allow/user-approval handoff, no network request executes. The `/px:net`
selector is available in [`../permissions-ui/`](../permissions-ui/README.md), and
`neo-bar` renders the effective token.

## State contract and persistence

Read-only and mutation channels (payloads validated by `contract.ts`):

| channel | direction | payload |
| --- | --- | --- |
| `px:permissions-core:net:state:request` | consumer → core | `{ id }` |
| `px:permissions-core:net:state:response` | core → consumer | `{ id, state }` |
| `px:permissions-core:net:state:set` | consumer → core | `{ setting, source? }` |
| `px:permissions-core:net:state:changed` | core → consumers | `{ configured, effective, autoEffective, overriddenByParanoid, source? }` |

`state` is `{ configured, effective, autoEffective, overriddenByParanoid }`.
`effective` is the policy actually applied to requests. `autoEffective` is the
safe-mode-derived Auto policy, independent of `configured`; under PARANOID (or
an unknown safe mode) it is `ask-all`. Consumers use `autoEffective` to render
the Auto row even while an explicit policy is configured. A changed event is
emitted only when the validated state actually changes (including when only
`autoEffective` changes, so the Auto row stays live). Session reset and
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

## Inherited session flag

`--network-policy <setting>` sets the configured policy for this session. The
`subagent` extension uses it to hand a child's own fresh `--no-session` process
the parent's configured policy instead of leaving it at `auto`.

Precedence on `session_start` / `session_tree`, applied before the persisted
branch is consulted:

| `--network-policy` | result |
| --- | --- |
| absent | existing persisted-session restore (Auto on a branch with no entry) |
| valid setting | that configured policy is used, even over a persisted choice |
| present but invalid | fails closed to `ask-all`; the persisted choice is **not** used |

`invalid` covers unknown values, wrong case, and empty strings. An interactive
session shows one warning per session start; a headless session stays silent.
The inherited value is applied, not persisted: the child writes no session entry
until the policy is changed explicitly in that session.

Only the configured setting is inherited, never the parent's derived `effective`
value. The child keeps its own Auto derivation and PARANOID precedence, so a
child of an `allow-all` parent that runs in PARANOID still resolves `ask-all`.
Nested subagents work the same way: a child answers the state contract with the
configured policy it inherited, and its own children inherit that.

## API

`policy.ts` exports validation/normalization (`parseNetworkPermissionRequest`,
`normalizeHttpMethod`, `normalizeNetworkUrl`), classification
(`classifyNetworkTrust`), policy mapping (`dispositionForPolicy`,
`evaluateNetworkPermission`), Auto derivation (`deriveAutoNetworkPolicy`),
state resolution (`resolveNetworkPermissionState`,
`createInitialNetworkPermissionState`), and serializable state helpers
(`parseNetworkPermissionState`, `serializeNetworkPermissionState`).

`provider.ts` exports `createNetworkPermissionService`, the side-effect-free
core used by `index.ts` and the tests, plus `NETWORK_POLICY_FLAG` and
`inheritedSettingFromFlag` (flag value to restore input; `undefined` means the
flag was absent, a present value is passed through unvalidated so `restore`
fails closed). `contract.ts` exports the state event names and payload parsers
(`parseNetworkStateRequest`, `parseNetworkStateResponse`, `parseNetworkStateSet`,
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
policies must be effective verbatim unless PARANOID is active, Auto's
`effective` must equal its `autoEffective`, `autoEffective` must be derivable
from a canonical safe mode, and PARANOID (or a fail-closed unknown mode) must be
`ask-all` for both `effective` and `autoEffective`.

## V1 scope and known gaps

V1 enforces network policy only for `http`, `http_md`, and `web_search`, and
only when they go through the hub. Traffic that never requests `perm:net` is
unaffected.

Not covered in V1:

- shell commands (`curl`, `wget`, `ssh`, netcat);
- Git remote operations (fetch, pull, push);
- package managers and other subprocesses;
- subprocess/agent tools and project-local subagents;
- MCP and custom tools;
- direct network access from extension code;
- DNS-specific controls;
- localhost/private-network distinctions;
- per-host, per-domain, per-port, and per-method rules;
- checking every redirect target (the initial request decision is reused);
- custom rule files and scriptable classification;
- process/OS-level sandboxing.

Future rules stay two-layer: a rule returns only `trusted` or `untrusted`, and
policy disposition maps that to `allow`/`confirm`/`block`.

A manual TUI smoke test for the end-to-end flow is in
[`docs/manual-smoke-test.md`](docs/manual-smoke-test.md).

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
reset and restore, `session_shutdown` unregister, state request/response, and
the inherited `--network-policy` flag (valid flag over an empty or persisted
branch, invalid flag failing closed, absent flag keeping the persisted
behavior, PARANOID still forcing `ask-all`, and no entry written for an
inherited policy). `provider.test.ts` additionally covers
`inheritedSettingFromFlag` and the malformed persisted choice.
`safe-mode.test.ts` covers the read-only observer, including
absent/malformed responses with a short injected timeout.
