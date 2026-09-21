# Idea: semantic progress reporting through hub

Status: design proposal; not implemented.

This document defines a V1 contract and implementation plan for agent-reported
progress. It is intentionally detailed so implementation can be delegated to a
less capable model in small, testable stages.

## Document index

Line ranges are exact for this revision of the document.

- [1. Problem](#1-problem) — lines 60–80
- [2. V1 decisions](#2-v1-decisions) — lines 81–115
- [3. Terminology](#3-terminology) — lines 116–129
- [4. Architecture](#4-architecture) — lines 130–162
- [5. Data model](#5-data-model) — lines 163–294
  - [5.1 Chunk state and phase](#51-chunk-state-and-phase) — lines 165–198
  - [5.2 Tracker outcome](#52-tracker-outcome) — lines 199–208
  - [5.3 Stored and observer shapes](#53-stored-and-observer-shapes) — lines 209–294
- [6. Hub event contract](#6-hub-event-contract) — lines 295–447
  - [6.1 Channels](#61-channels) — lines 297–327
  - [6.2 Mutation payloads](#62-mutation-payloads) — lines 328–385
  - [6.3 Acknowledgements](#63-acknowledgements) — lines 386–427
  - [6.4 Query and snapshot](#64-query-and-snapshot) — lines 428–447
- [7. Registry semantics](#7-registry-semantics) — lines 448–558
  - [7.1 Keys and ownership](#71-keys-and-ownership) — lines 453–468
  - [7.2 Create](#72-create) — lines 469–481
  - [7.3 Update](#73-update) — lines 482–498
  - [7.4 Finish](#74-finish) — lines 499–509
  - [7.5 Remove and reset](#75-remove-and-reset) — lines 510–522
  - [7.6 Bounds](#76-bounds) — lines 523–558
- [8. Model-facing `progress` tool](#8-model-facing-progress-tool) — lines 559–671
  - [8.1 Actions](#81-actions) — lines 563–625
  - [8.2 Tool behavior](#82-tool-behavior) — lines 626–662
  - [8.3 Suggested files](#83-suggested-files) — lines 663–671
- [9. Subagent relay protocol](#9-subagent-relay-protocol) — lines 672–780
  - [9.1 Why a relay is required](#91-why-a-relay-is-required) — lines 674–683
  - [9.2 Relay envelope](#92-relay-envelope) — lines 684–716
  - [9.3 Parent handling](#93-parent-handling) — lines 717–770
  - [9.4 Nested subagents](#94-nested-subagents) — lines 771–780
- [10. Observer and UI behavior](#10-observer-and-ui-behavior) — lines 781–897
  - [10.1 Status-bar observer](#101-status-bar-observer) — lines 783–802
  - [10.2 Formatting one tracker](#102-formatting-one-tracker) — lines 803–850
  - [10.3 Pure formatter](#103-pure-formatter) — lines 851–863
  - [10.4 Detailed command](#104-detailed-command) — lines 864–897
- [11. Lifecycle, safety, and compatibility](#11-lifecycle-safety-and-compatibility) — lines 898–926
- [12. Detailed implementation plan](#12-detailed-implementation-plan) — lines 927–1283
  - [Stage 1: freeze the public contract](#stage-1-freeze-the-public-contract) — lines 932–953
  - [Stage 2: implement the pure registry](#stage-2-implement-the-pure-registry) — lines 954–1015
  - [Stage 3: wire the registry into hub events](#stage-3-wire-the-registry-into-hub-events) — lines 1016–1068
  - [Stage 4: add the direct progress tool](#stage-4-add-the-direct-progress-tool) — lines 1069–1117
  - [Stage 5: add child-to-parent relay](#stage-5-add-child-to-parent-relay) — lines 1118–1172
  - [Stage 6: add status-bar observer and formatter](#stage-6-add-status-bar-observer-and-formatter) — lines 1173–1222
  - [Stage 7: documentation and manual smoke test](#stage-7-documentation-and-manual-smoke-test) — lines 1223–1260
  - [Stage 8: final regression pass](#stage-8-final-regression-pass) — lines 1261–1283
- [13. Acceptance criteria](#13-acceptance-criteria) — lines 1284–1305
- [14. Deferred follow-ups](#14-deferred-follow-ups) — lines 1306–1321

## 1. Problem

The existing subagent UI reports process activity: a worker is starting, using a
tool, waiting for approval, or finished. It does not report the semantic state
of a larger plan.

For a milestone with 13 implementation stages, the useful status is closer to:

```text
Authentication · Stage 1/13 (reviewing)
```

For parallel work, it is closer to:

```text
Authentication · 4/13 done · 2 active · 1 blocked
```

Pi cannot reliably infer this from tool calls. The coordinating agent and its
subagents must report semantic progress explicitly.

## 2. V1 decisions

V1 will:

- add a generic `progress` tool;
- represent known work as a tracker containing an immutable ordered list of
  chunks;
- keep lifecycle state separate from free-form phase text;
- store and aggregate progress in the hub;
- publish detached snapshots for observers;
- show active progress through the status-bar extension;
- provide `/px:progress` for a detailed view;
- relay progress from a subagent process into its immediate parent's hub;
- make the tool available to restricted-tool subagents when the parent has the
  progress tool installed;
- protect a removed-and-recreated tracker from updates carrying its old opaque
  tracker token;
- keep data in memory for the current session only;
- require an explicit `finish` operation instead of guessing that the whole
  plan is complete.

V1 will not:

- parse milestone Markdown files automatically;
- persist progress across Pi restarts;
- schedule work or resolve dependencies;
- estimate time remaining;
- derive semantic progress from tool activity, assistant text, or subagent
  runtime state;
- support direct reporting from a nested grandchild to the root process;
- treat phase/detail text as hidden reasoning. It is display metadata only.

A future milestone-file adapter can create and update the same generic tracker.
The protocol must not depend on Markdown.

## 3. Terminology

- **Tracker**: one plan or milestone, for example `Authentication`.
- **Chunk**: one countable unit of work. A milestone stage is one kind of chunk.
- **Chunk state**: machine-readable lifecycle state.
- **Phase**: optional display text such as `implementing`, `testing`, or
  `reviewing` while a chunk is active.
- **Owner**: extension identity used to isolate protocol clients.
- **Observer**: an extension that consumes aggregate snapshots without reading
  hub internals. The status bar is the first observer.

Do not call a subagent run a chunk automatically. One subagent may implement a
whole chunk, part of a chunk, or several chunks.

## 4. Architecture

```text
root agent progress tool
        |
        | hub:progress:create/update/finish/remove
        v
  root hub ProgressRegistry
        |
        | hub:progress:changed
        +----------------------> status-bar observer
        |
        +----------------------> /px:progress

child progress tool
        |
        | extension UI setStatus relay (RPC-safe)
        v
parent subagent extension
        |
        | validated hub:progress:* event
        v
  parent hub ProgressRegistry
```

`pi.events` is process-local. A hub running in a child process cannot update the
parent hub directly. The child path therefore needs an explicit relay through
the existing subagent RPC UI channel.

The hub remains a broker and aggregate-state owner. It does not decide what the
work means, when an agent should report, or whether a milestone is well
structured.

## 5. Data model

### 5.1 Chunk state and phase

```ts
export const PROGRESS_CHUNK_STATES = [
  "pending",
  "active",
  "blocked",
  "done",
  "failed",
  "skipped",
] as const;

export type ProgressChunkState = (typeof PROGRESS_CHUNK_STATES)[number];
```

State has strict semantics:

| state | meaning | terminal |
| --- | --- | --- |
| `pending` | known but not started | no |
| `active` | work is currently happening | no |
| `blocked` | cannot continue without an external change | no |
| `done` | completed successfully | yes |
| `failed` | permanently failed for this tracker run | yes |
| `skipped` | intentionally omitted | yes |

`reviewing` is a phase, not a state:

```ts
{ state: "active", phase: "reviewing" }
```

This keeps counting predictable while allowing different workflows.

### 5.2 Tracker outcome

```ts
export const PROGRESS_OUTCOMES = ["completed", "failed", "cancelled"] as const;
export type ProgressOutcome = (typeof PROGRESS_OUTCOMES)[number];
```

An absent outcome means the tracker is active. `finish` sets the outcome and
freezes the tracker.

### 5.3 Stored and observer shapes

The registry keeps full records internally, including chunk IDs, labels,
details, outcomes, summaries, and timestamps. The public observer snapshot is
intentionally lightweight and contains active trackers only. This avoids
copying all finished history and long details on every chunk update.

Add these public types to the hub progress contract:

```ts
export interface ProgressChunkDefinition {
  id: string;
  label?: string;
}

export interface ProgressChunkSnapshot {
  /** One-based and immutable. Derived from create order. */
  index: number;
  state: ProgressChunkState;
  phase?: string;
}

export interface ProgressTrackerSnapshot {
  trackerId: string;
  owner: string;
  title: string;
  /** Singular display noun, for example "Stage" or "File". */
  unit: string;
  chunks: ProgressChunkSnapshot[];
  updatedAt: number;
}

export interface ProgressSnapshot {
  /** True exactly when `count > 0`. */
  active: boolean;
  /** Number of unfinished trackers; always equals `trackers.length`. */
  count: number;
  /** Unfinished trackers only. */
  trackers: ProgressTrackerSnapshot[];
}
```

The pure registry additionally exports full record types for hub-owned commands
and tests:

```ts
export interface ProgressChunkRecord {
  id: string;
  index: number;
  label?: string;
  state: ProgressChunkState;
  phase?: string;
  detail?: string;
  updatedAt: number;
}

export interface ProgressTrackerRecord {
  trackerId: string;
  trackerToken: string;
  owner: string;
  title: string;
  unit: string;
  chunks: ProgressChunkRecord[];
  outcome?: ProgressOutcome;
  summary?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}
```

Rules:

- `index` is one-based because it is displayed to users.
- Total work is `tracker.chunks.length`; do not store a second mutable `total`.
- All timestamps are generated by the receiving hub using `Date.now()`.
- Snapshots are deep detached from registry state and observers are required to
  treat them as read-only. One `pi.events.emit` shares one payload object among
  listeners, so an earlier observer can mutate what a later observer sees; V1
  does not promise a distinct clone or enforce freezing per observer.
- Snapshot order is `updatedAt` descending, then `owner` and `trackerId`
  ascending as deterministic tie-breakers.
- Chunk order is always creation order.
- Full records are available only to hub-owned commands/registry tests. The
  observer protocol does not expose `detail`, labels, outcomes, or history.

## 6. Hub event contract

### 6.1 Channels

Add to `extensions/hub/contract.ts`:

```ts
export const HUB_PROGRESS_CHANNELS = {
  create: "hub:progress:create",
  update: "hub:progress:update",
  finish: "hub:progress:finish",
  remove: "hub:progress:remove",
  changed: "hub:progress:changed",
  ack: "hub:progress:ack",
  query: "hub:progress:query",
  snapshot: "hub:progress:snapshot",
} as const;
```

| channel | direction | purpose |
| --- | --- | --- |
| `create` | producer -> hub | create one tracker and all known chunks |
| `update` | producer -> hub | replace one chunk's reported state/metadata |
| `finish` | producer -> hub | set a terminal tracker outcome |
| `remove` | producer -> hub | remove a tracker owned by that producer |
| `changed` | hub -> observers | publish aggregate snapshot after a real mutation |
| `ack` | hub -> producer | accept or reject one valid mutation request |
| `query` | observer -> hub | request the current snapshot |
| `snapshot` | hub -> observer | correlated response to `query` |

This is an observer protocol, not a capability. Do not add progress to
`HUB_CHANNELS.register` or permission arbitration.

### 6.2 Mutation payloads

Every mutation has a correlation `requestId`. This lets a tool distinguish its
synchronous acknowledgement from another producer's operation.

```ts
export interface ProgressCreatePayload {
  requestId: string;
  trackerId: string;
  /** Opaque identity token generated by the producer for this incarnation. */
  trackerToken: string;
  owner: string;
  title: string;
  unit?: string;
  chunks: ProgressChunkDefinition[];
}

export interface ProgressUpdatePayload {
  requestId: string;
  trackerId: string;
  trackerToken: string;
  owner: string;
  chunkId: string;
  state: ProgressChunkState;
  /** Omission clears the previous phase. */
  phase?: string;
  /** Omission clears the previous detail. */
  detail?: string;
}

export interface ProgressFinishPayload {
  requestId: string;
  trackerId: string;
  trackerToken: string;
  owner: string;
  outcome: ProgressOutcome;
  summary?: string;
}

export interface ProgressRemovePayload {
  requestId: string;
  trackerId: string;
  trackerToken: string;
  owner: string;
}
```

`update` is a complete replacement of the chunk's reportable metadata. An
omitted `phase` or `detail` clears the previous value. This avoids ambiguous
patch semantics.

`trackerToken` is an opaque concurrency identity, not an authorization secret.
It prevents a delayed update for a removed tracker from mutating a new tracker
that reuses the same `owner + trackerId`. The same token is required for every
operation on one tracker incarnation. Updates within one incarnation are
last-arrival-wins while the chunk is nonterminal; coordinators must assign only
one writer per chunk.

### 6.3 Acknowledgements

```ts
export type ProgressOperation = "create" | "update" | "finish" | "remove";

export type ProgressAckError =
  | "already-exists"
  | "not-found"
  | "limit-exceeded"
  | "stale-tracker"
  | "tracker-finished"
  | "chunk-terminal"
  | "invalid-transition"
  | "incomplete"
  | "conflict";

export interface HubProgressAckPayload {
  requestId: string;
  trackerId: string;
  trackerToken: string;
  owner: string;
  operation: ProgressOperation;
  ok: boolean;
  changed: boolean;
  error?: ProgressAckError;
}
```

Rules:

- Syntactically malformed payloads are ignored and receive no acknowledgement.
- A syntactically valid but semantically rejected operation receives
  `ok: false` and an `error`.
- `ack.changed` describes a mutation of the full registry record/history.
  Accepted idempotent operations receive `ok: true, changed: false`.
- Emit `ack` before `changed`, matching the user-wait protocol.
- Emit `hub:progress:changed` only when the lightweight active snapshot changes.
  For example, clearing an already-finished history record changes the registry
  but does not emit an identical observer snapshot.
- Pi event dispatch is synchronous. A direct client installs an ack listener,
  emits the mutation, and knows the result before `emit` returns.

### 6.4 Query and snapshot

```ts
export interface ProgressQueryPayload {
  requestId: string;
}

export interface HubProgressSnapshotPayload {
  requestId: string;
  snapshot: ProgressSnapshot;
}
```

`hub:progress:changed` carries `ProgressSnapshot` directly.
`hub:progress:snapshot` carries the correlated wrapper above.

Observers must subscribe to `snapshot` before emitting `query`, otherwise the
synchronous query response can be missed. They should subscribe to `changed`
separately for later mutations.

## 7. Registry semantics

Implement a pure `ProgressRegistry` in `extensions/hub/progress.ts`. It must not
import Pi runtime APIs.

### 7.1 Keys and ownership

Trackers are keyed by `owner + trackerId` and guarded by `trackerToken`.

- The same `trackerId` from different owners is distinct.
- An update, finish, or remove only addresses the matching owner and token.
- For update, finish, or remove, if the owner/ID exists but the token differs,
  reject with `stale-tracker`. A conflicting create uses `already-exists` as
  specified below.
- The model-facing tool uses the fixed owner `progress-tool`; `owner` is not a
  model parameter.
- Protocol clients outside the tool choose their own stable extension owner.
- Ownership and the token prevent accidental collisions; they are not a
  security boundary. A child that receives a tracker token is trusted. V1 does
  not enforce per-chunk child authority.

### 7.2 Create

- Require at least one chunk.
- Require unique, non-empty chunk IDs within the tracker.
- Initialize every chunk as `pending` with no phase or detail.
- Default an absent `unit` to `Item`.
- An exact repeated create with the same token and immutable definition is
  accepted as an idempotent no-op. Compare only title, unit, and chunk
  order/IDs/labels; current chunk state is not part of duplicate equality.
- A create using an existing owner/tracker ID with a different token or
  immutable definition is rejected with `already-exists`.
- A create over the active-tracker bound is rejected with `limit-exceeded`.

### 7.3 Update

- Reject an unknown tracker or chunk with `not-found`.
- Reject every update after the tracker is finished with `tracker-finished`.
- `pending`, `active`, and `blocked` chunks may transition to any chunk state.
- `phase` is valid only with `state: "active"`. Reject a non-empty phase for any
  other state with `invalid-transition`. This guarantees that blocked always
  renders as blocked.
- `done`, `failed`, and `skipped` are terminal. An exact repeated update is an
  idempotent no-op; a different update is rejected with `chunk-terminal`.
- Store the new state, phase, and detail together.
- Update chunk and tracker timestamps only on a real change.

A retry should keep a chunk `blocked` and later return it to `active`. Producers
should report `failed` only when the chunk is permanently failed for this
tracker run.

### 7.4 Finish

- Reject an unknown tracker with `not-found`.
- Repeating the exact same outcome and summary is an idempotent no-op.
- Reject a different second finish with `conflict`.
- `completed` is valid only when every chunk is `done` or `skipped`; otherwise
  reject it with `incomplete`.
- `failed` and `cancelled` may finish early.
- A successful finish sets `outcome`, optional summary, `finishedAt`, and
  `updatedAt`, then freezes the tracker.

### 7.5 Remove and reset

- Remove only the exact `owner + trackerId + trackerToken` incarnation.
- Removing an unknown or wrong-owner tracker is an accepted no-op. If the
  owner/ID exists with another token, reject with `stale-tracker` so an old
  clear cannot remove a recreated tracker.
- Session shutdown resets all trackers.
- Reset emits one final empty `changed` snapshot only when active observer state
  actually changed.
- Retain at most `MAX_FINISHED_PROGRESS_TRACKERS` finished records. Finishing a
  new one evicts the oldest finished record when necessary; active trackers are
  never silently evicted.

### 7.6 Bounds

Use named exported constants so limits are visible and testable:

```ts
MAX_ACTIVE_PROGRESS_TRACKERS = 8
MAX_FINISHED_PROGRESS_TRACKERS = 16
MAX_PROGRESS_CHUNKS = 100
MAX_PROGRESS_REQUEST_ID_LENGTH = 128
MAX_PROGRESS_OWNER_LENGTH = 128
MAX_PROGRESS_TRACKER_ID_LENGTH = 128
MAX_PROGRESS_TRACKER_TOKEN_LENGTH = 128
MAX_PROGRESS_CHUNK_ID_LENGTH = 128
MAX_PROGRESS_TITLE_LENGTH = 200
MAX_PROGRESS_UNIT_LENGTH = 40
MAX_PROGRESS_LABEL_LENGTH = 200
MAX_PROGRESS_PHASE_LENGTH = 80
MAX_PROGRESS_DETAIL_LENGTH = 500
MAX_PROGRESS_SUMMARY_LENGTH = 500
MAX_PROGRESS_RELAY_BYTES = 256 * 1024
```

Each named limit applies to the field named in the constant. Oversized strings,
tokens, owners, request IDs, and chunk arrays are syntactically invalid and
receive no ack. `limit-exceeded` is reserved for valid creates that exceed the
current active-tracker capacity. Measure relay size with
`Buffer.byteLength(statusText, "utf8")`, not JavaScript string length. The
create bounds fit under the relay bound even for heavily escaped valid strings;
add a boundary test to preserve that relationship.

Reject over-limit input. Do not silently truncate protocol data. Rendering code
still sanitizes and truncates to terminal width.

Text is display-only. Producers must not include prompts, credentials, command
bodies, hidden reasoning, or other sensitive content.

## 8. Model-facing `progress` tool

Register the tool from the hub extension.

### 8.1 Actions

The tool has four discriminated actions.

#### Start

```json
{
  "action": "start",
  "title": "Authentication",
  "unit": "Stage",
  "chunks": [
    { "id": "schema", "label": "Database schema" },
    { "id": "api", "label": "API" },
    { "id": "ui", "label": "UI" }
  ]
}
```

`trackerId` may be supplied for deterministic integration tests or generated as
`progress-<time>-<random>` when omitted. Generate a fresh opaque
`trackerToken` too. Return both values in human-readable text and structured
tool details. The coordinating agent must retain both.

#### Update

```json
{
  "action": "update",
  "trackerId": "progress-...",
  "trackerToken": "pt-...",
  "chunkId": "api",
  "state": "active",
  "phase": "reviewing",
  "detail": "Checking request validation"
}
```

#### Finish

```json
{
  "action": "finish",
  "trackerId": "progress-...",
  "trackerToken": "pt-...",
  "outcome": "completed",
  "summary": "All stages implemented and reviewed"
}
```

#### Clear

```json
{
  "action": "clear",
  "trackerId": "progress-...",
  "trackerToken": "pt-..."
}
```

The tool action is named `clear` for model readability and maps to the protocol
`remove` operation.

### 8.2 Tool behavior

- Use a TypeBox discriminated union if Pi renders it correctly. If that causes
  poor tool schema output, use one object with optional fields and perform
  strict action-specific validation in `execute`.
- Do not expose `owner` or `requestId` to the model. `trackerToken` is exposed
  because later calls and delegated children need it.
- Use `owner: "progress-tool"`.
- Generate a fresh request ID for every call.
- Direct/root execution waits for the synchronous `ack`.
- Invalid action arguments, a negative ack, or an absent ack must throw
  `Error`; returning error-looking text would still mark the tool call
  successful in Pi.
- Use `progress hub unavailable` for an absent ack; do not claim success.
- Child execution uses the relay described below and reports `sent to parent`
  rather than falsely claiming that the parent accepted it.
- Keep tool output concise. Do not return the complete tracker snapshot after
  every update.

Safe-mode must classify `progress` as a safe internal state-reporting tool and
auto-allow it in every mode, including PARANOID, before the generic
"PARANOID confirms every tool" branch. The implementation performs only
bounded in-memory event updates or the bounded parent relay; it does not touch
the filesystem, shell, or network. Without this explicit exception, every
report from restricted children would prompt or fail headlessly. Add dedicated
policy tests so this exception cannot accidentally broaden to other tools.

The description should instruct agents to:

1. start a tracker only when there are multiple known chunks;
2. report meaningful transitions, not every tool call;
3. use `phase` for workflow words such as `reviewing`;
4. mark each chunk terminal;
5. call `finish` once the whole tracker has an outcome;
6. pass `trackerId`, `trackerToken`, and `chunkId` in a subagent task when that
   subagent owns a chunk.

### 8.3 Suggested files

Keep tool concerns out of the already large hub entrypoint:

- `extensions/hub/progress-tool.ts` — TypeBox schema, rendering, tool
  registration, direct client, and child relay sender.
- `extensions/hub/progress-tool.test.ts` — argument validation, generated IDs,
  ack success/failure, and child relay tests.

## 9. Subagent relay protocol

### 9.1 Why a relay is required

Each subagent is a separate Pi process. Its `pi.events` bus and hub registry are
local to that process. Emitting `hub:progress:update` in the child would not
reach the parent UI.

The existing subagent RPC transport already carries fire-and-forget extension
UI `setStatus` requests. Child controls use the same mechanism with
`px:subagent-control`.

### 9.2 Relay envelope

Use a dedicated internal status key:

```ts
export const PROGRESS_RELAY_STATUS_KEY = "px:hub-progress-relay";
```

Hub and subagent must mirror this small wire constant locally. Do not import one
extension's runtime module from the other: each extension must still load when
the other is absent. Add a comment beside each copy pointing to this protocol.

The child serializes:

```ts
interface ProgressRelayEnvelope {
  version: 1;
  channel:
    | "hub:progress:create"
    | "hub:progress:update"
    | "hub:progress:finish"
    | "hub:progress:remove";
  payload: Record<string, unknown>;
}
```

When `PI_SUBAGENT_CHILD === "1"`, the tool must not mutate its local registry.
It calls:

```ts
ctx.ui.setStatus(PROGRESS_RELAY_STATUS_KEY, JSON.stringify(envelope));
```

### 9.3 Parent handling

In the subagent extension's `onExtensionUiRequest` handler:

1. Detect `method === "setStatus"` and the exact relay status key.
2. Require string `statusText` no larger than
   `MAX_PROGRESS_RELAY_BYTES` (256 KiB), measured with
   `Buffer.byteLength(statusText, "utf8")`. This inner check validates the
   message; it does not claim the underlying line-oriented RPC decoder is a
   general memory boundary.
3. Parse JSON in `try/catch`.
4. Require `version === 1`.
5. Allow only the four mutation channels above.
6. Require a record payload.
7. Overwrite `payload.owner` with `progress-tool`; never trust a relayed owner.
8. Emit the selected event on the parent's `pi.events` bus.
9. Swallow malformed envelopes and append at most one concise diagnostic to the
   child result. Never crash the run.
10. Return before generic `setStatus` handling.

Pass a small callback into `runSingleAgent` instead of importing the hub from
the subagent extension. This keeps hub optional and follows the existing
string-contract style.

Restricted-tool agents need one additional spawn rule. Before building child
`--tools`, check whether `pi.getAllTools()` in the parent contains `progress`.
If it does and an agent has an explicit tools list, append `progress` unless it
is already present. If the parent does not have the tool, preserve the list
exactly. This makes shipped scouts/planners/reviewers able to report without
making subagent installation depend on hub. Add a test with a restrictive
shipped agent and a test proving the list is unchanged when progress is absent.

Suggested extraction:

- `extensions/subagent/progress-relay.ts` — constants and pure
  `parseProgressRelay(statusText)` helper.
- `extensions/subagent/progress-relay.test.ts` — allowlist, size limit, malformed
  JSON, owner overwrite, and version tests.
- `extensions/subagent/index.ts` — recognize the status key and invoke a runtime
  callback that emits the parent event.

The relay is best-effort because `setStatus` has no child-facing response. Hub
validation and acknowledgement still happen in the parent, but V1 does not send
that acknowledgement back to the child tool result. Therefore a child tool call
means only that a valid envelope was handed to its parent transport, not that
the parent accepted the state transition.

Do not automatically clear relayed progress when a child process exits. This
protocol stores semantic milestone state, not child presence. A child may mark
a chunk `done` immediately before exit, and cleanup must not erase that result.
If a child fails while its chunk is still active, the coordinating parent is
responsible for reporting the chunk as blocked or failed after observing the
subagent result.

### 9.4 Nested subagents

V1 guarantees only immediate child -> parent relay. If a grandchild reports,
its update reaches the middle process's hub, not automatically the root hub.
The middle agent should report the assigned root chunk after its nested work
settles.

A future V2 can add upward relay forwarding or explicit tracker assignment in
the subagent tool schema. Do not attempt it accidentally in V1.

## 10. Observer and UI behavior

### 10.1 Status-bar observer

The status-bar extension subscribes to `hub:progress:changed`. On
`session_start` and `session_tree`, it emits a correlated
`hub:progress:query` after installing its snapshot listener.

Do not make status-bar inspect hub internals. Do not make hub emit private
`px:status-bar:*` events for this feature.

Store one internal extra row:

```text
row id: hub-progress
order: 50
```

`proc` currently uses order `100`, so progress appears before it.

Hide the row when `snapshot.active === false`.

### 10.2 Formatting one tracker

Sanitize ANSI escapes/control characters in every text field before display.
Create a dedicated `sanitizeUntrustedProgressText` that strips ANSI/OSC escapes
and all C0/C1 controls. Do **not** reuse `sanitizeStatusText`; that helper
intentionally preserves producer-supplied ANSI color. The existing status-bar
terminal-width truncation remains the final bound.

If exactly one chunk is `active` or `blocked`, use the focused form:

```text
Authentication · Stage 1/13 (reviewing)
Authentication · Stage 1/13 (blocked)
```

For an `active` chunk, render its phase or fall back to `working`. For a
`blocked` chunk, always render `blocked`. The registry rejects phases on other
states. Chunk labels are not in the lightweight observer snapshot and are not
rendered in the V1 status row.

If several chunks are active/blocked, use the aggregate form:

```text
Authentication · 4/13 done · 2 active · 1 blocked
```

Only include non-zero optional counts (`blocked`, `failed`, `skipped`). If no chunk is active or blocked but pending chunks remain, show pending count:

```text
Authentication · 4/13 done · 9 pending
```

If every chunk is terminal but the coordinator forgot `finish`, keep the row
visible and make the required action explicit:

```text
Authentication · 13/13 settled · awaiting finish
```

If multiple trackers are active, render the most recently updated tracker and
append:

```text
 · +2 trackers
```

Do not create one footer row per tracker in V1; it can flood small terminals.

### 10.3 Pure formatter

Create `extensions/status-bar/progress.ts` containing:

- strict structural parsing for an unknown snapshot;
- count helpers;
- selection of the most recently updated active tracker;
- `formatProgressRow(snapshot)` returning `string | undefined`.

Keep formatting pure and test it independently. The observer in
`extensions/status-bar/index.ts` should only update/delete `rowById` and request
a render.

### 10.4 Detailed command

Add `/px:progress [trackerId]` in the hub extension.

With no argument, show one-line summaries for every active tracker and at most
the 10 most recently finished trackers. Never dump every chunk from every
tracker into one notification.

With a tracker ID, show its chunks (at most 100 by contract):

```text
Authentication [active] — 1/13 done
1. [active/reviewing] Database schema
2. [pending] API
...
```

Finished summary examples:

```text
Authentication [completed] — 13/13 done
Authentication [failed] — 7/13 done, 1 failed
```

If the same ID exists under multiple owners, require `owner/trackerId` for the
detailed form. All fields use the same one-line sanitization already used by
`/px:hub`. `/px:hub` should add only a compact line:

```text
progress trackers: 2 (1 active)
```

It should not duplicate the full `/px:progress` listing.

## 11. Lifecycle, safety, and compatibility

- Register all event listeners during extension factory execution, as the hub
  already does. Do not wait for `session_start` to install listeners.
- Keep a progress-session active flag. Set it on `session_start`, retain it on
  `session_tree`, and clear it at the beginning of `session_shutdown` before
  resetting the registry. Ignore late mutation relays while inactive so a child
  exit race cannot repopulate progress after shutdown.
- Reset progress on `session_shutdown` after emitting the final empty changed
  snapshot when necessary.
- `session_tree` does not reset progress; it is still the same live process.
- Existing permission, user-wait, Herdr, and subagent behavior must remain
  unchanged except for the explicit, name-exact safe-mode allow rule for the
  in-memory `progress` reporting tool.
- Progress does not emit `herdr:blocked`. Only explicit user waits control that
  compatibility event.
- A blocked chunk is semantic project state, not proof that Pi is waiting for a
  user.
- Finished trackers remain available to `/px:progress` until explicitly
  cleared, session shutdown, or eviction from the bounded 16-entry finished
  history. They are excluded from observer snapshots and the active status row.
- Observer payloads are untrusted display data. Sanitize with the dedicated
  progress sanitizer before rendering.
- Hub, status-bar, and subagent mirror progress wire strings/types locally where
  needed. They must not add runtime imports between independently installable
  extension directories.
- Do not log or display raw malformed relay payloads.
- Do not silently evict a live tracker when bounds are reached.

## 12. Detailed implementation plan

Each stage below should be one small change with tests. Do not begin with UI or
subagent wiring. Build and verify the pure state machine first.

### Stage 1: freeze the public contract

Files:

- modify `extensions/hub/contract.ts`;
- modify `extensions/hub/PROTOCOL.md`.

Tasks:

1. Add channel constants exactly as specified in section 6.1.
2. Add/re-export all payload, state, outcome, tracker, snapshot, ack, and query
   types.
3. Document that progress is an observer protocol, not permission arbitration.
4. Document child process locality and the relay requirement.
5. Do not modify existing channel names or payloads.

Verification:

- Existing hub tests compile and pass.
- A grep finds one canonical definition of every hub progress channel in the
  hub extension.

### Stage 2: implement the pure registry

Files:

- create `extensions/hub/progress.ts`;
- create `extensions/hub/progress.test.ts`.

Tasks:

1. Define limits and enum guards.
2. Write parsers for create, update, finish, remove, and query payloads.
3. Make parser input `unknown`; reject arrays, null, empty required strings,
   unknown states/outcomes, duplicate chunk IDs, and oversized fields.
4. Implement `ProgressRegistry` with an injectable clock:
   `new ProgressRegistry(() => Date.now())`.
5. Implement create semantics and exact duplicate comparison.
6. Implement update transitions and terminal protection.
7. Implement finish validation and freezing.
8. Implement idempotent remove and reset.
9. Implement deep-copy, deterministic snapshots.
10. Return a transition/result object containing `ok`, registry `changed`,
    `snapshotChanged`, optional error, and the post-operation active snapshot.
    Keep protocol acknowledgement construction outside the registry if that
    makes the class cleaner.

Required tests:

- every parser accepts a minimal valid payload;
- every parser rejects malformed and over-limit fields without ack-worthy
  registry input;
- active tracker capacity returns `limit-exceeded` for an otherwise valid
  create;
- chunk IDs must be unique;
- owner + tracker ID is a composite key and token is checked on mutations;
- a stale token cannot update, finish, or remove a recreated tracker;
- updates within one live token use documented last-arrival-wins semantics;
- exact duplicate create is a no-op;
- conflicting duplicate create, including a different token, rejects as
  `already-exists`;
- pending -> active -> done succeeds;
- active -> blocked -> active succeeds;
- a non-active state with phase rejects as `invalid-transition`;
- terminal chunk mutation rejects;
- identical terminal update is idempotent;
- completed finish rejects while any chunk is nonterminal or failed;
- completed finish accepts all done/skipped;
- failed/cancelled finish may occur early;
- second conflicting finish rejects;
- unknown remove is an accepted no-op;
- active tracker/chunk bounds reject without mutating state;
- finished history evicts only its oldest record at its bound;
- timestamps change only on real mutations;
- snapshot ordering is deterministic;
- mutating a snapshot cannot mutate the registry;
- reset returns an empty snapshot.

Run:

```bash
bun test extensions/hub/progress.test.ts
```

### Stage 3: wire the registry into hub events

Files:

- modify `extensions/hub/index.ts`;
- create `extensions/hub/progress-wiring.test.ts`;
- update fake Pi objects in existing hub wiring tests with a no-op
  `registerTool` if needed later.

Tasks:

1. Instantiate one `ProgressRegistry` beside `UserWaitRegistry`.
2. Add one handler for each mutation channel.
3. Parse before changing state.
4. Emit ack before changed.
5. Emit changed only on `snapshotChanged: true`; use registry `changed` in the
   acknowledgement.
6. Deep-copy snapshots before observer emission.
7. Implement query -> correlated snapshot.
8. Add the progress-session active gate: activate on `session_start`, keep it
   active on `session_tree`, deactivate before shutdown reset, and ignore late
   mutations while inactive.
9. Reset during session shutdown without changing user-wait/Herdr behavior.
10. Add compact progress counts to `/px:hub`.
11. Add `/px:progress` with sanitized output.

Required wiring tests:

- create emits ack then changed;
- duplicate create emits only ack;
- semantic rejection emits negative ack and no changed;
- malformed payload emits nothing;
- update changed snapshot contains the new chunk state;
- finish freezes later updates;
- wrong-owner remove does not remove;
- query returns the current detached snapshot synchronously;
- a mutating observer cannot corrupt registry state;
- shutdown emits one empty snapshot when active trackers exist;
- shutdown emits no progress event when observer state is already empty;
- a late child mutation after shutdown is ignored and cannot restore state;
- a new `session_start` re-enables valid mutations;
- `/px:hub` count is correct and sanitized;
- `/px:progress` detail is correct and sanitized;
- existing user-wait tests still pass unchanged except fake API support.

Run:

```bash
bun test extensions/hub/progress-wiring.test.ts \
  extensions/hub/user-wait.test.ts \
  extensions/hub/user-wait-wiring.test.ts
```

### Stage 4: add the direct progress tool

Files:

- create `extensions/hub/progress-tool.ts`;
- create `extensions/hub/progress-tool.test.ts`;
- modify `extensions/hub/index.ts` to register the tool;
- modify `extensions/safe-mode/policy.ts`;
- modify `extensions/safe-mode/policy.test.ts`.

Tasks:

1. Define the four model actions.
2. Validate required fields per action.
3. Generate tracker/request IDs.
4. Implement a synchronous hub client that listens for matching ack, emits one
   event, then always unsubscribes.
5. Convert negative ack and absent ack into concise tool errors.
6. Return structured details suitable for tests but keep visible text short.
7. Add concise renderCall output.
8. Add the behavioral guidance from section 8.2 to the tool description.
9. Add the narrow safe-mode rule that auto-allows only the `progress` tool in
   every mode before PARANOID's generic confirmation rule.
10. Stub `registerTool` in every fake ExtensionAPI used by hub tests.

Required tests:

- start generates and returns a tracker ID and tracker token;
- supplied tracker ID is preserved while a fresh token is generated;
- each action emits the correct payload with hidden owner/request ID;
- update phase/detail omission clears them;
- a matching positive ack succeeds;
- negative ack becomes a tool error;
- unrelated ack is ignored;
- absent ack becomes an unavailable error;
- listener is removed after success and failure;
- invalid action fields do not emit an event;
- safe-mode allows `progress` in paranoid, reader, smart, and yolo;
- the adjacent safe-mode test proves an unknown internal-looking tool is not
  accidentally allowed.

Run:

```bash
bun test extensions/hub/progress-tool.test.ts \
  extensions/hub/progress-wiring.test.ts \
  extensions/safe-mode/policy.test.ts
```

### Stage 5: add child-to-parent relay

Files:

- create `extensions/subagent/progress-relay.ts`;
- create `extensions/subagent/progress-relay.test.ts`;
- modify `extensions/subagent/index.ts`;
- modify child behavior in `extensions/hub/progress-tool.ts`;
- extend `extensions/hub/progress-tool.test.ts`.

Tasks:

1. Add the versioned envelope and status key.
2. In a child, serialize normalized tool operations through `ctx.ui.setStatus`.
3. In subagent, parse only that exact status key.
4. Add a runtime callback to `SingleAgentRuntimeDependencies`; keep parsing pure.
5. Force relayed owner to `progress-tool`.
6. Emit only allowlisted mutation channels into parent `pi.events`.
7. Ignore malformed/oversized input without crashing.
8. Bound diagnostics so a bad child cannot grow result memory indefinitely.
9. Verify both process and Herdr backends use the same
   `onExtensionUiRequest` path; do not add backend-specific relay code.
10. When the parent has a registered `progress` tool, append it to an agent's
    explicit child tool list. Do not change restricted lists when progress is
    absent, and do not duplicate an existing entry.

Required tests:

- child tool sends one correctly versioned envelope and does not emit locally;
- all four mutation operations relay;
- unknown channel, version, malformed JSON, non-record payload, and oversized
  text reject;
- relayed owner is overwritten;
- a malformed relay cannot throw out of the parent event handler;
- ordinary `setStatus`, notifications, approvals, and child controls still
  work;
- child finalization does not automatically clear semantic tracker/chunk state;
- a restrictive shipped agent receives `progress` when available and keeps its
  exact original tool list when unavailable;
- an integration-style test proves child update -> parent hub changed snapshot.

Run:

```bash
bun test extensions/subagent/progress-relay.test.ts \
  extensions/subagent/events.test.ts \
  extensions/hub/progress-tool.test.ts
```

Then run the broader subagent suite because `index.ts` is high risk:

```bash
bun test extensions/subagent
```

### Stage 6: add status-bar observer and formatter

Files:

- create `extensions/status-bar/progress.ts`;
- create `extensions/status-bar/progress.test.ts`;
- modify `extensions/status-bar/index.ts`;
- modify `extensions/status-bar/README.md`.

Tasks:

1. Mirror the hub progress channel strings/types locally; do not import hub
   runtime files.
2. Parse unknown snapshots defensively.
3. Implement pure count and formatting helpers.
4. Implement focused, parallel, pending, awaiting-finish, and
   multiple-tracker formats.
5. Subscribe to changed during extension construction.
6. Subscribe to snapshot responses before sending a query.
7. Query on session start/tree with a unique request ID.
8. Store the formatted result as internal row `hub-progress`, order `50`.
9. Remove that row for an empty/no-active snapshot.
10. Clear cached progress state on session shutdown so late events cannot
    restore stale UI.
11. Request a render after every effective row change.

Required tests:

- one active chunk renders `Stage 1/13 (working)`;
- a phase renders `(reviewing)`;
- one blocked chunk renders `(blocked)`;
- several active chunks render aggregate counts;
- pending-only tracker renders pending count;
- failed/skipped counts appear only when non-zero;
- latest active tracker is selected;
- `+N trackers` is correct;
- an empty active snapshot hides the row;
- an all-terminal unfinished tracker renders `awaiting finish`;
- malformed snapshots are ignored safely;
- the dedicated sanitizer strips ANSI/OSC and C0/C1 controls;
- query response restores state after observer startup;
- shutdown prevents stale restoration;
- existing footer row ordering remains stable.

Run:

```bash
bun test extensions/status-bar/progress.test.ts extensions/status-bar
```

### Stage 7: documentation and manual smoke test

Files:

- modify `extensions/hub/README.md`;
- modify `extensions/hub/PROTOCOL.md`;
- modify `extensions/hub/todo.md`;
- modify `extensions/subagent/README.md`;
- modify `extensions/status-bar/README.md`.

Tasks:

1. Document the tool with one sequential and one parallel example.
2. Document session-only lifetime and explicit clear behavior.
3. Document the immediate-child relay limitation.
4. Add a dedicated progress/status observer item to the hub roadmap, then mark
   it complete only after all tests and smoke tests pass. Do not repurpose the
   existing user-wait status-bar observer item.
5. Keep future persistence and milestone parsing as unchecked follow-ups.

Manual smoke test:

1. Start Pi through `./pitest` so hub, subagent, and status-bar load.
2. Call `progress start` with three chunks and unit `Stage`.
3. Mark chunk 1 active with phase `reviewing`.
4. Verify the footer shows `Stage 1/3 (reviewing)`.
5. Mark chunk 1 done and chunks 2/3 active; verify aggregate format.
6. Spawn a restrictive-tool subagent and give it tracker ID, tracker token,
   and chunk ID in its task.
7. Have the child report `active`, then `done`.
8. Verify the root footer changes while the child is running.
9. Finish the tracker; verify the active footer row disappears.
10. Run `/px:progress`; verify the completed tracker remains visible.
11. Clear it; verify it disappears from `/px:progress`.
12. Repeat one update in a Herdr-backed subagent.
13. End the session with an active tracker and confirm no progress row leaks into
    a new session.

### Stage 8: final regression pass

Run the focused suites first, then all extension tests used by the project.
At minimum:

```bash
bun test extensions/hub \
  extensions/status-bar \
  extensions/subagent \
  extensions/safe-mode
```

Review specifically for:

- event-listener leaks;
- mutable snapshots;
- unbounded text/array input;
- accidental Herdr blocked events;
- regressions in child approval/control forwarding;
- status rows surviving shutdown;
- a tool claiming parent acceptance for a best-effort child relay;
- hidden reasoning or sensitive text in phase/detail fields.

## 13. Acceptance criteria

V1 is complete only when all are true:

1. A root agent can create a tracker, update chunks, finish it, and clear it
   using the `progress` tool.
2. The status bar shows `Stage 1/13 (reviewing)` for the single-active case.
3. Parallel chunks show aggregate done/active/blocked counts.
4. A direct child subagent can send a progress relay that changes the parent
   hub snapshot and parent status row; its local result describes delivery as
   best-effort rather than claiming parent acceptance.
5. Progress is never inferred from generic tool calls or subagent runtime state.
6. Blocked progress does not emit `herdr:blocked`.
7. Finished trackers leave the active row and remain in the bounded
   `/px:progress` history until cleared, evicted as oldest, or shutdown.
8. Malformed, oversized, wrong-owner, stale-token, and terminal-conflicting
   updates do not corrupt registry state or crash Pi.
9. Observer snapshots are detached and deterministic.
10. Existing hub permissions, user waits, status-bar rows, subagent controls,
    process backend, and Herdr backend tests continue to pass.
11. Documentation states that V1 is session-only and direct-child-only.

## 14. Deferred follow-ups

These are deliberately outside V1:

- parse a milestone document into tracker/chunk definitions;
- write completion markers back to a milestone document;
- persist trackers in the Pi session or a sidecar file;
- explicit tracker/chunk assignment fields on the `subagent` tool;
- automatic root forwarding for nested subagents;
- dependency graphs and weighted chunks;
- percentage-only progress for work without discrete chunks;
- completion/failure notifications;
- a dedicated interactive progress view;
- historical duration and cost per chunk.

Implement these only after the explicit V1 contract has proven useful.