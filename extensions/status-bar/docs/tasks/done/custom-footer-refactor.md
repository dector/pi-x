# status-bar custom-footer refactor (done)

Status: completed


## Objective

Refactor `status-bar` to render via `ctx.ui.setFooter(...)` so sections can be truly aligned across terminal width:

- left: pinned left
- center: centered (when space allows)
- right: pinned right

Keep producer API unchanged:

- `status-bar:set` `{ id, content }`
- `status-bar:clear` `{ id }`

---

## Why this refactor is needed

Current implementation writes a single `ctx.ui.setStatus("status-bar", ...)` value.
Pi core footer sanitizes and flattens extension statuses (including collapsing repeated spaces), so spacing-based right alignment cannot be preserved.

---

## Scope

### In scope

1. Replace status-bar output path from `setStatus()` to `setFooter()`.
2. Preserve current producer contract and section layout behavior.
3. Implement width-aware 3-section layout for one footer line.
4. Preserve ANSI colors from producer content.
5. Keep existing `status-bar` commands working (`contract`, `set`, `clear`).

### Out of scope

- Changing producer event names/payloads.
- Changing producer extensions (`safe-mode`, `switch-thinking`, `context-watcher`) except if minor compatibility tweaks are required.

---

## Implementation plan

### 1) Build a custom footer component in `extensions/status-bar/index.ts`

- Install footer using `ctx.ui.setFooter(factory)` once UI context is available.
- Inside factory:
  - Return a component implementing `render(width)`.
  - Subscribe to `footerData.onBranchChange(() => tui.requestRender())`.
  - Cleanup subscription in `dispose()`.

### 2) Keep status-bar producer state as-is

- Continue storing producer text in `contentById: Map<string, string>`.
- Continue resolving section text via IDs from `DEFAULT_STATUS_BAR_LAYOUT`.
- Keep item delimiter: `STATUS_BAR_JOIN_SEPARATOR`.

### 3) Implement a 3-section line composer

Create helper:

- `renderThreeSectionLine(width, left?, center?, right?) => string`

Placement priority:

1. Try exact placement with no overlap:
   - left at column 0
   - center centered
   - right right-aligned
2. Fallback to left + right (drop center) if overlap.
3. Fallback to truncated left/right variants.
4. Last fallback: left only.

Requirements:

- Use ANSI-aware width (`visibleWidth`) and truncation (`truncateToWidth`).
- Preserve producer color codes.

### 4) Recreate default footer essentials (since custom footer replaces built-in)

Render lines comparable to default footer:

- Line 1: cwd, git branch, optional session name
- Line 2: token/cost/context/model summary (or close equivalent)
- Line 3: status-bar line with left/center/right alignment

Data sources:

- Session + usage via `ctx.sessionManager` / `ctx.getContextUsage()`
- Model/thinking from `ctx.model` and `pi.getThinkingLevel()`
- Git branch from `footerData.getGitBranch()`

### 5) Event wiring

Re-render on:

- `status-bar:set` / `status-bar:clear`
- session events (`session_start`, `session_switch`, `session_tree`, `session_fork`)
- model/thinking/turn/message events if needed for live stats

On shutdown:

- Optionally restore default footer with `ctx.ui.setFooter(undefined)`.
- Ensure listener cleanup.

### 6) Keep dev commands intact

- `/status-bar-contract`
- `/status-bar-set <id> <content>`
- `/status-bar-clear <id>`

Update contract message text to mention custom footer rendering.

---

## Acceptance criteria

1. Right section content (e.g. `context-watcher`) visually appears at right edge.
2. Left/center/right do not overlap in common terminal widths.
3. Narrow width behavior degrades gracefully (center drop/truncation).
4. Producer colors remain intact.
5. Existing producers work without changes.
6. No duplicate footers or stale renders across session switches.

---

## Manual test checklist

1. `/reload`
2. Confirm footer renders with status-bar line.
3. Emit test values:
   - `/status-bar-set safe-mode [SMART]`
   - `/status-bar-set switch-thinking off low`
   - `/status-bar-set context-watcher CTX:10.0%`
4. Verify:
   - safe-mode/switch-thinking on left
   - context-watcher on right edge
5. Resize terminal and re-check truncation behavior.
6. `/status-bar-clear context-watcher` and verify removal.
7. Session switch/fork/tree and ensure updates remain correct.

---

## Completion notes

Implemented:

- Renderer moved from `ctx.ui.setStatus(...)` to `ctx.ui.setFooter(...)`.
- Producer API unchanged (`status-bar:set`, `status-bar:clear`).
- Section contract and item delimiter preserved from `contract.ts`.
- True left/center/right alignment implemented with ANSI-aware width handling.
- Graceful fallback behavior implemented for narrow terminal widths.
- Existing producers and slash commands continue to work without changes.
- README/spec docs updated to match final behavior.

Manual verification summary:

- Right section alignment verified manually after reload.

## Risks / notes

- Custom footer fully replaces default footer; parity work is required to avoid regressions.
- Render frequency should be controlled to avoid flicker.
- ANSI width calculations must use pi-tui helpers, not plain string length.
