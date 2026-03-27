# Safe-Mode Matcher Registry Refactor — Milestone 1 Detailed Technical Plan

## Purpose
This document expands **Milestone 1** from `docs/tasks/matcher-registry-refactor-plan.md` into an implementation-ready technical plan.

Milestone 1 is a **design-quality refactor milestone**. The goal is not to broaden policy permissiveness. The goal is to:
- preserve current behavior,
- centralize bash analysis behind a clean API,
- separate AST/fact extraction from policy decisions,
- replace ad-hoc command classification flow with an extensible matcher registry,
- make future additions like `sed` and plugin-style matchers straightforward.

The design must remain faithful to the safe-mode policy principle:
- **default deny / default confirm**,
- unknown or ambiguous constructs must not auto-allow,
- parser uncertainty must degrade to `confirm`.

---

## 1. Current-state assessment

## What exists today
`extensions/safe-mode/policy.ts` currently contains all of the following in one file:
- safe-mode enum/types,
- top-level `decideToolCall(...)`,
- tool/path scope checks,
- bash parsing via `bash-parser`,
- AST traversal,
- command classification logic,
- command-specific special cases (`find`, `git`, package managers, `command -v`),
- path extraction from AST for outside-project checks,
- summary classification via `getBashCommandType(...)`.

## What is already good
The current implementation has several strengths worth preserving:
- conservative behavior,
- AST-based shell parsing,
- support for composed read-only commands,
- single external policy entry point for callers (`decideToolCall`),
- explicit read-only vs mutating classification helpers,
- test coverage for current behavior.

## Main design problems to fix in Milestone 1

### 1.1 Policy and analysis are mixed together
The current code performs parsing, AST walking, fact extraction, and policy classification inside the same execution path. This makes it hard to:
- reuse parse results,
- add richer diagnostics,
- test extraction and decision logic independently,
- evolve toward mode-specific policy profiles.

### 1.2 Command policy is centralized in condition chains
`classifyCommand(...)` and `needsCommandApproval(...)` encode command policy as monolithic branching logic. This creates friction when adding new commands because new behavior requires editing a shared decision function instead of registering a new matcher.

### 1.3 The AST is traversed for different purposes with duplicated concerns
Today there are multiple AST-oriented helpers:
- `analyzeBashCommand(...)` / `evaluateAstNode(...)`,
- `collectPathCandidatesFromAst(...)`,
- nested expansion evaluation,
- single-command/plain-command detection.

These are related, but not represented as a single reusable analysis context.

### 1.4 Default-confirm behavior is implicit, not modeled directly
The current code arrives at conservative outcomes through a mix of:
- `hasUnknownCommand`,
- `requiresApproval`,
- parse checks,
- redirection/substitution checks,
- command-level special cases.

That works, but it is harder to reason about than an explicit registry result model with a final fallback matcher.

### 1.5 `bash-parser` typing uncertainty leaks through the whole file
Because `bash-parser` does not ship strong TS types, `any` is used broadly. We should isolate parser/AST uncertainty to a small adapter/analyzer boundary and keep the decision layer strongly typed.

---

## 2. Milestone 1 scope

## In scope
1. Introduce a reusable **bash analysis context** built from one parse.
2. Introduce matcher interfaces and a deterministic matcher registry.
3. Migrate current bash command classification rules into matcher implementations.
4. Support matcher composition by safe-mode profile:
   - `reader`
   - `smart` (initially same matcher set as `reader`)
5. Preserve a single public validation entry point used by `policy.ts`.
6. Improve structured reasons/diagnostics.
7. Avoid behavior regressions.

## Explicitly out of scope
1. Widening policy permissiveness.
2. UI changes.
3. Full plugin loading from external packages.
4. Milestone 2 test expansion breadth.
5. Large rewrite of non-bash tool policy outside necessary integration glue.

---

## 3. End-state architecture

Milestone 1 should introduce two clear layers.

