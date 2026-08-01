# no-reflection (pi extension)

Removes pi's built-in documentation reference block from the agent system prompt before the agent starts.

This is based on the old `dump-system-prompt` behavior, but it does **not** write the system prompt anywhere and does not register any dump command.

## Environment toggle

The extension is enabled by default.

Set `PI_NO_REFLECTION` to any of these values to disable all work done by this extension:

- `false`
- `no`
- `n`
- `0`

Matching is case-insensitive and ignores surrounding whitespace.

## Install (standard pi extension layout)

Install as a source extension directory:

- Global: copy this folder to `~/.pi/agent/extensions/no-reflection/`
- Project-local: copy this folder to `.pi/extensions/no-reflection/`

Required file in that folder:

- `index.ts`

Then run `/reload`.
