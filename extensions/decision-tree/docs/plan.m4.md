# Milestone 4: Core Service

Goal: implement Pi-agnostic operations for trees, items, notes, active context, and queries.

## Deliverables

- Core service class or functions using the persistence interface.
- Session context operations.
- Tree CRUD operations.
- Item mutation operations.
- Read operations with path/depth options.
- Overview tree projection.
- Unresolved query.
- Hidden raw append operation.

## Suggested Files

```text
extensions/decision-tree/
  core/
    service.ts
    traversal.ts
    mutations.ts
    overview.ts
    unresolved.ts
    session.ts
```

## Service Operations

Visible-agent-aligned operations:

- `init(projectRoot)`
- `getSession(projectRoot)`
- `createTree(projectRoot, { title, priority })`
- `listTrees(projectRoot)`
- `selectTree(projectRoot, treeIdOrPrefix)`
- `getTree(projectRoot, options)`
- `getItem(projectRoot, options)`
- `createItem(projectRoot, input)`
- `updateItem(projectRoot, input)`
- `updateNote(projectRoot, input)`
- `setActiveItem(projectRoot, input)`
- `nextUnresolved(projectRoot, filters)`
- hidden/internal `appendRaw(projectRoot, input)`

## Active Context

- Resolve omitted tree ID from `session.json` active tree.
- Resolve omitted item ID from `session.json` active item where appropriate.
- Responses should include resolved IDs and computed path.
- Selecting a tree sets active tree and active item.
- If active item is missing/invalid, fall back to root.

## Tree Creation

- Create tree UUID and root item UUID.
- Root group title is `""`.
- Root priority comes from input.
- Root status starts `open`.
- Tree status starts `open`.
- Tree history capture override is `null`.
- New tree/root become active.

## Item Creation

- Default parent is active item.
- Group requires non-empty title.
- Decision requires non-empty question.
- Decision title may be null.
- Answered decisions can be created.
- If answer provided, default status is `answered` and answer stage is `accepted`.
- If no answer, default status is `open` and answer stage is null.
- Created item becomes active.

## Item Updates

- Patch scalar fields only.
- Do not replace children arrays directly.
- Allow clearing answer to null and force answer stage null.
- Validate final tree before save.
- Update item and tree timestamps.

## Notes

- Add notes through item update or a dedicated note-add field.
- Update note by `item_id` + `note_id`.
- Allow changing note content and source.
- Mark deletion by setting `deleted_at`.
- Default read projections hide deleted notes.

## Read Operations

`getTree`:

- default mode `overview`
- explicit `full`
- raw excluded
- deleted notes excluded by default

`getItem`:

- include path option
- children depth option
- include deleted notes option
- raw excluded by default

## Overview Projection

- Include root and structural nodes.
- Include non-leaf decisions as lightweight branch nodes.
- Omit leaf decision items as individual nodes.
- Represent omitted leaf decisions as aggregate counts under parents.
- Exclude answers, notes, raw refs, and timestamps.

## Unresolved Query

Default user-attention mode:

- include `status: open`
- include `answer_stage: need_approval`
- exclude `need_polishing` unless filtered

Filters:

- priorities
- statuses
- answer stages
- subtree root id
- limit
- strategy `ranked|one`

Sort by priority rank then tree order.

## Acceptance Criteria

- All operations are usable without Pi APIs.
- All mutations validate before save.
- Active context behavior is deterministic and visible in results.
- Reads avoid raw history by default.
