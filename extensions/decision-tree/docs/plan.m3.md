# Milestone 3: File Persistence

Goal: implement project-local file persistence under `docs/.decisions/`.

## Deliverables

- File-backed persistence implementation.
- Project-root resolver.
- Idempotent filesystem initialization.
- Tree discovery by scanning tree folders.
- JSONL append/read support for raw history.

## Suggested Files

```text
extensions/decision-tree/
  persistence/
    file.ts
    paths.ts
    project.ts
```

## Project Root Resolution

- Use git repository root when available.
- Otherwise use current working directory.
- Keep this resolver outside Pi adapter so CLI/GUI can reuse it later.

## Storage Paths

For a project root:

```text
docs/.decisions/
  .gitignore
  index.json
  session.json
  trees/<tree_uuid>/tree.json
  trees/<tree_uuid>/raw.jsonl
```

## Init Behavior

`init` should create:

- `docs/.decisions/`
- `docs/.decisions/trees/`
- `docs/.decisions/index.json` if missing
- `docs/.decisions/.gitignore` if missing
- optionally `docs/.decisions/session.json` if missing

Rules:

- Do not overwrite existing files by default.
- `.gitignore` should ignore `session.json`.
- `index.json` default history capture is on.

## Tree Discovery

- Scan `docs/.decisions/trees/*/tree.json`.
- Load each candidate tree when listing.
- Report validation/read errors where practical instead of crashing the whole list.

## JSON Handling

- Pretty-print committed JSON files with stable indentation.
- Use atomic-ish writes where simple: write temp file then rename.
- Raw history uses append-only `raw.jsonl`.
- `raw.jsonl` entries are one JSON object per line.

## Acceptance Criteria

- Running init twice is safe.
- Tree folders are created as `trees/<uuid>/`.
- Tree list works without `index.json` tree registry.
- `session.json` remains local/ignored by committed `.gitignore`.
- File persistence passes the same contract tests as memory persistence where possible.
