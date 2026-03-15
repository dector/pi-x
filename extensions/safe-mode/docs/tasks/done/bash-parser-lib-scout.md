# Scout report: `bash-parser` for `safe-mode`

## Scope

Requested analysis:
1. Analyze `vorpaljs/bash-parser`.
2. Analyze how to use its AST to auto-allow read-only shell commands even when composed with `&&`, `|`, `$()`, etc.
3. Define how to allow `find` only when no `-exec` argument is present.

---

## 1) `bash-parser` library analysis

Repository analyzed: `https://github.com/vorpaljs/bash-parser` (master, npm `0.5.0`).

### What it provides

- Entry API: `parse(sourceCode, options?)`.
- Output: Bash/posix AST rooted at `Script`.
- Composition nodes include:
  - `LogicalExpression` (`&&`, `||`)
  - `Pipeline` (`|`)
  - `Command`
  - `Subshell`, `CompoundList`, `If`, `For`, `While`, `Until`, `Function`, `Case`
- Token-level nodes include:
  - `Word`, `AssignmentWord`, `Redirect`
- Expansion nodes include:
  - `CommandExpansion` for `$()` / backticks
  - `ParameterExpansion`
  - `ArithmeticExpansion`

### Relevant behavior for policy checks

- `$()` and backticks are preserved as expansion metadata on `Word`/`AssignmentWord`.
- `CommandExpansion` contains a recursively parsed `commandAST` (important for nested policy checks).
- Pipelines and logical chains are represented structurally in AST (no string heuristics needed).
- Redirections are explicit `Redirect` nodes with operator token info (`>`, `>>`, `<`, etc).

### Integration characteristics

- CommonJS package (no TS types included).
- Older codebase (Node >=4 target, legacy deps), so treat as stable-but-old.
- For `safe-mode`, this is still useful because policy logic needs syntax structure, not modern runtime features.

### Risk / caveats

- Parser age means possible gaps for newer bash syntax edge cases.
- Should use conservative fallback: parse failure => `confirm` (never auto-allow on uncertainty).

---

## 2) AST-driven policy model for read-only commands in composed syntax

Current `safe-mode` logic is mostly tokenizer/heuristic based and intentionally rejects many compositions.

AST-based approach can allow more safe read-only usage while remaining conservative.

## Core idea

1. Parse command once with `bash-parser`.
2. Recursively evaluate every executable node and every nested expansion.
3. Auto-allow only if **all reachable commands are read-only** and no denied construct appears.
4. On unknown/ambiguous parse paths -> `confirm`.

## Traversal strategy

Evaluate by node type:

- `Script`: all `commands` must be read-only.
- `LogicalExpression`: both `left` and `right` must be read-only.
  - This enables `cmd1 && cmd2` and `cmd1 || cmd2` when both are safe.
- `Pipeline`: all `commands` stages must be read-only.
- `Command`:
  - Resolve executable (`name.text`) and args (`suffix` `Word`s).
  - Reject/confirm on output redirections (`>`, `>>`, `<>`, etc).
  - Allow input redirection (`<`, `<<`) only if desired by policy.
  - Check expansions in `name`, `prefix`, `suffix` words.
- `Subshell` / `CompoundList` / control-flow nodes (`If`, `For`, `While`, `Until`, `Case`, `Function`): recursively evaluate enclosed command lists.
- `CommandExpansion` (inside words): recursively evaluate `commandAST`.
  - This enables safe handling of `$()` and backticks.

## Read-only classification

Keep existing command classification tables from `policy.ts` (read-only list, write list, git subcommands, package manager writes), but run them on AST-extracted command + args instead of raw-string tokenization.

Decision rule for auto-allow:

- every visited command classified as `hasReads=true` and `hasWrites=false`
- no denied `find` form (see section 3)
- no unsupported/ambiguous node outcome

Anything else => `confirm`.

---

## 3) `find` rule: allow only when no `-exec`

Implement a special check when command program is `find`.

### Argument inspection

Extract `find` arguments from command `suffix` `Word` nodes (`word.text`).

Deny/require-confirm if any argument indicates exec behavior:

- exact `-exec`
- optionally (recommended hardening): `-execdir`, `-ok`, `-okdir`

If requirement is strictly “only block `-exec`”, then only match exact `-exec`.

### Important edge cases

- `find . -name '*.ts'` -> allow (if no write flags/redirects elsewhere).
- `find . -exec rm {} \;` -> confirm/block.
- `find . -execdir rm {} \;` -> recommend confirm/block as well.
- `find . $(echo -exec) rm {} \;`:
  - conservative behavior should be `confirm`, because expansion can produce `-exec` dynamically.

Recommended conservative rule:

- if `find` command has any unresolved expansion in args (`CommandExpansion`, `ParameterExpansion`, `ArithmeticExpansion`) -> `confirm`.

---

## Suggested implementation shape in `extensions/safe-mode/policy.ts`

1. Add parser dependency usage:
   - `import parse from "bash-parser"` (or CJS interop wrapper).
2. Replace `inspectShellSyntax`, `splitPipelineStages`, and manual tokenization path with AST evaluator.
3. Keep/reuse command classification helpers (`classifyCommand`, git/package manager logic).
4. Add recursive visitors:
   - `evaluateNode(node): {safe:boolean, reason?:string}`
   - `evaluateCommand(node)`
   - `evaluateWordExpansions(word)`
5. Add `find`-specific arg validator `isSafeFindCommand(commandNode)`.
6. Fallback policy:
   - parse error / unknown node => `confirm`.

---

## Test plan impact

Add/adjust tests to cover auto-allow cases now possible via AST:

- `ls && pwd`
- `git log --oneline | head -n 20`
- `echo $(pwd)` (should stay `confirm` unless policy explicitly allows `echo` + safe `$()` source)
- `ls; pwd` (can be allowed if both read-only and semicolon permitted by policy)
- `find . -name '*.ts'` allowed
- `find . -exec rm {} \;` blocked/confirm
- nested: `echo $(git log --oneline | head -n 1)` allowed only if nested AST safe

And conservative behavior tests:

- parse failure => `confirm`
- unknown command in any branch of `&&` / `|` / `$()` => `confirm`

---

## Bottom line

`bash-parser` is a strong fit for replacing fragile shell-string heuristics in `safe-mode`.

It enables policy decisions on real syntax trees, which is exactly what is needed to safely support composed read-only commands (`&&`, `|`, `$()`, subshells, etc.) while enforcing targeted deny rules like `find -exec`.
