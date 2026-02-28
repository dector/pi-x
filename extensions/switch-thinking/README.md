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

## Install

Place this extension in an auto-discovered extension path:

- Global:
  - `~/.pi/agent/extensions/switch-thinking/index.ts`
  - `~/.pi/agent/extensions/switch-thinking/state.ts`
  - `~/.pi/agent/extensions/switch-thinking/ui.ts`
- Project-local:
  - `.pi/extensions/switch-thinking/index.ts`
  - `.pi/extensions/switch-thinking/state.ts`
  - `.pi/extensions/switch-thinking/ui.ts`

Then:

1. Run `/reload`
2. (Required for cycling on `Ctrl+T`) remap `toggleThinking` as shown above
3. Run `/hotkeys` to verify bindings

## Notes

- In non-UI modes, picker is skipped safely.
- If favorites are empty or unavailable on current model, the extension shows a warning and does nothing.
- Corrupt favorites JSON falls back to empty favorites.
