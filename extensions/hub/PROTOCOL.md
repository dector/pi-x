# hub protocol (draft)

Namespace: `hub:`. Transport: `pi.events`.

Status: draft. Payloads below are the agreed shape; marked items are still open.

## Channels

| channel | direction | payload |
| --- | --- | --- |
| `hub:register` | client → hub | `{ id, caps: { provide: string[] } }` |
| `hub:unregister` | client → hub | `{ id }` |
| `hub:ask` | client → hub | `{ id, from?, ctx?, cap: CapRequest[] }` |
| `hub:request` | hub → provider | `{ id, from?, ctx?, cap: CapRequest[], targets: string[] }` |
| `hub:reply` | provider → hub | `{ id, from?, results: CapResult[] }` |
| `hub:answer` | hub → client | `{ id, results: CapResult[] }` |
| `hub:user-wait:set` | UI owner → hub | `{ id, owner, label?, kind? }` |
| `hub:user-wait:clear` | UI owner → hub | `{ id, owner }` |
| `hub:user-wait:changed` | hub → observers | `{ active, count, waits[] }` |
| `hub:user-wait:ack` | hub → UI owner | `{ id, owner, operation: "set" \| "clear" }` |

- `id` on `hub:ask` is a correlation id; the same `id` comes back on `hub:answer`.
- User-wait channels are a separate protocol; see [User waits](#user-waits).
- Clients may register at any time. Registration is idempotent (upsert by `id`).

```ts
type CapRequest = { what: string; data: Record<string, unknown> };
type CapResult  = { what: string; action: "allow" | "confirm" | "block"; reason?: string; summary?: string };
```

`action` mirrors `safe-mode`'s `ToolDecision` so a provider can pass its verdict through unchanged. `summary` is an optional one-line description of the classified call; requesters may use it for approval prompts.

## Capabilities

| cap | meaning | provider |
| --- | --- | --- |
| `perm:shell` | run a shell command | safe-mode |
| `perm:io` | read/write/edit/delete a path | safe-mode |
| `perm:net` | outbound network request | permissions-core |
| `perm:agent` | run project-local subagents | safe-mode |
| `perm:tool` | classify a tool call (`allow`/`confirm`/`block`) | tool extensions |

Not a capability: the Herdr tab status feature ([README](README.md#herdr-tab-status))
uses Herdr's socket API directly and never flows through this registry.

## Payloads

`perm:shell`

```ts
{ command: string; cwd?: string }
```

`perm:io`

```ts
{ op: "read" | "write" | "edit" | "delete" | "list"; path: string }
```

`perm:net`

```ts
{ toolName: "http" | "http_md" | "web_search"; operation: "request" | "search"; url?: string; method?: string; query?: string }
```

`permissions-core` validates and normalizes this data, classifies trust, and
disposes it under the effective network policy. Malformed data blocks; invalid
input is never turned into an approval prompt. Provider ownership of `perm:net`
belongs to `permissions-core` (it moved off `safe-mode`).

The `http`, `http_md`, and `web_search` tools request `perm:net` from inside
their `perm:tool` provider and return the merged (most restrictive) result to
safe-mode, which owns the approval dialog and turns `confirm` into a block when
no UI is available. Provider absence, timeouts, and malformed answers fail
closed.

#### `perm:net` policy

A valid request is classified as `trusted` (`GET`/`HEAD`/`OPTIONS`,
`web_search`) or `untrusted` (other valid methods), then disposed:

| Policy | trusted | untrusted |
| --- | --- | --- |
| `deny-all` | block | block |
| `ask-all` | confirm | confirm |
| `allow-trusted` | allow | block |
| `ask-untrusted` | allow | confirm |
| `allow-all` | allow | allow |

New sessions start at `auto`, derived from the observed safe mode:
`paranoid`/`reader` → `ask-all`, `smart` → `ask-untrusted`, `yolo`/`yolo+` →
`allow-trusted`. PARANOID forces `ask-all` while retaining the configured
choice; leaving PARANOID restores it. Explicit choices persist per session and
are selected with `/px:net` (owned by `permissions-ui`). Provider absence,
timeouts, malformed requests, and non-interactive confirmations fail closed;
invalid input is never turned into an approval prompt.

V1 enforcement scope is only `http`, `http_md`, and `web_search`. Shell, Git
remote, package-manager, subprocess/agent, MCP/custom-tool, and direct
extension network paths are not covered. See
[`../permissions-core/README.md`](../permissions-core/README.md).

Because the nested classification flow only runs when safe-mode and the hub are
both present, enforcement happens again at execution time through a one-time
authorization handoff:

- `perm:tool` data includes `toolCallId` (`ToolCallEvent.toolCallId`).
- The capability consumer revokes any stale ticket for the id, classifies, and
  stores a pending ticket only after the complete classification when the
  merged result is `allow`/`confirm`, immediately before its provider reply. A
  merged `block` stores nothing.
- After safe-mode's *final* decision is `allow` (provider allow or a successful
  user approval) it emits `px:safe-mode:tool-authorized`
  `{ toolCallId, toolName, source: "safe-mode" }`. A provider `allow` alone
  never authorizes; hub arbitration, PARANOID, outer-access confirmation,
  denial, or a non-interactive block all still prevent execution.
- Each actual network execute consumes and validates the matching ticket once
  before fetching. Missing hub, missing safe-mode, timeout, denied/non-UI
  confirmation, replay, or changed params fail closed.
- Because the ticket is stored only immediately before the reply, a safe-mode
  timeout fallback emitted while classification is still in flight is missed;
  the late ticket stays unauthorized. A fallback allow also no longer emits the
  handoff at all.

`perm:agent`

```ts
{ agents: string; source: string; cwd?: string }
```

When safe-mode builds the approval prompt it sanitizes the interpolated
`agents` and `source` text (control characters removed, URL userinfo redacted)
so repo-controlled data cannot inject terminal escapes or leak credentials.

`perm:tool`

```ts
{ toolCallId: string; toolName: string; input: Record<string, unknown>; mode: string; projectRoot: string; outerAccess: boolean; trustedReadRoots?: string[] }
```

`toolCallId` is the runtime tool call id. Capability consumers may use it to
correlate a one-time execution authorization with the preflight decision (see
`px:safe-mode:tool-authorized` below).

`perm:tool` providers **classify only** and must answer quickly. Prompting is
left to the requester (`safe-mode`), which treats a `confirm` result as its
normal approval flow. Safe-mode still applies `paranoid` constraints; a
provider is authoritative for its own tools, including outer-access and
trusted-read-root handling for path-scoped tools. `safe-mode` is the fallback
when no `perm:tool` provider is registered.

## Flow

```
requester ──hub:ask──> hub ──hub:request──> provider
requester <──hub:answer── hub <──hub:reply── provider
```

## User waits

Hub pending state (a `hub:ask` awaiting `hub:answer`) means "waiting for
providers", not necessarily "waiting for a user". Many requests are quick,
non-interactive classifications (for example `perm:tool` and `perm:net`), and a
`confirm` result in headless mode becomes a block. **Hub never infers a user
wait from pending requests, `confirm` results, or `hub:ask` activity.**

Instead, the component that actually opens the UI declares the wait. Hub stores
those declarations and publishes the aggregate; it does not own the dialog or
the policy behind it.

### Set

```ts
{ id: string; owner: string; label?: string; kind?: "approval" | "input" | "other" }
```

### Clear

```ts
{ id: string; owner: string }
```

### Acknowledgement

```ts
{ id: string; owner: string; operation: "set" | "clear" }
```

Pi's event dispatch is synchronous, so a client can register an acknowledgement
listener, emit `set`, and know before `emit` returns whether the installed hub
supports this protocol. An absent or older hub stays silent, which lets the
client fall back to a direct integration event (see the safe-mode client).

### Aggregate change

```ts
{
  active: boolean;
  count: number;
  waits: Array<{ id: string; owner: string; label?: string; kind?: "approval" | "input" | "other" }>;
}
```

`hub:user-wait:changed` is the integration-neutral observer contract. Observers
must read this snapshot and not inspect hub's internal registry.

### Registry semantics

- Active waits are keyed by `owner` + `id`. `set` is idempotent for the same key;
  a repeated `set` updates metadata without incrementing the count.
- `clear` removes only the matching `owner` + `id`, so one extension cannot
  clear another extension's wait. Unknown or wrong-owner clears are harmless.
- Malformed payloads are ignored and not acknowledged.
- `changed` is emitted only when effective state or visible metadata changes.
- Concurrent and nested waits stay active until every matching entry is cleared.
- Each concrete UI wait uses a generated id. Do not reuse one global id per
  owner, because nested or overlapping waits could then clear each other.
- Session shutdown clears the entire registry and releases any Herdr block.
- `label` is display text only. Hub does not require it and consumers must
  sanitize it before rendering. Full prompt content must never be sent.
- `/px:hub` lists active waits as `owner/<short-id>: label`; the full id is never
  prompt content.

### Herdr compatibility adapter

Herdr's managed Pi integration listens for the external `herdr:blocked` event
and maintains its own `blockedCount`. Hub therefore maps aggregate zero/non-zero
crossings only:

- aggregate `0 -> 1`: emit `herdr:blocked` `{ active: true, label }`;
- aggregate `1 -> 0`: emit `herdr:blocked` `{ active: false }`;
- `N -> N+1` or `N -> N-1` while both counts are non-zero: emit nothing.

Emitting another `{ active: true }` merely to refresh a label would increment
Herdr's counter and could leave the pane stuck as blocked. The complete updated
list is still available on `hub:user-wait:changed`.

## One-time execution authorization

Classification is advisory until a consumer enforces it. Extensions that
perform a sensitive side effect (for example outbound network requests) must
not trust a `perm:tool` `allow` by itself, because arbitration and safe-mode
policy run after the provider answers.

Safe-mode emits a separate, narrowly validated event once it reaches a final
allow or a user approval:

| channel | direction | payload |
| --- | --- | --- |
| `px:safe-mode:tool-authorized` | safe-mode → consumers | `{ toolCallId, toolName, source: "safe-mode" }` |

The consumer revokes any stale ticket for the id, stores a pending ticket only
after the full classification and only for an `allow`/`confirm` result
(immediately before the provider reply), marks it authorized on this event, and
consumes it exactly once at execution after re-validating the arguments. No
event (blocked, denied, non-interactive, timed out) means execution fails
closed. Consumers must require `source: "safe-mode"` so another extension
cannot forge a handoff. Authorizing refreshes the ticket TTL. Tickets must be
bounded and reset per session.

## Arbitration

- Providers answer on `hub:reply`; hub collects and emits one `hub:answer`.
- Only the providers targeted for the request contribute to arbitration.
- Per capability, the most restrictive result wins: `block` > `confirm` > `allow`.
- A capability no provider answered becomes `block` (`reason: "no provider answered"`).
- If no provider is registered for any requested capability, hub answers `block`
  immediately (`reason: "no hub provider"`).
- Hub finalizes only after every targeted provider has replied, so a late
  `block`/`confirm` cannot be lost to an earlier `allow` from another provider.
  A pending request is dropped after 30 minutes if a provider never replies.

## Open

- Provider replies are not attributed beyond `from`; no trust check.
- `perm:net` is only asked by the built-in HTTP tools; other network paths are
  out of scope for V1 (see [`../permissions-core/README.md`](../permissions-core/README.md)).
