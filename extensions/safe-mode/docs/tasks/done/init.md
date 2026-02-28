# Safe Mode Extension – Design & Implementation Plan

## 1) Goal
Build a reusable pi extension named `safe-mode` that intercepts tool calls and applies configurable approval policies.

Modes:
- `paranoid`
- `reader`
- `smart`
- `yolo`

`yolo` should match default pi behavior (allow all).

---

## 2) Functional Requirements

### Mode behavior
1. **paranoid**
   - Every tool call requires explicit user confirmation.

2. **reader**
   - Auto-allow read-only operations.
   - Require user approval for everything else.

3. **smart**
   - Include everything from `reader`.
   - Also auto-allow `edit` and `write` when target path is inside project folder (`ctx.cwd`).
   - Require user approval for other operations.

4. **yolo**
   - Allow everything without confirmation.

### Core interception
- Enforce policy in `tool_call` event handler.
- Support built-in and unknown/custom tools.

### UX
- Clear confirmation prompts explaining **why** a call needs approval.
- Show active mode in footer status.

---

## 3) Proposed File Structure

- `extensions/safe-mode/index.ts`
  - Extension entrypoint
  - event handlers
  - commands/flags
  - state restore/persist

- `extensions/safe-mode/policy.ts`
  - mode decision engine
  - read-only and smart path checks
  - bash allowlist helpers

- `extensions/safe-mode/README.md`
  - install, usage, mode definitions, examples

- `extensions/safe-mode/docs/tasks/init.md`
  - this plan

---

## 4) Policy Engine Design

## Decision result
Use a normalized decision model:
- `allow`
- `confirm` (with reason)
- `block` (fail-safe scenarios)

## Read-only allowlist (reader + smart)
Auto-allow tools:
- `read`
- `ls`
- `find`
- `grep`

For `bash`, only auto-allow if command matches a read-only allowlist.

### Read-only bash allowlist (initial)
- File inspect: `cat`, `head`, `tail`, `less`, `more`
- Search/list: `grep`, `find`, `rg`, `fd`, `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`, `git show`
- Info: `whoami`, `id`, `date`, `uname`, `uptime`, `env`, `printenv`

If bash command is not allowlisted, require confirmation.

## Smart additions
In `smart`, auto-allow:
- `edit`
- `write`

Only when path resolves under project root (`ctx.cwd`).
Otherwise require confirmation.

---

## 5) Commands, Flags, and Persistence

## CLI flag
- `--safe-mode <paranoid|reader|smart|yolo>`
- Default: `yolo`

## Commands
- `/safe-mode` → show current mode
- `/safe-mode <mode>` → set mode
- Optional: `/safe-mode cycle`

## Persistence
- Save updates using `pi.appendEntry("safe-mode", { mode })`
- Restore latest state from current branch on `session_start`

## Status UI
- `ctx.ui.setStatus("safe-mode", "🛡 <mode>")`

---

## 6) Event Hooks

1. `session_start`
   - restore mode from persisted state
   - apply flag override if provided
   - refresh status

2. `tool_call`
   - run policy decision
   - auto-allow / confirm / block

3. `before_agent_start` (optional)
   - inject hidden context note about active mode to reduce unnecessary risky calls

---

## 7) Safety + Edge Cases

1. **No UI (`ctx.hasUI === false`)** and confirmation required
   - block fail-safe with reason: cannot prompt user

2. **Path normalization** for write/edit checks
   - strip leading `@` if present
   - resolve against `ctx.cwd`
   - verify path remains inside project root

3. **Unknown/custom tools**
   - `paranoid`: confirm
   - `reader`/`smart`: confirm
   - `yolo`: allow

4. **Ambiguous bash command chains** (`&&`, `;`, pipes)
   - default to confirm unless clearly safe by policy

---

## 8) Manual Acceptance Tests

1. `paranoid`
   - `read`, `bash`, `edit`, `write` all require confirmation.

2. `reader`
   - `read path` auto-allowed.
   - `bash "ls -la"` auto-allowed.
   - `bash "rm -rf tmp"` requires confirmation.
   - `write file` requires confirmation.

3. `smart`
   - `write src/a.ts` auto-allowed.
   - `edit ../outside.txt` requires confirmation.
   - `bash "git diff"` auto-allowed.
   - `bash "git commit -m x"` requires confirmation.

4. `yolo`
   - All tested calls execute without confirmation.

5. Non-interactive mode
   - Any operation that requires confirmation is blocked with explicit reason.

---

## 9) Implementation Checklist

- [x] Create `index.ts` with mode state, commands, flag, status
- [x] Create `policy.ts` with tool/boundary decision logic
- [x] Implement robust path normalization and inside-project checks
- [x] Implement bash allowlist matcher
- [x] Add confirmation dialog for `confirm` decisions
- [x] Add fail-safe block behavior when no UI is available
- [x] Persist mode changes and restore on session start
- [x] Add README usage and examples
- [ ] Run manual acceptance tests for all 4 modes
