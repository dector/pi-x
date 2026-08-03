# Decision Tree Manual Smoke Test

Use this checklist to verify the v1 happy path.

## Setup

1. Create a temporary git repository.
   ```sh
   mkdir /tmp/dt-smoke
   cd /tmp/dt-smoke
   git init
   ```
2. Load the `extensions/decision-tree` Pi extension.
3. Run:
   ```text
   /dt init
   ```
4. Confirm the storage layout exists:
   ```text
   docs/.decisions/
     .gitignore
     index.json
     session.json
     trees/
   ```
5. Confirm `docs/.decisions/.gitignore` ignores `session.json`.

## Tool workflow

6. Create a tree with `dt_create_tree`.
   ```json
   { "title": "Smoke test decisions", "priority": "important" }
   ```
7. Create a group with `dt_create_item`.
   ```json
   { "type": "group", "priority": "important", "title": "Architecture" }
   ```
8. Create an answered decision.
   ```json
   {
     "type": "decision",
     "priority": "major",
     "question": "Which storage format is used?",
     "answer": "Versioned JSON files under docs/.decisions.",
     "status": "answered"
   }
   ```
9. Create an open decision.
   ```json
   {
     "type": "decision",
     "priority": "critical",
     "question": "Who owns approving critical decisions?"
   }
   ```
10. Run overview read.
    ```json
    { "mode": "overview" }
    ```
    Confirm leaf decisions are counted or omitted as leaf detail, not fully expanded.
11. Run full read.
    ```json
    { "mode": "full" }
    ```
    Confirm structured items, questions, answers, and notes are present.
12. Append a note to an item with `dt_update_item`.
    ```json
    {
      "append_notes": [
        { "source": "user", "content": "Temporary smoke-test note." }
      ]
    }
    ```
13. Mark that note deleted with `dt_update_note` by setting `deleted_at` to an ISO timestamp.
14. Confirm default reads hide the deleted note.
15. Run unresolved query.
    ```json
    { "strategy": "ranked", "limit": 10 }
    ```
    Confirm open or approval-needed items are returned in priority order.

## Command workflow

16. Run:
    ```text
    /dt status
    /dt list
    /dt select <id-prefix>
    ```
17. Confirm `/dt status` shows initialized state, project root, decisions path, active tree/item, tree count, and unresolved count when available.
18. Confirm `/dt list` shows tree title, short ID, status, updated time, and active marker.
19. Confirm `/dt select` updates `docs/.decisions/session.json` and sets the active item to root if needed.

## Restart check

20. Restart Pi or reload the extension.
21. Run `/dt status`.
22. Confirm active context resumes from local `docs/.decisions/session.json`.

## Git check

23. Run `git status`.
24. Confirm tree data appears as committable files.
25. Confirm `docs/.decisions/session.json` is ignored by git.
