# vim-mode — UX summary and intended design

Status: **the current code is stashed as buggy** (`git stash@{0}`). This file is
the spec to reimplement against. It summarizes the intended UX, the integration
contract, and the concrete gaps in what was stashed.

> **Rename note:** the shared frame extension was renamed `status-bar` →
> `neo-bar` (directory and package name). Its **event names and commands are
> unchanged** (`px:status-bar:*`, `/px:status-bar-*`), and the editor class is
> still `FrameStatusEditor`. This doc uses `neo-bar` for the extension and
> `px:status-bar:*` for the events.

Stashed files (old `status-bar` path; recoverable via `git stash@{0}`):

- `extensions/vim-mode/index.ts` — mode state, key gate, `/px:vim` command
- `extensions/vim-mode/scroll.ts` — TUI capture + transcript scroll helpers
- `extensions/neo-bar/compose.ts` — `stripEditorCursor`, `ansiColor` refactor
- `extensions/neo-bar/contract.ts` — `inputModeSet` / `inputModeClear` events
- `extensions/neo-bar/index.ts` — `isInputInactive` wiring on `FrameStatusEditor`

## Implementation status

- **Phase 1 (visual spike): implemented.**
  - `extensions/vim-mode/` — insert default; `Esc`/`Ctrl+;` → normal; `i`/`a` → insert;
    fullscreen detection via `isViewportTUI`; input-listener gate with
    `ui_prompt_*` / `hasOverlay` / lock guards; publishes `px:status-bar:input-mode:*`.
  - `extensions/neo-bar/` — `inputModeSet`/`inputModeClear` events; `FrameStatusEditor`
    dims the frame, keeps labels purple, shows `NORMAL`, and hides the cursor in normal mode.
  - Verified: both typecheck clean; `neo-bar` 201 tests pass.
- **Not yet:** `j`/`k` scrolling (Phase 2). In normal mode `j`/`k` currently do nothing.

---

## 1. Goal

Modal editing for pi's prompt editor, driven from the keyboard:

- **Insert mode** (default) is ordinary pi input.
- **Normal mode** holds plain keys back from the draft and uses them for
  reading/navigation.

Non-goals: a full vim emulation (registers, operators, `:commands`, visual
mode, text objects). Only modal input + transcript scrolling/jumping.

---

## 2. Decisions (resolved in review)

| Area | Decision |
| --- | --- |
| Default mode | **Insert** (not normal) |
| On submit | **Do not** switch mode automatically; stay in insert |
| Mode switch | Only the user switches, explicitly |
| `Esc` in insert | **Always** leaves insert → normal |
| `Esc` in normal | Passes to pi → **abort** |
| Leave-insert alias | `Ctrl+;` (Kitty-only; `Esc` is primary) |
| v1 keys | `j` `k` `J` `K` `Esc` `i` `a` |
| Next | `[`/`]` = every entry incl. tools · `{`/`}` = skip tools (user/assistant) · `h`/`l` = `{`/`}` |
| Later | `gg` `G` `3j` `5k` `$` = `G`, `0` = `gg` |
| Normal-mode look | Dim gray border, purple labels, `NORMAL` word, cursor hidden |
| Insert-mode look | **Exactly today** (no change) |
| Regular (non-fullscreen) mode | **Deactivate** vim-mode; warn once if possible |
| Input mechanism | TUI input listener (not editor replacement) |

---

## 3. UX

### 3.1 Modes

- Session starts in **insert**.
- `Esc` (insert) → **normal**. `Esc` (normal) → pi abort.
- `i` → insert (keep cursor). `a` → insert (append — exact semantics TBD; see
  §7).
- `/px:vim on | off | status` toggles for the session; no argument toggles.

### 3.2 Key map

**v1 (core):** `j`/`k` scroll 1 line · `J`/`K` scroll 5 lines · `Esc` abort ·
`i` insert · `a` append-insert.

**Next:** `[`/`]` step over **every** transcript entry (including tool calls);
`{`/`}` step only between **user and assistant** messages (skip tool calls);
`h`/`l` behave like `{`/`}`.

**Later:** `gg` top · `G` bottom · `3j`/`5k` counts · `$` = `G` · `0` = `gg`.

Everything with a modifier (`Ctrl+`, `Alt+`, `Super+`) always passes through to
pi so app hotkeys keep working.

### 3.3 Mode feedback (the point of the feature)

- **Insert:** unchanged from today.
- **Normal:** the whole frame shifts state —
  - frame lines / corners / tapered joins → **dark gray** (`theme.fg("dim")`),
  - frame label text → **purple** (the color normally used for the border),
  - a visible **`NORMAL`** word (purple) — do not rely on color alone,
  - hardware cursor + reverse-video cursor block **hidden**.
- Exact shades are provisional; implement as a one-line swap so they can be
  tuned live.
- Placement of the `NORMAL` word: recommended **bottom-right**, next to the
  unsent message size (`NORMAL 󰍡 1.2k`). Open to change.

### 3.4 Fullscreen requirement

- Transcript scrolling/jumping needs pi's `ScrollView`, which exists **only in
  fullscreen (alt-screen) mode**.
- pi's default `tuiMode` is **`regular`**; this project uses **`fullscreen`**.
- Detect with `isViewportTUI(tui)` (exported by `pi-tui`; fullscreen is the
  alt-screen "viewport" TUI).
