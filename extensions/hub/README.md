# hub (pi extension)

Central signal hub for cooperating pi-x extensions.

## Purpose

Most pi-x extensions currently talk to each other ad hoc over `pi.events`
(for example `neo-bar` producers and `pi-ui` actions). Hub is meant to
become the missing central point that defines and arbitrates those signals:
who is present, what each extension can do, and how requests/approvals flow
between them (permissions being the first target).

## Status

Provides the register/ask/reply/answer channels, a capability registry, and
most-restrictive arbitration. Providers: `safe-mode` (`perm:shell`, `perm:io`,
`perm:agent`), `permissions-core` (`perm:net`), and the `http` and `sqlite`
extensions (`perm:tool`). Safe-mode applies built-in fallback decisions when no
`perm:tool` provider answers. Requesters include `subagent`
(`perm:agent`) and the network tools (`perm:net`).

Hub also aggregates explicit **user waits**: a UI owner declares `set` before
opening a dialog and `clear` when it closes; hub publishes the aggregate on
`hub:user-wait:changed` and maps it to Herdr's `herdr:blocked` event. Hub never
infers a wait from a pending `hub:ask`.

## Commands

- `/px:hub` — show registered providers, pending permission requests, active
  user waits (`owner/<short-id>: label`), a compact progress count, and the
  current Herdr tab status (`<status> (<tab_id>)` or `off`).
- `/px:progress [owner/]trackerId` — show active and recently finished progress
  trackers, or one tracker's chunks with state and phase.

See [`PROTOCOL.md`](PROTOCOL.md) for the channel and payload contract.

## User waits

Hub is the broker for explicit user-wait state, not an owner of approval UI.
The extension that opens the dialog declares the wait; this keeps the UI and
policy in the provider/requester that already owns them.

- Pending `hub:ask` requests (including `perm:tool`/`perm:net` classifications
  and headless `confirm`-to-block results) are **never** treated as user waits.
- Waits are keyed by `owner` + `id`, so concurrent and nested waits from one or
  more extensions cannot clear each other. Each concrete wait uses a generated
  id; no shared per-owner id.
- `hub:user-wait:changed` is the integration-neutral observer contract: observers
  read `{ active, count, waits[] }` and must not inspect hub internals.
- Hub answers `set`/`clear` with `hub:user-wait:ack` and emits `changed` only on
  a real state or metadata change. Malformed payloads are ignored.
- Labels are display text only; consumers sanitize them before rendering.
  Request bodies, commands, and credentials must never be included.
- Session shutdown clears the registry and emits the final release transition.

### Herdr compatibility

