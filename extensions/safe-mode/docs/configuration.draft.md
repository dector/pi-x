# Safe-mode configuration matrix (draft)

## Goal

Move from hardcoded modes (`paranoid`, `reader`, `smart`, `yolo`) to **user-defined modes** stored in an HJSON config file.

Each mode should define a policy matrix:
- classify operation (tool + operation type)
- classify scope/target (project/home/outside)
- decide reaction (`allow`, `confirm`, `block`)

---

## Why matrix-based config

Current behavior is good but fixed. A matrix gives:
- custom trust profiles per user/project
- explicit policy instead of implicit branching in code
- easier auditing (“why was this allowed?”)
- future extensibility (network ops, env access, package manager controls)

---

## Core concepts

## 1) Operation dimensions

Every tool call gets normalized into dimensions:

- `tool`: `read`, `write`, `edit`, `bash`, `grep`, ...
- `opKind`: semantic class, e.g.
  - `read`
  - `write`
  - `execute`
  - `unknown`
- `targetScope`:
  - `project` (inside `ctx.cwd`)
  - `home` (inside `$HOME` but outside project)
  - `external` (outside both project and home)
  - `mixed` (multiple targets crossing scopes)
  - `none` (no path-like target)
- `bashKind` (for bash only):
  - `readOnly`
  - `writeLike`
  - `mixed`
  - `unknown`
- optional risk flags:
  - `hasRedirection`
  - `hasSubstitution`
  - `hasSudo`
  - `hasNetworkLikeCmd`
  - `hasDynamicArgs`

## 2) Decision values

Per rule decision:
- `allow`
- `confirm`
- `block`

Optional future decisions:
- `allowAndRememberSession`
- `allowAndRememberProject`

## 3) Matching strategy

Rules are evaluated in priority order:
1. first matching rule wins
2. if nothing matches → `defaultDecision` (recommended: `confirm`)

This keeps behavior deterministic and debuggable.

---

## Proposed config file location

- Project-local: `<repo>/.pi/safe-mode.hjson`
- Global fallback: `~/.pi/agent/extensions/safe-mode/config.hjson`

Resolution order:
1. CLI-selected mode (if given)
2. project config mode
3. global default mode
4. built-in `smart`

---

## HJSON structure (draft)

```hjson
{
  version: 1

  defaults: {
    mode: smart
    onNoMatch: confirm
  }

  // reusable selectors
  groups: {
    tools: {
      readTools: [read, ls, grep]
      writeTools: [write, edit]
    }
    bashCommands: {
      readOnly: [cat, head, tail, less, more, grep, rg, fd, ls, pwd, find, git:status, git:log, git:diff]
      writeLike: [rm, mv, cp, mkdir, touch, chmod, chown, git:add, git:commit, git:push]
    }
  }

  modes: {
    paranoid: {
      description: "Always ask"
      defaultDecision: confirm
      rules: [
        { when: { any: true }, decision: confirm }
      ]
    }

    reader: {
      defaultDecision: confirm
      rules: [
        { when: { toolInGroup: readTools, targetScopeIn: [project] }, decision: allow },
        { when: { tool: bash, bashKind: readOnly, targetScopeIn: [project] }, decision: allow }
      ]
    }

    smart: {
      defaultDecision: confirm
      rules: [
        { when: { toolInGroup: readTools, targetScopeIn: [project, home] }, decision: allow },
        { when: { toolInGroup: writeTools, targetScopeIn: [project] }, decision: allow },
        { when: { tool: bash, bashKind: readOnly, targetScopeIn: [project, home] }, decision: allow }
      ]
    }

    yolo: {
      defaultDecision: allow
      rules: [
        { when: { targetScopeIn: [external], opKindIn: [write] }, decision: confirm }
      ]
    }

    // custom user mode example
    devSafe: {
      defaultDecision: confirm
      rules: [
        { when: { toolInGroup: readTools, targetScopeIn: [project, home] }, decision: allow },
        { when: { toolInGroup: writeTools, targetScopeIn: [project] }, decision: allow },
        { when: { tool: bash, bashKind: readOnly, targetScopeIn: [project, home] }, decision: allow },
        { when: { tool: bash, hasSudo: true }, decision: block },
        { when: { tool: bash, hasRedirection: true, bashKindIn: [writeLike, mixed] }, decision: confirm }
      ]
    }
  }
}
```

---

## Scope model details

To address your idea directly (cwd/home/outside):

- project scope: `resolve(target)` under `ctx.cwd`
- home scope: under `homedir()` but not under project
- external scope: everything else

For commands with multiple paths (especially bash):
- if all targets in same scope → that scope
- if different scopes involved → `mixed`

Safe default for `mixed`: `confirm`.

---

## Bash granularity proposal

Keep AST parsing and classify bash with stricter buckets:

- `readOnly`
  - only read-only commands/subcommands
  - no write-like flags (`find -delete`, `git branch -D`, etc.)
  - no unsafe dynamic constructs unless explicitly allowed
- `writeLike`
  - any known mutating command or mutating flag
- `mixed`
  - chains where some segments read and some write
- `unknown`
  - parse failure or unsupported/ambiguous command

Recommended defaults:
- `readOnly` → can be auto-allowed by selected modes
- `writeLike` / `mixed` / `unknown` → `confirm` (or `block` in strict modes)

---

## Rule language sketch

Minimal matcher operators:
- exact: `tool: bash`, `bashKind: readOnly`
- set inclusion: `targetScopeIn: [project, home]`
- group ref: `toolInGroup: readTools`
- booleans: `hasSudo: true`
- catch-all: `{ any: true }`

Optional later:
- `not`, `all`, `any` combinators
- `pathMatches` glob/regex
- `commandMatches` regex (careful: risky if overused)

---

## UX notes

- `/safe modes` → list available configured modes
- `/safe <mode>` still works for custom modes
- show effective source in status/help:
  - built-in vs project config vs global config
- add dry-run diagnostics command:
  - `/safe explain <tool> <json-input>`
  - returns matched rule and decision

---

## Implementation plan (phased)

1. **Add config loader** (HJSON parse + validation)
2. **Build normalized context** for each tool call (`tool`, `opKind`, `scope`, `bashKind`, flags)
3. **Implement matrix evaluator** (ordered rule matching)
4. **Express built-in modes in config shape** (internal defaults)
5. **Enable project/global override files**
6. **Add diagnostics (`/safe modes`, `/safe explain`)**

---

## Open questions

- Should `home` be treated as trusted or semi-trusted by default?
- Should unknown bash be `confirm` or `block` in strict modes?
- Do we want a separate `network` opKind (curl/wget/ssh/scp/git push)?
- Should per-rule decisions support “allow once only” semantics?
- Should rule matching be first-match or highest-priority numeric score?

---

## Recommendation

Start with a **small, strict matrix DSL**:
- first-match rules
- decisions: `allow | confirm | block`
- dimensions: `tool`, `targetScope`, `bashKind`, risk flags

Then expand only when real use-cases appear. This keeps safe-mode understandable and prevents policy complexity from becoming a new risk surface.
