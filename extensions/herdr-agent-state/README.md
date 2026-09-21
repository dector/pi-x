# herdr-agent-state (fork)

Fork of the official Herdr Pi integration. It reports Pi's lifecycle state
(`working` / `blocked` / `idle`) to the Herdr pane so Herdr can roll it up to
tabs and the sidebar.

Upstream: `herdrdev/herdr` → `src/integration/assets/pi/herdr-agent-state.ts`
(`HERDR_INTEGRATION_ID=pi`, `HERDR_INTEGRATION_VERSION=9`).

## Why this fork exists

The official integration only knows about the parent agent loop. It reports
`idle` on `agent_settled`, so a Pi session that detaches background work — for
example a `subagent` async dispatch — looks **done** in Herdr while the child
work is still running.

Herdr allows one status authority per pane, and a second `pane.report_agent`
source would either be ignored or fight the managed integration. The fix has to
live inside the integration.

## The change: `herdr:background`

The fork adds one Pi event that any extension can emit:

```ts
pi.events.emit("herdr:background", { id: "px:subagent", active: true });
// ... later, when the work settles:
pi.events.emit("herdr:background", { id: "px:subagent", active: false });
```

- `id` — stable, non-empty, ≤ 128 chars. Keyed so concurrent producers and
  parallel dispatch ids cannot clear each other.
- `active` — `true` registers/refreshes the id, `false` clears it. Anything
  else is ignored.
- While at least one id is active the pane reports `working`, even after the
  parent turn settles.
- Blocked (user wait) still wins over background work.
- Events that arrive before `session_start` are buffered, so producer and
  integration startup order does not matter.
- `session_shutdown` clears all ids.

The producer is the `subagent` extension: it emits one id per async dispatch on
start/settle and re-announces active ids on `session_start` / `session_tree`
(see `extensions/subagent/herdr-background.ts`).

Marked hunks (search for `FORK: background`):

1. header note;
2. `parseBackgroundId` / `applyBackgroundEvent` helpers before the default
   export;
3. `const background = new Set<string>()` in the default export;
4. `background.size > 0` in `desiredState()`;
5. the `herdr:background` listener and the `session_shutdown` clear.

## Rebasing onto a new official release

1. Re-vendor the official file over `index.ts`.
2. Re-apply the five `FORK: background` hunks. The diff is ~50 lines and touches
   nothing upstream-specific.
3. Bump the upstream version in the header comment.

## Install

`./install` writes this fork to Herdr's managed path
`~/.pi/agent/extensions/herdr-agent-state.ts`. The fork keeps the
`HERDR_INTEGRATION_ID=pi` / `HERDR_INTEGRATION_VERSION=9` markers, so
`herdr integration status` reports `pi: current` instead of nagging to install
the official one, and Pi still loads a single reporter.

Before touching any file, `./install` hashes an existing flat file:

- our fork (marker present) -> overwrite in place;
- exact upstream revision (`sha256 2c5272d7...aca1e4`) -> replace with the fork;
- anything else -> abort so a newer official integration is not silently lost.

On abort, choose:

```bash
./install --skip-herdr     # keep the file as-is, skip the fork
./install --replace-herdr  # overwrite it with this fork anyway
```

If Herdr reinstalls the official file (`herdr integration install pi`, or a
future version), rerun `./install` to restore the fork. A newer official version
aborts first, so you can rebase instead of silently losing the fix.