## Layer A — Parse / analysis layer
This layer:
- parses bash once,
- walks the AST once,
- extracts normalized facts,
- never decides `allow` vs `confirm` directly.

It should output a typed, reusable analysis object.

## Layer B — Decision / matcher layer
This layer:
- receives the analysis object,
- applies structural and command matchers in deterministic order,
- produces a final policy decision plus structured reasons,
- applies an explicit final default-confirm fallback.

---

## 4. Proposed file/module layout

Create a small internal module tree under `extensions/safe-mode/`.

```text
extensions/safe-mode/
  policy.ts                         # existing public integration point remains
  bash-policy/
    analyze.ts                      # parse + AST walk + normalized fact extraction
    types.ts                        # shared internal types
    validate.ts                     # single validation entry point for bash policy
    registry.ts                     # matcher registry + runner
    profiles.ts                     # mode-specific matcher composition
    reasons.ts                      # reason codes / message helpers
    matchers/
      structural/
        parse-error.ts
        redirections.ts
        substitutions.ts
        unknown-command.ts
        default-confirm.ts
      command/
        builtin-command.ts          # command -v / command -V handling
        read-only-command.ts        # cat, ls, grep, etc.
        write-command.ts            # rm, mv, cp, etc.
        find.ts
        git.ts
        package-manager.ts
    shared/
      command-lists.ts              # read/write command tables, subcommand sets
      normalization.ts              # executable/subcommand normalization helpers
```

### Why this layout
- `policy.ts` remains the stable integration boundary for the extension.
- `bash-policy/` contains internal policy-specific building blocks.
- structural matchers and command matchers are physically separate.
- shared tables/helpers are centralized, avoiding duplication.
- future `sed` work has an obvious home (`matchers/command/sed.ts`).

---

## 5. Core type design

The most important design decision is to make the analysis object rich enough that decision code rarely needs raw AST access.

## 5.1 Analysis-layer types

```ts
type BashAnalysis = {
  source: string;
  trimmedSource: string;
  parse: BashParseStatus;
  ast?: unknown;

  commandCount: number;
  commands: readonly AnalyzedCommand[];
  paths: readonly string[];

  structure: BashStructureFacts;
  aggregate: BashAggregateFacts;
};

type BashParseStatus =
  | { ok: true }
  | { ok: false; kind: "empty" | "line-continuation" | "parse-error" };

type BashStructureFacts = {
  hasPipe: boolean;
  hasOtherControlFlow: boolean;
  hasInputRedirection: boolean;
  hasOutputRedirection: boolean;
  hasSubstitution: boolean;
  isPlainCommand: boolean;
};

type BashAggregateFacts = {
  hasReads: boolean;
  hasWrites: boolean;
  hasUnknownCommand: boolean;
  hasDynamicArguments: boolean;
};

type AnalyzedCommand = {
  index: number;
  programRaw: string;
  program: string;
  args: readonly string[];
  hasDynamicName: boolean;
  hasDynamicArgs: boolean;
  hasAnyExpansion: boolean;
  redirects: readonly AnalyzedRedirect[];
  sourceKind: "top-level" | "command-substitution";
};

type AnalyzedRedirect = {
  operator: string;
  fileText?: string;
  direction: "input" | "output" | "other";
  hasExpansion: boolean;
};
```

### Notes
- `ast` may remain `unknown` or an internal untyped shape, but only inside the analyzer boundary.
- `commands` should be normalized enough that most matchers only inspect `program`, `args`, and dynamic flags.
- `paths` should include path-like candidates extracted during analysis so path-scope checks can reuse the same analysis later.
- `sourceKind` makes nested command substitutions visible to diagnostics without forcing matchers to navigate the AST.

## 5.2 Decision-layer types

