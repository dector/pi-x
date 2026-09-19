# hub protocol (draft)

Namespace: `hub:`. Transport: `pi.events`.

Status: draft. Payloads below are the agreed shape; marked items are still open.

## Channels

| channel | direction | payload |
| --- | --- | --- |
| `hub:register` | client → hub | `{ id, caps: { provide: string[] } }` |
| `hub:unregister` | client → hub | `{ id }` |
| `hub:ask` | client → hub | `{ id, from?, cap: CapRequest[] }` |
| `hub:request` | hub → provider | `{ id, from?, cap: CapRequest[], targets: string[] }` |
| `hub:answer` | provider → client | `{ id, results: CapResult[] }` |

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

## Flow

```
requester ──hub:ask──> hub ──hub:request──> provider
requester <────────────hub:answer────────── provider
```

## Open

- Arbitration when several providers can answer one `what`.
- Behavior when no provider is registered (deny? prompt? allow?).
- Timeout and fallback.
- Does `hub:ask` carry `ctx` so a provider can prompt? (repo convention: yes.)
- Is `confirm` handled by the provider (UI there) or returned to the requester?
