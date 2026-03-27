# Safe-Mode Feature Plan (Partial): Matcher Registry Refactor + Test Expansion

## Scope of this plan
This is a **partial plan** focused on two milestones only:
1. Refactor bash command validation into an interface-based matcher registry/tree.
2. Expand matcher tests significantly (including `sed` safe/unsafe variants).

It intentionally does **not** cover full feature rollout or UI changes.

---

## Core policy principle (must stay true)
We should design rules from a **default-deny/confirm posture**:
- Anything not explicitly proven safe must require confirmation.
- Parser ambiguity, unknown syntax, unknown commands, or uncertain semantics => `confirm`.
- Especially for `sed`, treat write-capable forms as unsafe unless explicitly validated.

---

## Milestone 1 — Command-policy registry refactor (high-design-quality milestone)

### Goals
- Build a **very strong, extensible design** for bash command validation.
- Keep a **single entry point** for command validation so callers do not depend on internals.
- Support a matcher tree/registry that can evolve toward plugin-in matchers.
- Allow different matcher compositions by safe-mode (`reader`, `smart`, future strict profiles).

### Architectural requirement: two matcher layers

#### Layer A: Parse/analysis layer (AST construction)
Responsibilities:
- Parse raw bash into AST once.
- Build normalized analysis context (parse status, command nodes, flags, redirections, substitutions, paths, etc.).
- Never make final policy decisions.

Outputs should be reusable by decision layer and tests.

#### Layer B: Decision layer (policy via matcher tree)
Responsibilities:
- Apply matchers to AST or AST-derived facts.
- Produce final policy outcome (`allow`/`confirm`/`block`) with explicit reasons.
- Enforce default-confirm for unclassified or ambiguous cases.

### Design direction
- Introduce interface-based matchers (command matchers + structural matchers).
- Allow composing matchers into a tree/pipeline with deterministic priority.
- Keep all external callers behind one entry function (e.g. `validateBashCommand(...)`), used by `decideToolCall`.
- Separate "facts extraction" from "policy decisions" for maintainability and future plugins.

### Suggested deliverables
1. New matcher interfaces and matcher-registry module.
2. Migration of current classification logic (`git`, `find`, package managers, read/write commands) into matcher implementations.
3. Mode-specific matcher composition (at least `reader` baseline; `smart` reuses reader matcher set).
4. Stable single entry point preserved in `policy.ts` integration.
5. Decision reasons improved/structured for debugging and tests.

### Acceptance criteria
- No behavioral regressions for existing tests.
- Single command parse per validation path.
- Registry supports adding new command matchers without editing core decision flow.
- Unknown/ambiguous cases still resolve to `confirm`.

---

## Milestone 2 — Expand matcher test suite significantly

### Goals
- Validate matcher behavior across many command combinations.
- Cover both parsing layer and decision layer.
- Add targeted `sed` cases with strict safety posture.

### Test strategy
- Prefer table-driven tests for breadth and readability.
- Add matrix-style tests across:
  - command type (read-only / write-like / unknown),
  - shell structure (`plain`, `|`, `&&`, `||`, `;`, newline),
  - mode (`reader`, `smart` where relevant),
  - target scope (inside project vs outside).

### Required `sed` coverage (explicit)
Add tests for at least:
- Read-only intent examples (candidate allow, if matcher rules permit):
  - `sed -n '1,220p' file`
  - `git diff -- file | sed -n '1,220p'`
- Unsafe/write-capable examples (must confirm):
  - `sed -i 's/a/b/' file`
  - `sed --in-place 's/a/b/' file`
  - `... | sed -i ...`
- Ambiguous/dynamic forms should default to `confirm`.

### Safety expectation
- Define **unsafe patterns first**, then allowlist safe patterns.
- Ensure no test accidentally treats write-capable `sed` forms as auto-allow.

### Acceptance criteria
- Existing tests remain green.
- New suite covers broad combinations and edge cases.
- `sed` behavior is conservative by default.
- Any unhandled command pattern remains `confirm`.

---

## Notes for implementation discipline
- Prioritize correctness and explainability over permissiveness.
- Keep public policy API stable while refactoring internals.
- Prefer explicit matcher contracts over ad-hoc condition chains.