```ts
type BashPolicyAction = "allow" | "confirm" | "block";

type BashPolicyDecision = {
  action: BashPolicyAction;
  reasons: readonly BashDecisionReason[];
  matchedBy: readonly string[];
  analysis: BashAnalysis;
};

type BashDecisionReason = {
  code: BashReasonCode;
  message: string;
  matcherId: string;
  commandIndex?: number;
  program?: string;
  detail?: string;
};

type BashReasonCode =
  | "empty-command"
  | "parse-error"
  | "line-continuation"
  | "input-redirection"
  | "output-redirection"
  | "command-substitution"
  | "unknown-command"
  | "dynamic-arguments"
  | "read-only-command"
  | "write-command"
  | "find-write-like-flag"
  | "git-read-subcommand"
  | "git-write-subcommand"
  | "package-manager-write-subcommand"
  | "command-builtin-read"
  | "fallback-confirm";
```

### Important rule
`BashPolicyDecision.reasons` must be structured data first, human text second.
Human-readable strings should be generated from reason codes and facts rather than being hand-built everywhere.

## 5.3 Matcher interfaces

```ts
type BashMatcherResult = {
  matched: boolean;
  action?: BashPolicyAction;
  reasons?: readonly BashDecisionReason[];
};

interface BashMatcher {
  id: string;
  priority: number;
  applies(ctx: BashMatcherContext): boolean;
  evaluate(ctx: BashMatcherContext): BashMatcherResult;
}

type BashMatcherContext = {
  modeProfile: BashModeProfile;
  analysis: BashAnalysis;
};

type BashModeProfile = {
  id: "reader" | "smart";
  matchers: readonly BashMatcher[];
};
```

### Design conventions
- `applies(...)` must be cheap and side-effect free.
- `evaluate(...)` must be deterministic and side-effect free.
- matchers must not parse or traverse the AST.
- matchers should prefer normalized facts over raw strings.
- a matcher can return `matched: true` with `action: undefined` only if we intentionally support informational/non-terminal matchers; for Milestone 1, prefer terminal behavior for clarity.

---

## 6. Decision model and registry behavior

Milestone 1 should use a simple deterministic registry runner.

## 6.1 Registry order
Registry evaluation should be ordered by explicit priority, not declaration order by accident.

Recommended order:
1. structural-deny/confirm matchers,
2. command-specific write/unsafe matchers,
3. command-specific allow matchers,
4. fallback confirm matcher.

This keeps policy conservative and easy to read.

## 6.2 First-match-wins vs aggregate
Use **first terminal match wins** for Milestone 1.

Why:
- simpler to reason about,
- matches default-confirm posture well,
- easier migration from current condition-based logic,
- avoids complicated score/merge semantics too early.

To preserve diagnostics quality, the chosen matcher should still emit structured reasons.

## 6.3 Fallback behavior
Every mode profile must end with a `default-confirm` matcher:
- it always applies,
- it returns `confirm`,
- its reason code is `fallback-confirm`.

This makes the conservative default explicit and testable.

---

## 7. Parse/analysis layer design

## 7.1 Public analysis entry point
Introduce one internal function:

```ts
function analyzeBash(source: string): BashAnalysis
```

