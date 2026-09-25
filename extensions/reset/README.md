# reset

`/reset` starts a new, unnamed session with no conversation history. It retains
the active model and thinking level, safe mode and outer access, session-approved
exact bash commands, network policy, review level, and subagent rewire/delegation
depth through owner-scoped handoff events. The owners apply state after the new
runtime's `session_start`; model/effort changes are handled by the replacement
reset extension instance. Owner acknowledgements are bounded to five seconds.

Other approvals, project bash approvals, progress, and UI state are not copied.
`/reset +agents` and `/reset -proc` are explicitly rejected until their separate
active-work checkpoint is implemented.

Load this extension with the relevant state owners (`safe-mode`,
`permissions-core`, `review-level`, and `subagent`) for their settings to transfer.
Run focused tests with `bun test extensions/reset`.
