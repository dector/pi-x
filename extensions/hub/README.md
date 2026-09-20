# hub (pi extension)

Central signal hub for cooperating pi-x extensions.

## Purpose

Most pi-x extensions currently talk to each other ad hoc over `pi.events`
(for example `status-bar` producers and `pi-ui` actions). Hub is meant to
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

## Commands

- `/px:hub` — show registered providers and pending permission requests, plus
  the current Herdr tab status (`<status> (<tab_id>)` or `off`).

See [`PROTOCOL.md`](PROTOCOL.md) for the channel and payload contract.

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
