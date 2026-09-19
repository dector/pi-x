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
most-restrictive arbitration. `safe-mode` is the first provider (permissions);
`subagent` is the first requester (`perm:agent`).

## Commands

- `/px:hub` — show registered providers and pending permission requests.

See [`PROTOCOL.md`](PROTOCOL.md) for the channel and payload contract.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/hub/`
- Project-local: `.pi/extensions/hub/`

Then run `/reload`.
