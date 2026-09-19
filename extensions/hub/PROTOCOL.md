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
type CapResult  = { what: string; action: "allow" | "confirm" | "block"; reason?: string };
```

`action` mirrors `safe-mode`'s `ToolDecision` so a provider can pass its verdict through unchanged.

## Capabilities

| cap | meaning | provider |
| --- | --- | --- |
| `perm:shell` | run a shell command | safe-mode |
| `perm:io` | read/write/edit/delete a path | safe-mode |
| `perm:net` | outbound network request | safe-mode |
| `perm:agent` | run project-local subagents | safe-mode |
| `perm:tool` | classify a tool call (`allow`/`confirm`/`block`) | tool extensions |

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
{ url: string; method?: string }
```

`perm:agent`

```ts
{ agents: string; source: string; cwd?: string }
```

`perm:tool`

```ts
{ toolName: string; input: Record<string, unknown>; mode: string; projectRoot: string; outerAccess: boolean; trustedReadRoots?: string[] }
```

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

## Arbitration

- Providers answer on `hub:reply`; hub collects and emits one `hub:answer`.
- Per capability, the most restrictive result wins: `block` > `confirm` > `allow`.
- A capability no provider answered becomes `block` (`reason: "no provider answered"`).
- If no provider is registered for any requested capability, hub answers `block`
  immediately (`reason: "no hub provider"`).
- Hub finalizes when every requested capability is answered or every target has replied.
  A pending request is dropped after 30 minutes.

## Open

- Is `confirm` handled by the provider (UI there) or returned to the requester?
- Provider replies are not attributed beyond `from`; no trust check.
