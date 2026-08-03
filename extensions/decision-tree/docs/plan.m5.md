# Milestone 5: Core Test Coverage

Goal: prove the core model, persistence contract, and service behavior before building the Pi adapter.

## Deliverables

- Unit tests for model validation.
- Contract tests for persistence implementations.
- Service tests using in-memory persistence.
- File persistence smoke/contract tests where practical.

## Suggested Files

```text
extensions/decision-tree/
  core/
    validation.test.ts
    service.test.ts
    overview.test.ts
    unresolved.test.ts
  persistence/
    memory.test.ts
    file.test.ts
```

Use the repo's existing test style where available. If no shared harness exists, keep tests simple and runnable from the extension folder.

## Validation Tests

Cover:

- valid minimal index/session/tree docs
- invalid version
- invalid UUIDs
- duplicate item IDs
- invalid enum values
- invalid timestamps
- root not group
- non-root group empty title
- root group empty title allowed
- decision empty question rejected
- answer/stage consistency
- deleted note visibility shape

## Persistence Contract Tests

Run the same behavior expectations against memory and file persistence where feasible:

- uninitialized project reports uninitialized
- init creates expected state
- init is idempotent
- index load/save round trip
- session load/save round trip
- tree save/load round trip
- tree discovery works without registry
- raw append/read round trip

## Service Tests

Cover:

- create tree sets active tree and root item
- list trees discovers created trees
- select tree by full ID and prefix
- active item fallback to root when missing
- create group under active item
- create decision under explicit parent
- create answered decision defaults status/stage correctly
- update item scalar fields
- clear answer resets answer stage
- add note and update note
- note deletion hides note by default
- include deleted notes option works
- set active item returns computed path

## Overview Tests

Cover:

- default `getTree` mode is overview
- overview omits leaf decision items
- overview includes non-leaf decisions
- overview includes aggregate counts for omitted leaves
- full mode includes full structured content
- deleted notes excluded by default

## Unresolved Tests

Cover:

- default includes open items
- default includes `need_approval`
- default excludes `need_polishing`
- filters include `need_polishing` when requested
- priority order is critical, important, major, minor, nitpick
- tree order breaks priority ties
- strategy `one` returns one item
- subtree filter limits results
- limit truncates ranked results

## Acceptance Criteria

- Core and persistence tests pass before Pi adapter is implemented.
- Tests exercise behavior through public core APIs, not just internals.
- File persistence tests use temporary directories and do not touch real project data.
