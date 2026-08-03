# Milestone 1: Core Model

Goal: define the Pi-agnostic v1 domain model and validation contract.

## Deliverables

- TypeScript domain types for decision trees.
- Enum constants and ranking helpers.
- Schema/version constants.
- Validation functions for index, session, tree, items, notes, and raw entries.
- Normalization/sanitization helpers used by later milestones.

## Suggested Files

```text
extensions/decision-tree/
  core/
    types.ts
    constants.ts
    validation.ts
    ids.ts
    time.ts
```

## Types to Define

- `Version = 1`
- `Priority = "critical" | "important" | "major" | "minor" | "nitpick"`
- `Status = "open" | "answered" | "resolved" | "superseded"`
- `AnswerStage = "accepted" | "need_polishing" | "need_approval"`
- `ItemType = "group" | "decision"`
- `NoteSource = "user" | "tool"`
- `RawRole = "user" | "tool"`
- `IndexDoc`
- `SessionDoc`
- `TreeDoc`
- `GroupItem`
- `DecisionItem`
- `TreeItem = GroupItem | DecisionItem`
- `Note`
- `RawEntry`
- validation result/error types

## Constants

- storage dir names:
  - `docs/.decisions`
  - `trees`
  - `tree.json`
  - `raw.jsonl`
  - `index.json`
  - `session.json`
- priority rank order:
  - critical
  - important
  - major
  - minor
  - nitpick
- allowed statuses and answer stages.

## Validation Rules

Implement validation for:

- `version === 1`
- UUID shape for all IDs
- ISO timestamp shape for timestamps
- enum values
- exactly one root via `tree.root`
- root is `group`
- root title may be `""`
- non-root group title must be non-empty
- decision question must be non-empty
- decision title may be `null`
- `answer === null` iff `answer_stage === null`
- non-null answer must be non-empty
- item IDs unique within tree
- no duplicate child IDs
- no cycle possible through nested structure; still detect duplicated IDs
- notes have valid `deleted_at: null | ISO string`
- `raw_refs` are UUID-like strings only; do not verify existence in `raw.jsonl`

## Helpers

- `newId(): string`
- `nowIso(): string`
- `isUuid(value): boolean`
- `isIsoTimestamp(value): boolean`
- `priorityRank(priority): number`
- `isActiveNote(note): boolean`
- `cloneTree/treeItem` helper if useful for mutation safety.

## Acceptance Criteria

- Core model compiles without importing Pi APIs.
- Invalid documents produce clear validation errors.
- Validation can be used both before mutation and when reading files.
- Tests can construct valid docs with minimal boilerplate.
