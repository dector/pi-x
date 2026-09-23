# Panels

Coordinates the editor panels that extensions dock around the input editor.

Every panel is stacked into one coordinator-owned above-editor widget
(`px-panels`) in a fixed order. Every panel starts collapsed as a one-line
summary; at most one panel is expanded at a time, and only the user expands one.
`Alt+P` cycles the visible panels forward and then collapses them all;
`Alt+Shift+P` walks the same cycle in reverse. The coordinator owns both
shortcuts exclusively; panels never register them and never call
`ctx.ui.setWidget` themselves.

## Why one widget

Panels used to each own an above-editor widget. That made on-screen order depend
on registration/refresh timing and remounted a widget on every cycle or refresh,
which flickered. Now the coordinator renders all panels from cached content in
`order`, so the display is stable no matter when a panel publishes. The single
component is mounted once and only invalidated/repainted on updates.

## Protocol

Panels talk to the coordinator over the shared `pi.events` bus. The channel
names and payload types live in `contract.ts`.

| Event | Direction | Payload | Meaning |
| --- | --- | --- | --- |
| `px:panels:register` | panel -> coordinator | `{ id, label, order, visible }` | Announce or refresh a panel. |
| `px:panels:visibility` | panel -> coordinator | `{ id, visible }` | The panel appeared (`true`) or disappeared (`false`). |
| `px:panels:content` | panel -> coordinator | `{ id, content, render }` | Publish formatted lines and a width renderer. |
| `px:panels:sync` | panel -> coordinator | none | Ask the coordinator to re-broadcast the active panel. |
| `px:panels:active` | coordinator -> panels | `{ activeId: string \| null }` | The active panel changed; `null` means all collapsed. |

`id` is a stable unique string. `label` is used in the notification. `order`
fixes the display and cycle position (lower first, then `id` as a tie-break).
`visible` means "the panel currently has something to show"; an invisible panel
is skipped by the cycle. There is no default panel: registration never selects
one.

`content` is the panel's already-formatted lines, or `undefined` (or `[]`) when
it has nothing to show. `render(content, width)` fits those lines to the
terminal width and returns the final lines. The coordinator calls it at draw
time, so each panel keeps its own wrapping, inset, and theme styling. Publishing
`content: undefined` removes the panel from the widget immediately, so a
disappeared panel never leaves stale lines behind. The coordinator caches
content even before the panel registers, and mounts it once the registration
supplies the order.

## Selection rules

- Every panel starts collapsed (`activeId` is `null`). Registering a panel,
  syncing, or changing another panel's visibility never expands one. Only the
  user expands a panel with a cycle key.
- `order` controls the display and cycle position, so the sequence does not
  depend on whether `panels`, `subagent`, or `proc` loads first.
- `Alt+P` cycles the visible panels in `order`, then `null` (all collapsed).
  The default forward sequence from all-collapsed is
  `null -> subagents -> processes -> null`. `Alt+Shift+P` walks the same sequence
  backwards: `null -> processes -> subagents -> null`.
- When the active panel disappears (unregisters or reports `visible: false`),
  every panel collapses and stays collapsed until the user presses a cycle key.
  Nothing is auto-restored after a disappearance.
- `register` and `sync` always re-broadcast the current active id, so a panel
  that subscribes late still learns the selection. A user's collapsed choice
  survives later registrations and syncs.

## Example

```ts
pi.events.emit("px:panels:register", {
  id: "processes",
  label: "Processes",
  order: 20,
  visible: true,
});
// Registration only announces the panel; it stays collapsed until Alt+P.

// Publish formatted lines plus the width renderer. Never call setWidget.
pi.events.emit("px:panels:content", {
  id: "processes",
  content: formatProcessesWidget(entries),
  render: renderProcessesWidgetContent,
});

const off = pi.events.on("px:panels:active", (payload) => {
  const { activeId } = payload as { activeId: string | null };
  setExpanded(activeId === "processes");
});
```

## Files

- `index.ts` - event wiring and the `Alt+P` / `Alt+Shift+P` shortcuts.
- `contract.ts` - channel names, payload types, and payload validation.
- `coordinator.ts` - the pure selection state machine plus the content cache.
- `widget.ts` - the single reusable `px-panels` component.
- `coordinator.test.ts` - default-collapsed, cycle, visibility, content-order, and reload tests.
- `index.test.ts` - event wiring, shortcut, and widget-mount tests.

## Reload safety

`pi.events` is a shared bus that is not cleared on `/reload`, so the coordinator
keeps every subscription handle and releases them on `session_shutdown` (which
fires before the reload). It also clears the widget and all cached content on
shutdown. State lives in the extension closure; no `globalThis` singleton is
used, so reloads cannot accumulate coordinators or stale listeners.

Content published during a panel's `session_start` may arrive before the
coordinator's own `session_start`. The coordinator caches it and mounts the
widget as soon as a session context exists, so no content is lost.
