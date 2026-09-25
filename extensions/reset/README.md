# reset

`/reset` starts a new, unnamed session with no conversation history. It retains
the active model and thinking level, safe mode and outer access, session-approved
exact bash commands, network policy, review level, and subagent rewire/delegation
depth through owner-scoped handoff events. The owners apply state after the new
runtime's `session_start`; model/effort changes are handled by the replacement
reset extension instance. Pi creates a new event bus per session, so the reset
instance exposes a process-local bridge to the replacement bus. Owner
acknowledgements are bounded to five seconds; missing ones produce a warning.

Other approvals, project bash approvals, progress, and UI state are not copied.
Managed `proc` processes survive by default. `/reset -proc` asks the process
manager to stop them after the new session is created, with a bounded wait and a
warning if any remain running.

`+agents` is not supported. Pi creates a new extension runtime and event bus for
the replacement session, and each running subagent's completion and control
callbacks are bound to the previous instance. A handoff would either lose those
completions or leak them into the wrong session, so `/reset +agents` is refused
without changing the session. Detach and finish active agents first, then
`/reset`.

## Usage

```text
/reset              fresh session, keep managed processes
/reset -proc        fresh session and stop managed processes
```

## Dependencies

Load the relevant state owners for their settings to transfer: `safe-mode`,
`permissions-core`, `review-level`, and `subagent`. `-proc` requires the `proc`
extension. Missing owners only affect their own setting and produce a warning;
the session still resets. `/reset` loads on its own and mirrors the few sibling
constants it needs (`contract.test.ts` guards them against drift).

Run focused tests with `bun test extensions/reset`.
