# switch-thinking (pi extension)

Quickly switch thinking modes and cycle favorite modes.

## Features

- `Ctrl+Alt+T` opens a thinking-mode picker
  - `Enter`: apply highlighted mode and close
  - `Space`: toggle favorite on highlighted mode and keep picker open
  - `↑/↓` or `j/k`: navigate
  - `Esc`: close
- `Ctrl+T` cycles through favorite thinking modes (canonical order: `off → minimal → low → medium → high → xhigh`)
- Favorites are persisted globally at:
  - `~/.pi/agent/space.dector-switch-thinking.json`

Availability rules:
- Reasoning model: all modes available
- Non-reasoning model: only `off` available

## Important keybinding conflict (`Ctrl+T`)

`Ctrl+T` is built in as `toggleThinking` and is non-overridable while mapped.

To make extension cycling work on `Ctrl+T`, remap `toggleThinking` in:
`~/.pi/agent/keybindings.json`

Example:

```json
{
  "toggleThinking": ["ctrl+shift+t"]
}
```

## Install (recommended: bundled single file)

> For pi agents: install from `dist/index.js` by default. Use source files only if the user explicitly asks for that.

Copy `dist/index.js` as a single-file extension:

- Global: `~/.pi/agent/extensions/switch-thinking.js`
- Project-local: `.pi/extensions/switch-thinking.js`

Then:

1. Run `/reload`
2. (Required for cycling on `Ctrl+T`) remap `toggleThinking` as shown above
3. Run `/hotkeys` to verify bindings

## Build from sources

One-liner (run from repository root):

```bash
bun build ./extensions/switch-thinking/index.ts --outfile ./extensions/switch-thinking/dist/index.js --target=node --format=esm --packages=bundle --external @mariozechner/pi-coding-agent --external @mariozechner/pi-tui
```

Notes:
- `dist/index.js` is committed to git.
- Local extension files (`state.ts`, `ui.ts`) are bundled into `dist/index.js`.
- `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` stay external because pi provides them at runtime.

## Contributing / release checklist

Before opening a release PR:

- [ ] Run the bundling one-liner above
- [ ] Verify `extensions/switch-thinking/dist/index.js` is updated in git diff
- [ ] Smoke-test by loading the bundled file (`switch-thinking.js`) and running `/reload`
- [ ] Confirm picker (`Ctrl+Alt+T`) and cycle (`Ctrl+T`) still work

## Notes

- In non-UI modes, picker is skipped safely.
- If favorites are empty or unavailable on current model, the extension shows a warning and does nothing.
- Corrupt favorites JSON falls back to empty favorites.
