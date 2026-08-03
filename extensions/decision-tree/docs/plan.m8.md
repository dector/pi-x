# Milestone 8: Documentation and Smoke Test

Goal: make the extension understandable and verify one end-to-end workflow.

## Deliverables

- Extension README.
- Usage examples for tools and `/dt` commands.
- Storage layout documentation.
- A manual smoke-test checklist.
- Optional package metadata/scripts matching repo conventions.

## Suggested Files

```text
extensions/decision-tree/
  README.md
  package.json        # only if needed by repo conventions/tooling
  docs/
    init.md
    plan.md
    plan.m1.md ... plan.m8.md
```

## README Content

Include:

- What problem the extension solves.
- Terminology:
  - UX: decision tree
  - internal: tree
  - items: group/decision
- Storage layout under `docs/.decisions/`.
- Git behavior:
  - committed tree data
  - local ignored `session.json`
- Visible tools list.
- `/dt` commands.
- v1 limitations/out-of-scope.

## Tool Usage Examples

Show a concise flow:

1. initialize
2. create tree
3. create group
4. create decision
5. answer/update decision
6. read overview
7. get next unresolved
8. update/select active item

## Command Usage Examples

Show:

```text
/dt init
/dt status
/dt list
/dt select <id-prefix>
```

## Smoke Test Checklist

Manual workflow:

1. Start in a temporary git repo.
2. Load the extension.
3. Run `/dt init`.
4. Confirm `docs/.decisions/` layout exists.
5. Confirm `.gitignore` ignores `session.json`.
6. Create a decision tree via tool.
7. Create a group and several decision items.
8. Create one answered decision and one open decision.
9. Run overview read and confirm leaf decisions are counted/omitted.
10. Run full read and confirm structured content exists.
11. Update a note and mark it deleted.
12. Confirm default reads hide deleted note.
13. Run unresolved query and confirm priority ordering.
14. Run `/dt status`, `/dt list`, and `/dt select`.
15. Restart Pi or reload extension and confirm active context resumes from `session.json` locally.

## Acceptance Criteria

- New users can understand the extension from README alone.
- Smoke test validates core happy path.
- Documentation clearly states v1 limitations.
- `init.md` remains the source of initial design decisions.
