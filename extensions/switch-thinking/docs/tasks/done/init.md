# Switch Thinking Extension – Design & Implementation Plan

## 1) Goal
Build a reusable pi extension that makes thinking-mode switching fast:

- `Ctrl+Shift+T` opens a thinking-mode picker
  - `Enter`: select mode + close picker
  - `Space`: toggle favorite on highlighted mode + keep picker open
- `Ctrl+T` cycles through favorite thinking modes
  - This action is for normal chat/editor context (when picker is closed)

Extension source lives in this folder and includes install instructions for other pi agents.

---

## 2) Functional Requirements

### Required behavior
1. Show available thinking modes in a list UI.
2. Selecting with `Enter` applies mode via `pi.setThinkingLevel(...)`.
3. Pressing `Space` toggles favorite on selected mode without closing the UI.
4. List navigation supports both arrow keys and vim-style keys (`j`/`k`).
5. `Ctrl+T` cycles through favorites only.
6. Favorites are **global** (shared across sessions), so a new session still uses the same favorites.
7. Extension degrades safely when no UI is available.

### Reusability expectations
- Keep logic modular (state + UI + shortcut handlers).
- Keep state format versioned for migrations.
- Avoid project-specific assumptions.

---

## 3) Technical Constraints (Important)

`Ctrl+T` is a built-in keybinding for `toggleThinking` and is non-overridable while mapped to that action.

Implication:
- With default keybindings, extension `Ctrl+T` may be skipped.
- To enable favorite cycling on `Ctrl+T`, remap built-in `toggleThinking` to another key in `~/.pi/agent/keybindings.json`.

This must be clearly documented in README/install steps.

---

## 4) Proposed Architecture

## Files
- `index.ts` — entrypoint, shortcuts, events
- `state.ts` — global state load/save/sanitize helpers
- `ui.ts` — picker component (`ctx.ui.custom` + `SelectList`)
- `README.md` — usage + install instructions

(Initial implementation may keep all logic in `index.ts`; split when needed.)

## State model
```ts
type ThinkingMode = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface SwitchThinkingGlobalStateV1 {
  version: 1;
  favorites: ThinkingMode[]; // ordered, unique
}
```

Global storage path:
- `~/.pi/agent/space.dector-switch-thinking.json`

Persistence strategy:
- Read once on `session_start`.
- Save immediately whenever favorites change (atomic write: temp file + rename).
- Do not use session entries for favorites.

---

## 5) Thinking Modes and Availability

Canonical order:
1. `off`
2. `minimal`
3. `low`
4. `medium`
5. `high`
6. `xhigh`

Availability rule:
- If current model has `reasoning === false`, only `off` is available.
- Otherwise all canonical modes are available.

Notes:
- `pi.setThinkingLevel` is clamped by model capability.
- After setting, read `pi.getThinkingLevel()` and notify if clamped.

---

## 6) UX / Interaction Design

## `Ctrl+Shift+T` picker
Use `ctx.ui.custom` + `SelectList`.

Item label examples:
- `★ high` (favorite)
- `  medium` (not favorite)

Description tags:
- `current`
- `favorite`

Input handling:
- Arrow keys: `SelectList` navigation
- Vim navigation: `j` = down, `k` = up (implemented in wrapper `handleInput(...)` by adjusting selection index)
- `Enter`: `SelectList.onSelect` (apply + close)
- `Esc`: `SelectList.onCancel`
- `Space`: custom handler in wrapper `handleInput(...)`
  1. `selectList.getSelectedItem()`
  2. toggle favorite
  3. rebuild list and preserve selected value
  4. `tui.requestRender()`

Footer hint:
- `↑↓/j k navigate • enter select • space favorite • esc cancel`

## `Ctrl+T` cycling (chat/editor context only)
- Behavior applies when thinking picker is closed.
- If favorites empty: warning notification.
- If one favorite: apply it.
- If multiple favorites: cycle in canonical order.
- Start from current mode if it is in favorites; otherwise start at first available favorite.

---

## 7) Event & Shortcut Plan

Register events:
- `session_start` → load global favorites and sanitize
- `model_select` → optional notify if currently selected favorite unavailable

Register shortcuts:
- `Key.ctrlShift("t")` → open picker
- `Key.ctrl("t")` → cycle favorites (chat/editor context)

Optional status indicator:
- `ctx.ui.setStatus("switch-thinking", "🧠 fav:high,medium")`
- Optional to avoid clutter.

---

## 8) Edge Cases

1. **No UI (`ctx.hasUI === false`)**
   - picker shortcut no-op; cycle can still run if shortcut is available.
2. **Favorites include unavailable modes on current model**
   - keep them in global file; filter at runtime.
3. **All favorites unavailable for current model**
   - notify and do nothing.
4. **Corrupt global JSON**
   - ignore, fallback to empty favorites, notify warning.
5. **Global file write failure (permissions/disk)**
   - notify error, keep in-memory state for current runtime.
6. **`Ctrl+T` conflict with built-in keybinding**
   - document remap requirement.

---

## 9) Testing Plan (Manual)

1. Open picker (`Ctrl+Shift+T`) and verify mode list.
2. Verify list navigation with both arrow keys and vim keys (`j`/`k`).
3. Press `Space` on items: star toggles, picker remains open.
4. Press `Enter`: mode changes, picker closes.
5. Press `Ctrl+T` in: cycles favorites.
7. Start a brand-new session: verify favorites persist and `Ctrl+T` still cycles correctly.
8. Switch to non-reasoning model: only `off` is effectively available.
9. Validate default-keybinding conflict and behavior after remapping `toggleThinking`.

---

## 10) Install Instructions for Other pi Agents (to include in README)

1. Place extension in auto-discovered path:
   - Global: `~/.pi/agent/extensions/switch-thinking/index.ts`
   - Project: `.pi/extensions/switch-thinking/index.ts`
2. Reload with `/reload`.
3. **Required for `Ctrl+T`**: remap built-in `toggleThinking` in `~/.pi/agent/keybindings.json`, e.g.:
   ```json
   {
     "toggleThinking": ["ctrl+alt+t"]
   }
   ```
4. Verify active shortcuts with `/hotkeys`.
5. Favorites are stored globally at `~/.pi/agent/space.dector-switch-thinking.json`.

---

## 11) Implementation Checklist

- [x] Create `index.ts` with shortcuts and core handlers
- [x] Implement global state load/save (`~/.pi/agent/space.dector-switch-thinking.json`)
- [x] Add safe JSON parse + sanitize + atomic write
- [x] Build picker UI with `SelectList`, vim navigation (`j`/`k`), and `Space` favorite toggle
- [x] Implement `Ctrl+T` cycle logic for favorites
- [x] Ensure `Ctrl+T` is chat/editor action only when picker is closed
- [x] Add notifications for empty/unavailable favorites and IO errors
- [x] Update `README.md` with global persistence + keybinding remap instructions
