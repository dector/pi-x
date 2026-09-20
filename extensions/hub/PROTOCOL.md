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

- `id` on `hub:ask` is a correlation id; the same `id` comes back on `hub:answer`.
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

## Waiting state

Hub pending state (a `hub:ask` awaiting `hub:answer`) means "waiting for
providers", not necessarily "waiting for a user". Many requests are quick,
non-interactive classifications (for example `perm:tool` and `perm:net`) and
must not be reported as user waits.

Hub does not open approval UI and does not emit user-wait/blocked state. The
provider that opens an interactive dialog owns that interval and is responsible
for reporting the wait to integrations such as Herdr. Today that provider is
`safe-mode`, which emits the external `herdr:blocked` event while its dialog is
open. A future generic hub observer must not infer a user wait from pending
requests.

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