- In regular mode: **deactivate** vim-mode (no mode toggle, no key
  suppression); warn once with a hint to enable fullscreen.

---

## 4. Architecture

### 4.1 Key routing

Install one TUI input listener (`tui.addInputListener`) that runs **before**
the focused component. Same mechanism `pi-ui` uses for lock mode. This composes
with `neo-bar`'s `FrameStatusEditor` and avoids fighting over
`ctx.ui.setEditorComponent`.

### 4.2 Gate conditions — hotkeys, permissions, dialogs must keep working

The listener returns early (pass everything through) when:

- an extension UI prompt is open — tracked via `ui_prompt_start` /
  `ui_prompt_end` (these fire for **every** `ctx.ui.select/confirm/input/editor/custom`,
  so permission approvals and safe-mode prompts are covered), **or**
- `tui.hasOverlay()` is true (built-in/extension overlays), **or**
- `pi-ui` lock mode is active — track via `px:pi-ui:lock-state`.

Otherwise:

- **insert:** pass everything except `Esc` / `Ctrl+;` (→ normal).
- **normal:** claim `i`/`a`/`j`/`k`/`J`/`K`; pass `Esc` and any modifier chord;
  consume the rest.

This keeps app hotkeys (modifiers), permission dialogs, and all dialogs working
in both modes.

### 4.3 neo-bar integration

- Publish mode on the existing contract:
  - `px:status-bar:input-mode:set` with `{ mode: "normal" | "insert" }`
  - `px:status-bar:input-mode:clear`
- `neo-bar` reacts by:
  - swapping the frame line color (keep a fixed **label** accent so labels stay
    purple while the border goes gray), and
  - rendering the `NORMAL` word,
  - hiding the cursor (strip `CURSOR_MARKER` + the reverse-video cursor) — but
    see §5.3 for the cleaner approach.

### 4.4 TUI capture and scroll helpers

- `pi-ui` already exports `captureTuiReference()` and
  `getTranscriptScrollView()`. Prefer reusing them over re-implementing (the
  stashed `scroll.ts` duplicated both).
- Capture the TUI once on `session_start` (and re-check on `session_tree`),
  remove the listener on `session_shutdown`. Keep install/teardown idempotent.

---

## 5. Known bugs and gaps in the stashed code

1. **No visible mode indicator.** Normal vs insert is invisible; only the
   cursor disappears. This is the headline failure.
2. **Cursor hiding is conditional.** Works only if `neo-bar` is installed
   **and** in `new` display mode. In `legacy` mode (plain editor) and with the
   extension absent, the cursor keeps blinking on a dead editor.
3. **Render-string hack.** `stripEditorCursor` post-processes another
   component's output with regexes on exact SGR sequences
   (`\x1b[7m…\x1b[0m` + `CURSOR_MARKER`). Any pi-tui rendering change silently
   breaks it. The editor should render "inactive" itself, driven by the mode.
   The regex also misses the single-line `Input` style, which ends reverse
   video with `\x1b[27m`.
4. **Duplicated coupling.** `vim-mode/scroll.ts` re-implements `pi-ui`'s TUI
   capture and scroll-view lookup, with its own global key and deeper tree walk.
5. **`Ctrl+;` is dead without Kitty.** `Esc` is the real exit; the warning is a
   band-aid.
6. **`J`/`K` may not fire without Kitty.** Shift is not distinguishable from a
   plain uppercase `J`/`K` in many terminals; the code only matches `"shift+j"`.
7. **Ctrl+C interrupt is a raw-ESC rewrite** (`{ data: "\x1b" }`), ambiguous
   with real Esc handling and key-release filtering.
8. **Fragile install.** Listener installed only on `session_start`; if the TUI
   is recreated, the gate can silently disappear.
9. **No regular-mode story.** Without alt-screen there is no scroll view, yet
   normal mode still suppresses keys.
10. **Sync fragility.** `setMode` early-returns when unchanged, so `neo-bar`
    depends on the explicit `session_start` emit.
11. Minor: merged `/**` doc comment above `render` in `neo-bar/index.ts`.

---

## 6. Implementation phases

**Phase 1 — visual spike (do first, before the rest):** minimal mode state
(insert default) + `Esc`/`i`/`a` gate + publish mode + `neo-bar` frame restyle
+ `NORMAL` word + cursor hide + fullscreen detection. Goal: confirm the mode
visual works before building navigation.

**Phase 2:** `j`/`k`/`J`/`K` transcript scrolling in fullscreen.

**Phase 3:** `[`/`]` and `{`/`}` / `h`/`l` entry jumping.

**Phase 4:** `gg`/`G`/counts/`$`/`0`.

---

## 7. Open questions

1. Exact `a` semantics: append **after the cursor** (vim `a`) vs **at end of
   text**. (Recommendation: after the cursor; `A`/end later.)
2. `NORMAL` word placement (bottom-right recommended) and exact shades — tune
   live during the Phase 1 spike.
3. `Esc` vs pi's autocomplete: in insert mode, `Esc` currently dismisses
   autocomplete. The gate would swallow it. Decide: pass `Esc` through when
   autocomplete is open, or accept Esc-twice.
4. Whether `neo-bar` should render an "inactive frame" itself (preferred) or
   keep any post-render cursor stripping.