Responsibilities:
- trim source,
- detect empty command,
- reject trailing `\` line continuation as parser-uncertain,
- call `bash-parser` once,
- walk AST once,
- build normalized facts,
- compute aggregate summaries.

## 7.2 Analyzer implementation strategy
Keep parser-specific `any` handling inside `analyze.ts` only.

Suggested internal decomposition:

```ts
function analyzeBash(source: string): BashAnalysis
function visitNode(node: unknown, state: MutableAnalysisState, sourceKind: SourceKind): void
function visitCommandNode(node: unknown, state: MutableAnalysisState, sourceKind: SourceKind): void
function extractCommand(node: unknown, sourceKind: SourceKind, index: number): AnalyzedCommand | undefined
function collectRedirects(node: unknown): AnalyzedRedirect[]
function collectPathCandidates(node: unknown, command?: AnalyzedCommand): void
function finalizeAnalysis(state: MutableAnalysisState): BashAnalysis
```

## 7.3 Analyzer output rules

### Parse outcomes
- empty input => parse status `empty`
- trailing `\` => parse status `line-continuation`
- parser exception => parse status `parse-error`
- success => parse status `ok`

### Structural facts
Computed during traversal:
- any `Pipeline` => `hasPipe = true`
- any `LogicalExpression`, multiple script commands, `Subshell`, loop, function, etc. => `hasOtherControlFlow = true`
- redirect operators with `>` => `hasOutputRedirection = true`
- redirect operators with `<` => `hasInputRedirection = true`
- any expansion => `hasSubstitution = true`
- `isPlainCommand` computed after traversal from structure + command count

### Aggregate facts
Derived from command-level matcher-independent summaries, not policy decisions:
- whether any command is clearly read-like,
- whether any command is clearly write-like,
- whether any command is unknown,
- whether any command contains dynamic args.

Important: aggregate facts are descriptive, not normative.

## 7.4 Command-level normalization
For each command:
- extract executable name from `node.name.text`,
- normalize executable using current `normalizeExecutable(...)` semantics,
- extract suffix words to arg text list,
- preserve `hasDynamicName`, `hasDynamicArgs`, `hasAnyExpansion`,
- record redirects in normalized form.

No policy classification should happen here.

## 7.5 Path extraction reuse
The analyzer should collect path-like candidate strings while already traversing commands and redirect files.
That gives two benefits:
1. milestone goal of reusable analysis output,
2. future cleanup path for `bashTargetsOutsideProject(...)` and trusted-root checks.

Even if `policy.ts` does not fully switch path checks in the first commit, the analysis object should include `paths` now so the capability exists.

---

## 8. Matcher design

Milestone 1 needs two matcher categories.

## 8.1 Structural matchers
These operate on analysis-wide facts and should run before command matchers.

### `parse-error` matcher
Triggers when `analysis.parse.ok === false`.
- action: `confirm`
- reason: parse failure / uncertainty

### `redirections` matcher
Triggers when:
- `hasInputRedirection`, or
- `hasOutputRedirection`

Initial migration rule should preserve current behavior:
- both input and output redirections => `confirm`

Note: even if input redirection is conceptually read-like, current behavior treats it as non-auto-allow. Milestone 1 should preserve that.

### `substitutions` matcher
Triggers when `hasSubstitution === true`.
- action: `confirm`

This preserves current conservative handling of `$()` and backticks.

### `unknown-command` matcher
Triggers when any analyzed command cannot be classified by any allow/write command matcher and the command set is not otherwise explicitly recognized.
- action: `confirm`

### `default-confirm` matcher
Always matches last.
- action: `confirm`

## 8.2 Command matchers
These classify commands or groups of commands.

### `find` matcher
Purpose:
- preserve the current `find` special case,
- keep write-like `find` forms from being auto-allowed.

Rules:
- if program !== `find`, not applicable
- if any arg is one of current write-like flags (`-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`) => confirm
- if command has dynamic args => confirm
- otherwise classify as read-only candidate

### `builtin-command` matcher
Purpose:
- handle `command -v`, `command -V`, with optional `-p`.

Rules migrate directly from current `isReadOnlyCommandBuiltinArgs(...)`.

### `read-only-command` matcher
Purpose:
- classify simple allowlisted read-only executables.

Backed by a shared set migrated from `READ_ONLY_BASH_COMMANDS`.

### `write-command` matcher
Purpose:
- classify obvious mutating executables.

Backed by a shared set migrated from `WRITE_BASH_COMMANDS`.

### `git` matcher
Purpose:
- move all git-specific branching into an isolated matcher.

Rules:
- read-only subcommands from current `READ_ONLY_GIT_SUBCOMMANDS`
- write subcommands from current `WRITE_GIT_SUBCOMMANDS`
- `git branch` special-case with mutation flags from current `hasGitBranchMutationArg(...)`
- unknown git subcommand => no allow, later fallback confirm

### `package-manager` matcher
Purpose:
- preserve current npm/yarn/pnpm/pip/bun write classification.

Important behavior to preserve:
- known write subcommand => write-like
- unknown package manager subcommand (e.g. `bun test`) => not auto-allowed

## 8.3 How command matchers interact with multi-command analysis
Milestone 1 should support composed commands by evaluating command matchers across **all analyzed commands**.

Recommended helper inside `validate.ts`:

```ts
function classifyAnalyzedCommands(analysis: BashAnalysis): CommandClassificationSummary
```

Example summary shape:

```ts
type CommandClassificationSummary = {
  allRecognized: boolean;
  anyWriteLike: boolean;
  anyDynamic: boolean;
  allReadOnly: boolean;
  details: readonly CommandClassification[];
};
```

Where each `CommandClassification` is derived by applying command matchers to one `AnalyzedCommand`.

This allows structural matchers to remain analysis-wide while command matchers remain command-focused.

### Important detail
The registry runner for the top-level validation can still be first-match-wins, while command classification internally may evaluate command matcher lists per command. That is acceptable and keeps responsibilities clean.

---

## 9. Validation entry point design

Introduce one internal entry point:

```ts
function validateBashCommand(args: {
  command: string;
  profile: "reader" | "smart";
}): BashPolicyDecision
```

Responsibilities:
1. call `analyzeBash(...)`,
2. build matcher context,
3. run profile registry,
4. return structured decision.

## 9.1 Initial profile behavior
For Milestone 1:
- `reader` and `smart` should use the same bash matcher profile.
- keep profile composition infrastructure even if the matcher lists are initially identical.

This satisfies the milestone requirement that different safe-modes can compose matchers differently later, without forcing unnecessary behavior divergence now.

## 9.2 Integration with existing public APIs

### `decideToolCall(...)`
Keep as the public top-level tool policy entry point.
For bash tools:
- call `validateBashCommand({ command, profile })`,
- map `allow`/`confirm` into existing `ToolDecision`,
- include best reason message in `ToolDecision.reason`.

### `getBashCommandType(...)`
Refactor to derive its result from the analysis output and command classification summary, not from duplicated command parsing logic.

### Future cleanup opportunity
`bashTargetsOutsideProject(...)` and `bashHasOnlyTrustedOutsideTargets(...)` can later reuse `analyzeBash(...)` output or a shared helper that builds analysis once. If feasible without introducing risk, do it in Milestone 1 because it further reinforces single-parse architecture.

---

## 10. Structured reasons and diagnostics

Milestone 1 should improve reason quality enough for debugging and tests.

## 10.1 Reason generation rules
- Every non-allow decision should carry at least one reason.
- The first reason should explain the terminal decision.
- Reasons should include matcher ID.
- Command-specific reasons should include `commandIndex` and `program` where available.

## 10.2 Human-readable reason examples
Examples of final `ToolDecision.reason` strings assembled from structured reasons:
- `Bash command could not be parsed safely.`
- `Bash command uses shell redirection and requires approval.`
- `Bash command contains substitutions and requires approval.`
- `Bash command includes unknown or unclassified commands.`
- `find includes write-capable flags and requires approval.`
- `Bash command is read-only and matches the reader profile.`

## 10.3 Why this matters
This directly improves:
- test clarity,
- future debug logging,
- approval prompt reasoning,
- maintainability when new matchers are added.

---

## 11. Migration plan

Refactor in small reviewable steps. Do not attempt a single giant rewrite.

## Step 1 — Introduce shared types and tables
Create:
- `bash-policy/types.ts`
- `bash-policy/shared/command-lists.ts`
- `bash-policy/shared/normalization.ts`

Move these without behavior change:
- read-only command set,
- write command set,
- git subcommand sets,
- package manager write subcommands,
- executable normalization,
- subcommand normalization,
- `hasGitBranchMutationArg(...)`,
- `isReadOnlyCommandBuiltinArgs(...)`,
- `hasFindWriteLikeArgs(...)`.

Goal:
- shrink `policy.ts`,
- isolate reusable rule tables.

## Step 2 — Introduce analysis layer
Create `bash-policy/analyze.ts` and move parsing/traversal there.

Port current logic from:
- `analyzeBashCommand(...)`
- `evaluateAstNode(...)`
- `evaluateCommandNode(...)`
- `extractAstCommand(...)`
- command word / redirect helpers
- path collection helpers
- `isSinglePlainCommand(...)`

Goal:
- one cohesive analyzer API,
- no decision-making in analyzer.

## Step 3 — Add command classification helper layer
Before full registry, introduce a command-focused helper that classifies each `AnalyzedCommand` using shared tables.
This is a transitional step that lowers risk.

Example files:
- `bash-policy/classify-command.ts` or inside `validate.ts`

Goal:
- establish per-command classification separate from AST traversal,
- make later matcher extraction trivial.

## Step 4 — Introduce matcher interfaces and registry runner
Create:
- `bash-policy/registry.ts`
- `bash-policy/reasons.ts`

Implement:
- matcher interface,
- sorted registry runner,
- fallback matcher behavior,
- reason helpers.

Goal:
- decision flow becomes data-driven rather than a condition chain.

## Step 5 — Implement structural matchers
Create structural matchers first because they encode the conservative guardrails:
- parse error,
- redirections,
- substitutions,
- unknown/unclassified command summary,
- fallback confirm.

Goal:
- preserve safety posture before command allow logic is introduced.

## Step 6 — Implement command matchers
Create command matcher modules and port existing logic:
- `find`
- `builtin-command`
- `read-only-command`
- `write-command`
- `git`
- `package-manager`

Goal:
- each command family becomes independently testable and extensible.

## Step 7 — Compose profiles
Create `bash-policy/profiles.ts`.

Initial composition:
- `readerProfile`
- `smartProfile` (same matcher list as reader for bash)

Goal:
- future-proof architecture for profile divergence.

## Step 8 — Integrate back into `policy.ts`
Update only the bash-specific paths in `policy.ts` to use:
- `validateBashCommand(...)`
- `analyzeBash(...)`-derived summaries where appropriate

Keep the external functions stable:
- `decideToolCall(...)`
- `getBashCommandType(...)`

Goal:
- no caller impact.

## Step 9 — Cleanup and remove dead logic
After tests pass, remove obsolete helpers from `policy.ts` that are now owned by `bash-policy/`.

Goal:
- one source of truth,
- no shadow classification logic.

---

## 12. Minimal test plan for Milestone 1

Milestone 2 is the big test expansion, but Milestone 1 still needs a targeted safety net.

## 12.1 Required regression tests
Existing `policy.test.ts` must continue to pass.

## 12.2 New focused tests for refactor safety
Add a small number of internal tests if practical, preferably under a new file such as:
- `extensions/safe-mode/bash-policy/validate.test.ts`
- or keep everything in `policy.test.ts` temporarily if extension-local setup is simpler.

Recommended minimum additions:
1. `validateBashCommand` returns structured parse-error reason.
2. `validateBashCommand` returns structured substitution reason for `echo $(pwd)`.
3. `validateBashCommand` returns structured `find` reason for `find . -delete`.
4. reader and smart profiles resolve identical bash outcomes for current command corpus.
5. fallback matcher triggers on unknown commands.

These are not Milestone 2 breadth tests; they are architecture-locking tests.

---

## 13. Clean-code constraints for implementation

The milestone should explicitly follow these code-quality rules.

## 13.1 Isolate `any`
- `bash-parser` AST uncertainty should live only inside the analyzer.
- exported analysis and matcher types should be strongly typed.
- no raw `any` should be needed in matcher modules.

## 13.2 Keep pure functions pure
- analyzer helpers should be deterministic and side-effect free.
- matcher evaluation should be side-effect free.
- reason creation should be deterministic.

## 13.3 Prefer immutable outputs
- return readonly arrays/objects where practical,
- build mutable state internally, freeze shape at the boundary.

## 13.4 Make default-confirm explicit
Do not scatter implicit conservative checks across multiple unrelated call sites. The registry must end in a visible `default-confirm` matcher.

## 13.5 Do not widen policy accidentally
No new command should become auto-allowed merely because it is easier under the new architecture.
Unknown or partially classified commands must continue to resolve to `confirm`.

## 13.6 Avoid clever generic abstractions too early
Milestone 1 should build a clean extension point, not a framework.
Use a straightforward registry design that is easy to read.

---

## 14. Risks and mitigations

## Risk 1 — Hidden behavior changes during extraction
### Mitigation
- move shared tables/helpers first,
- keep tests green after each step,
- port logic mechanically before simplifying.

## Risk 2 — Analyzer overreaches into policy again
### Mitigation
- ban action/decision fields from analysis types,
- keep all matcher IDs and reason codes out of `analyze.ts`.

## Risk 3 — Registry becomes harder to follow than current branching
### Mitigation
- use small, well-named matchers,
- keep priority order explicit in `profiles.ts`,
- prefer simple first-match-wins evaluation.

## Risk 4 — Duplicate parse still survives indirectly
### Mitigation
- define `analyzeBash(...)` as the only parser entry point,
- do not call `bash-parser` anywhere else in the extension.

## Risk 5 — Typed wrappers become too verbose for a small extension
### Mitigation
- keep the surface area compact,
- define only types that directly serve analysis or matching,
- avoid speculative types for features not in scope.

---

## 15. Definition of done for Milestone 1

Milestone 1 is complete when all of the following are true:

1. `policy.ts` still exposes the same public functions used by the extension.
2. Bash validation flows through a single internal entry point, e.g. `validateBashCommand(...)`.
3. Bash parsing is centralized in a single internal analysis function.
4. The analyzer returns reusable normalized facts and does not make policy decisions.
5. Bash decisions are produced by a deterministic matcher registry.
6. Current command family logic (`find`, `git`, package managers, read-only commands, write commands, `command -v`) lives in matcher modules or shared helpers supporting matcher modules.
7. `reader` and `smart` use profile composition rather than hard-coded shared condition chains.
8. Unknown, ambiguous, or parser-uncertain cases still resolve to `confirm`.
9. Existing tests pass without regressions.
10. At least minimal direct tests exist for structured matcher reasons and fallback behavior.

---

## 16. Recommended implementation order in practice

If this work is executed over multiple commits, this is the preferred sequence:

1. **Move tables/helpers** out of `policy.ts`.
2. **Build `analyze.ts`** and swap `getBashCommandType(...)` to use it.
3. **Introduce command classification summary** over analyzed commands.
4. **Introduce registry + structural matchers** with fallback confirm.
5. **Port command family matchers** one by one.
6. **Switch `decideToolCall(...)` bash path** to `validateBashCommand(...)`.
7. **Optionally switch path candidate helpers** to analysis reuse if low risk.
8. **Delete obsolete old logic**.
9. **Tighten naming, comments, and tests**.

This sequence minimizes the chance of policy drift while steadily improving architecture.

---

## 17. Final implementation philosophy

Milestone 1 should leave the codebase in a state where adding a new command policy is boring:
- add a matcher file,
- register it in a profile,
- add focused tests,
- avoid editing a giant central classification function.

That is the real success criterion.
The milestone is not about making the policy more permissive; it is about making the policy **clean, explicit, conservative, and easy to extend safely**.
