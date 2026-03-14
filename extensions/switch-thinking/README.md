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

## Install (standard pi extension layout)

Install as a source extension directory (recommended for pi extensions):

- Global: copy this folder to `~/.pi/agent/extensions/switch-thinking/`
- Project-local: copy this folder to `.pi/extensions/switch-thinking/`

Required files in that folder:
- `index.ts`
- `state.ts`
- `ui.ts`

Then:

1. Run `/reload`
2. (Required for cycling on `Ctrl+T`) remap `toggleThinking` as shown above
3. Run `/hotkeys` to verify bindings

## Development notes

- No bundle step is required for normal pi usage.
- pi loads TypeScript extensions directly.
- Keep imports relative (`./state`, `./ui`) so the copied folder works as-is.

## pi core follow-up (suggested)

This extension currently uses a UI-side workaround to keep its status line in sync when thinking level is changed via `/settings`.

Suggested core improvement in pi:

- Emit an extension event when thinking level changes (for example: `thinking_level_change` with previous/new level).

Why this helps:

- Native footer already reads live session state and updates immediately.
- Extension statuses are snapshots (`setStatus`) and cannot auto-refresh unless an extension gets a callback.
- A dedicated event would remove the need for input-timing workarounds.

## Notes

- Status rendering is emitted via status-bar events (`status-bar:set` / `status-bar:clear` with `id: "switch-thinking"`) rather than direct `ui.setStatus`.
- In non-UI modes, picker is skipped safely.
- If favorites are empty or unavailable on current model, the extension shows a warning and does nothing.
- Corrupt favorites JSON falls back to empty favorites.
