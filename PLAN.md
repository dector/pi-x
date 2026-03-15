# PLAN: `extensions/safe-mode` outerAccess support

## Goal
Update safe-mode so `reader`, `smart`, and `yolo` are **repo-scoped by default** (`outerAccess = false`), and require confirmation for operations targeting paths outside `ctx.cwd`.

Add a mode modifier:
- `outerAccess = false` (default): mode auto-approval applies only inside repo; outside repo asks approval.
- `outerAccess = true`: mode auto-approval also applies outside repo.
- UI indicator: `!` suffix for non-paranoid modes when `outerAccess=true` (e.g. `[SMART!]`, `[YOLO!]`, `[READER!]`).
- `paranoid` remains behaviorally unchanged (always confirm), and UI stays `[PARANOID]`.

---

## Proposed implementation steps

### 1) Extend policy model (`extensions/safe-mode/policy.ts`)
- Add `outerAccess: boolean` parameter to `decideToolCall` input.
- Introduce path-scope gating for non-paranoid modes:
  - Determine whether a tool call targets outside project root.
  - If outside and `outerAccess=false` => force `confirm`.
  - If outside and `outerAccess=true` => evaluate by normal mode rules.
- Keep paranoid untouched (always confirm).
- Apply scope checks to tools currently handled by policy:
  - File tools (`read`, `write`, `edit`, `ls`, `grep`, `find`) by `input.path`.
  - `bash` using AST-derived command arguments to detect explicit path operands (best-effort conservative behavior).
    - If any detected path is outside root and `outerAccess=false` => confirm.
    - If path cannot be confidently resolved, stay conservative where needed.

### 2) State + persistence changes (`extensions/safe-mode/index.ts`)
- Extend persisted state from `{ mode }` to `{ mode, outerAccess }` (backward compatible with old entries).
- Add in-memory `outerAccess` variable defaulting to `false`.
- Restore both values from history/flags on session start/tree/fork.

### 3) CLI/command UX
- Keep existing `/safe-mode` behavior, extend to support modifier toggling.
- Proposed command support:
  - `/safe-mode` -> show current mode + outerAccess
  - `/safe-mode <mode>` -> set mode, keep outerAccess
  - `/safe-mode cycle` -> cycle mode, keep outerAccess
  - `/safe-mode outer on|off|toggle` -> control modifier
- Add optional flag:
  - `--safe-mode-outer-access <true|false>` (default `false`)
- Validate invalid values with warnings, similar to current `--safe-mode` handling.

### 4) Status bar rendering
- Update style formatter:
  - `paranoid`: always `[PARANOID]`
  - other modes:
    - `outerAccess=false` -> `[MODE]`
    - `outerAccess=true` -> `[MODE!]`

### 5) README updates (`extensions/safe-mode/README.md`)
- Document new modifier semantics and default.
- Document new command usage and new CLI flag.
- Add explicit examples for inside/outside repo behavior.

### 6) Tests (`extensions/safe-mode/policy.test.ts`)
Add/adjust tests for:
- Default repo-scoped behavior (`outerAccess=false`):
  - reader/smart/yolo allow inside repo according to mode
  - outside-repo calls require confirm
- `outerAccess=true`:
  - reader/smart/yolo apply full mode rules outside repo
- paranoid unaffected
- Status/command parsing tests (if unit-testable via pure helpers; otherwise cover policy-level matrix comprehensively)
- Backward compatibility in persisted data parsing (if extracted helper can be tested)

---

## Test matrix (policy-level)

### Reader
- `read: policy.ts` (inside) -> allow (`outerAccess=false/true`)
- `read: /tmp/x.txt` (outside) -> confirm (`false`), allow (`true`)
- `bash: ls -la` (no explicit outside path) -> allow in mode rules
- `bash: cat /tmp/x.txt` -> confirm (`false`), allow (`true`)

### Smart
- `write: new-file.ts` (inside) -> allow
- `write: /tmp/outside.txt` -> confirm (`false`), allow (`true`)
- `edit: ../escape.ts` -> confirm (`false`), allow (`true`)

### Yolo
- `bash: rm -rf /tmp/x` -> confirm (`false` if outside targeted), allow (`true`)
- `read/write` outside path -> confirm (`false`), allow (`true`)

### Paranoid
- Any command -> confirm regardless of `outerAccess`

---

## Open questions to confirm before coding (answered)
1. **Command syntax preference**: `/safe-mode outer on|off|toggle`
2. **Flag naming**: OK to introduce `--safe-mode-outer-access`?
3. **`yolo` + outside access**: With `outerAccess=false`, should *all* outside-targeting operations require confirm (including destructive bash), as written in this plan? yes, yolo - works only for current repo, yolo! - for everything
4. **Bash outside detection strictness**: For shell commands where path intent is ambiguous, should we be conservative and require confirmation, or only enforce on clearly detected outside paths? Be conservative for now, later we will try to detect actual impact area
