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
moved from `safe-mode` to `permissions-core` in Stage 2.

Stage 2 answers `confirm` but does not consume it: there is no network UI yet.
Stage 3 (HTTP enforcement) must convert an effective `confirm` into `block` with
a clear reason whenever no UI is available, and only then route HTTP,
`http_md`, and `web_search` through `perm:net`. Do not implement HTTP
enforcement in Stage 2.

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
- Only the providers targeted for the request contribute to arbitration.
- Per capability, the most restrictive result wins: `block` > `confirm` > `allow`.
- A capability no provider answered becomes `block` (`reason: "no provider answered"`).
- If no provider is registered for any requested capability, hub answers `block`
  immediately (`reason: "no hub provider"`).
- Hub finalizes only after every targeted provider has replied, so a late
  `block`/`confirm` cannot be lost to an earlier `allow` from another provider.
  A pending request is dropped after 30 minutes if a provider never replies.

## Open

- Is `confirm` handled by the provider (UI there) or returned to the requester?
- Provider replies are not attributed beyond `from`; no trust check.
