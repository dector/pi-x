# permissions-core (pi extension)

Headless network permission policy engine. This extension is the planned
successor to safe-mode's network disposition, split into pure, testable
modules.

Stage 1 provides only the policy model. There is **no `index.ts` yet**, so the
extension is not loadable by pi. Hub wiring, persistence, and HTTP enforcement
arrive in later stages.

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

## API

`policy.ts` exports validation/normalization (`parseNetworkPermissionRequest`,
`normalizeHttpMethod`, `normalizeNetworkUrl`), classification
(`classifyNetworkTrust`), policy mapping (`dispositionForPolicy`,
`evaluateNetworkPermission`), Auto derivation (`deriveAutoNetworkPolicy`),
state resolution (`resolveNetworkPermissionState`,
`createInitialNetworkPermissionState`), and serializable state helpers
(`parseNetworkPermissionState`, `serializeNetworkPermissionState`).

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