Herdr's managed integration consumes the external `herdr:blocked` event and
keeps its own `blockedCount`. Hub emits it only on aggregate crossings:
`0 -> 1` as `{ active: true, label }`, `1 -> 0` as `{ active: false }`, and
nothing while the count stays non-zero. This prevents a label update or a second
concurrent wait from incrementing Herdr's counter into a stuck state. Safe-mode's
direct `herdr:blocked` emission is a fallback for an absent or old hub only
(see [`../safe-mode/README.md`](../safe-mode/README.md#herdr-blocked-state)).

## Progress

Hub brokers explicit **semantic progress** for a coordinating agent and its
subagents. The `progress` tool creates a tracker with a fixed, ordered tree,
reports each leaf's lifecycle state, and finishes the tracker. A node may name
an earlier `parentId`; a branch's `childUnit` names its direct children. Hub
publishes detached aggregate snapshots on `hub:progress:changed`; `neo-bar`
renders one footer row and `/px:progress` shows a detailed view. Progress is
reported state, never inferred from tool calls or subagent runtime state.

States are `pending`, `active`, `blocked`, `done`, `failed`, and `skipped`.
Containers cannot be updated; lifecycle and completion operate on leaves.
`reviewing` is a `phase` on an active leaf, not a state. `start` returns a
`trackerId` and an opaque `trackerToken`; later calls and delegated children
must pass both.

### Sequential example

Start a tracker, mark one chunk active with a phase, then done:

```json
{ "action": "start", "title": "Authentication", "unit": "Stage",
  "chunks": [ { "id": "schema", "label": "Database schema" },
              { "id": "api", "label": "API" },
              { "id": "ui", "label": "UI" } ] }
```

```json
{ "action": "update", "trackerId": "progress-...", "trackerToken": "pt-...",
  "chunkId": "schema", "state": "active", "phase": "reviewing" }
```

```json
{ "action": "update", "trackerId": "progress-...", "trackerToken": "pt-...",
  "chunkId": "schema", "state": "done" }
```

### Hierarchical example

Parents must occur before children. `unit` names roots and `childUnit` names a
branch's direct children. Match the noun to the work size: Milestone > Stage for
a large feature spanning sessions, Phase > Step for a multi-step task in one
session (both default to `Item`):

```json
{ "action": "start", "title": "Release", "unit": "Milestone",
  "chunks": [ { "id": "m1", "label": "Foundation", "childUnit": "Stage" },
              { "id": "auth", "parentId": "m1", "label": "Authentication" } ] }
```

A focused hierarchical leaf renders as
`Milestone 1/1: Foundation · Stage 1/1: Authentication · reviewing`.
Arbitrary depth is supported.

### Parallel example

Several chunks may be in flight at once; the footer switches from the focused
`Authentication · Stage 1/3: Database schema · reviewing` form to aggregate counts:

```json
{ "action": "update", "trackerId": "progress-...", "trackerToken": "pt-...",
  "chunkId": "api", "state": "active" }
```

```json
{ "action": "update", "trackerId": "progress-...", "trackerToken": "pt-...",
  "chunkId": "ui", "state": "blocked" }
```

Finish is explicit once the tracker has an outcome:

```json
{ "action": "finish", "trackerId": "progress-...", "trackerToken": "pt-...",
  "outcome": "completed", "summary": "All stages implemented and reviewed" }
```

### Lifetime and clear

- Progress is **session-only**. It is kept in memory, reset on session
  shutdown, and never persisted across restarts.
- A finished tracker leaves the active footer row but stays visible to
  `/px:progress` until it is explicitly cleared, evicted as the oldest finished
  record, or the session ends. Clear it with
  `{ "action": "clear", "trackerId": "progress-...", "trackerToken": "pt-..." }`.
- Hub never guesses completion; `finish` is always required.

### Child relay limitation

A subagent runs in its own process, so its `progress` calls are relayed through
`subagent` over a best-effort `setStatus` channel. The child learns only that a
valid envelope reached the parent transport, **not** that the parent accepted
the transition. Relay is **immediate-child only**: a grandchild reports to its
own process, never to the root. Relayed progress is not cleared when a child
exits; if a child fails with a chunk still active, the coordinator must report
that chunk `blocked` or `failed`. See
[`../subagent/README.md`](../subagent/README.md#progress-relay).

## Herdr tab status

When hub runs inside a Herdr-managed pane, it mirrors Herdr's agent status onto
that pane's tab label as a leading symbol. Herdr is the source of truth: hub
subscribes to `pane.agent_status_changed` and never infers state from Pi events.

| Herdr `agent_status` | symbol | tab label |
| --- | --- | --- |
| `working` | `◐` | `◐ 4` |
| `blocked` | `×` | `× 4` |
| `done` | `✓` | `✓ 4` |
| `idle` | none | `4` |
| `unknown` | none | `4` |

- Base label is captured once before the first write and restored on session
  shutdown.
- Detected only when `HERDR_ENV=1` and `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, and
  `HERDR_TAB_ID` are all set.
- It is a no-op outside Herdr, and it is gated on TUI mode, so RPC/print/JSON
  sessions never touch the socket. A failed seed read disables it for the
  session; other failures are logged and never throw into hub logic.
- Uses Herdr's socket API, not the `herdr` CLI (`HERDR_BIN_PATH` may be stale).

### Environment keys

| key | default | effect |
| --- | --- | --- |
| `PI_HUB_HERDR_TAB` | enabled | set to `0` to disable the feature |
| `PI_HUB_HERDR_TAB_STYLE` | `symbols` | `symbols` or `dots` (`blocked ◉`, `working`/`done` `●`) |

### Custom-label side effect

`tab.rename` sets a custom name, and Herdr has no "clear custom name" API.
After the first write the tab is permanently a custom label (rendered bold when
focused). On shutdown hub can only write the base text back, not reset the
automatic numeric label.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/hub/`
- Project-local: `.pi/extensions/hub/`

Then run `/reload`.
