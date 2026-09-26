# permissions-ui (pi extension)

`/px:net` selector for the session network permission policy. It is the control
surface for `permissions-core`; all reads and writes go through that extension's
validated event contract. This extension owns no policy logic and no persisted
state.

Status: the selector is implemented and is the only policy control in V1;
`neo-bar` renders the resulting effective token.

## Usage

```text
/px:net
```

Opens a selector with Auto plus the five explicit policies:

```text
Auto (NET?)             Follow safe mode (Ask if untrusted)
NET  Deny all           Block every valid network request
NET? Ask for all        Ask before every valid network request
NET  Allow trusted      Allow GET/HEAD/OPTIONS and search; block other methods
NET? Ask if untrusted   Allow read-only and search; ask for other methods
NET+ Allow all          Allow every valid network request
```

The token and color on each row are the effective status a policy produces:

| Policy | Token | Color |
| --- | --- | --- |
| `deny-all` | `NET` | gray |
| `ask-all` | `NET?` | gray |
| `allow-trusted` | `NET` | white |
| `ask-untrusted` | `NET?` | white |
| `allow-all` | `NET+` | white |

The Auto row shows the token derived from the current safe mode
(`autoEffective`), independent of the configured explicit choice. So with an
explicit `allow-all` under SMART, the Allow all row shows `NET+` while Auto
still shows `NET?`. The configured setting is preselected, so the current
choice is visible without cycling.

There is no keyboard shortcut in V1, and the selector never cycles policies
blindly.

## PARANOID override

While PARANOID is active, the selector shows a notice and still lets the user
change the saved choice:

```text
PARANOID currently forces: NET? (Ask for all)
Your saved network policy: NET+ (Allow all)
```

The change is stored for use after leaving PARANOID. The core keeps the
effective policy at `ask-all` (gray `NET?`) until then.

## Contract

Reads and writes use the permissions-core state contract (event names and
payloads are mirrored in `contract.ts`, not imported across extension
directories):

| channel | direction | payload |
| --- | --- | --- |
| `px:permissions-core:net:state:request` | ui → core | `{ id }` |
| `px:permissions-core:net:state:response` | core → ui | `{ id, state }` |
| `px:permissions-core:net:state:set` | ui → core | `{ setting, source }` |
| `px:permissions-core:net:state:changed` | core → ui | `{ configured, effective, autoEffective, overriddenByParanoid, source? }` |

The command queries the current state, lets the user pick, then emits `set` and
waits for a matching `changed` confirmation (preferring an ack carrying the
`permissions-ui` source). If no confirmation arrives before the timeout, it
re-queries the current state and accepts the update when the configured setting
already equals the request. That closes the no-op race where the core already
has the requested setting and therefore emits no `changed`. Failures are
explicit:

- no response from the core: notify that permissions-core is unavailable and do
  nothing;
- invalid selection: notify an error and do nothing;
- no confirmation of the update: notify that the update was not accepted.

No local state is cached or changed directly.

## Files

- `contract.ts` — duplicated event names and payload parsers.
- `options.ts` — pure row construction, token/color mapping, selection mapping,
  and PARANOID notice text.
- `query.ts` — bounded read-only state query.
- `apply.ts` — bounded `set`/`changed` round trip with the no-op re-query fallback.
- `commands.ts` — testable `/px:net` flow.
- `ui.ts` — SelectList picker.
- `index.ts` — pi wiring and the `set`/`changed` round trip.

## Tests

```sh
bun test
bun run typecheck
```

`options.test.ts` covers every policy's token/color, Auto derived-token behavior
(including with an explicit configured policy), `isCurrent`, selection mapping,
and the PARANOID notice. `contract.test.ts` covers payload validation.
`query.test.ts` covers response matching and timeouts. `apply.test.ts` covers
the `set`/`changed` ack, source matching, and the no-op re-query race.
`commands.test.ts` covers unavailable/invalid/already-set/accepted/rejected
paths. `flow.test.ts` loads the real hub, permissions-core, and permissions-ui
and exercises the `/px:net` change through the contract.
