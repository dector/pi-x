# Milestone 2: Persistence Boundary

Goal: create storage abstractions that keep core logic independent from file system details.

## Deliverables

- Persistence interface.
- In-memory persistence implementation for tests.
- Storage path resolver interface or helper.
- Error types for missing initialization, missing tree, corrupt JSON, and validation failures.

## Suggested Files

```text
extensions/decision-tree/
  persistence/
    types.ts
    memory.ts
    errors.ts
```

## Persistence Interface

Suggested operations:

- `isInitialized(projectRoot): Promise<boolean>`
- `init(projectRoot): Promise<InitResult>`
- `loadIndex(projectRoot): Promise<IndexDoc>`
- `saveIndex(projectRoot, index): Promise<void>`
- `loadSession(projectRoot): Promise<SessionDoc | null>`
- `saveSession(projectRoot, session): Promise<void>`
- `listTreeIds(projectRoot): Promise<string[]>`
- `loadTree(projectRoot, treeId): Promise<TreeDoc>`
- `saveTree(projectRoot, tree): Promise<void>`
- `appendRaw(projectRoot, treeId, entry): Promise<void>`
- `readRaw(projectRoot, treeId, ids?): Promise<RawEntry[]>`

Keep the interface simple and document that persistence does not own business validation.

## In-Memory Implementation

- Store docs in maps keyed by project root and tree ID.
- Support multiple project roots.
- Preserve JSON-like semantics by cloning on load/save where practical.
- Implement raw history as an array of entries per tree.
- Support initialized/uninitialized project states.

## Error Model

Create explicit errors or tagged results for:

- project not initialized
- missing index
- missing session
- tree not found
- malformed JSON / invalid persisted content
- raw history unavailable

## Acceptance Criteria

- Core service can depend only on the persistence interface.
- Tests can use memory persistence without touching disk.
- Persistence does not import Pi APIs.
- Memory persistence supports all v1 operations needed by the core service.
