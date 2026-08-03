# Decision Tree Extension

Decision Tree is a Pi extension for tracking project decisions in structured, project-local state.

It was built to improve the `askme` workflow. Instead of keeping a long flat Q/A log in chat or ad-hoc files, decisions are stored as a navigable tree with stable IDs, status, priority, notes, and active context.

## Terminology

- UX name: **decision tree**
- Internal name: **tree**
- Tree items:
  - `group`: a section or branch
  - `decision`: a question with one accepted or pending answer

A project can have multiple decision trees. Each tree has one root `group` item. Decision items can also have children, so a decision can become a branch for follow-up questions.

## Storage layout

After `dt_init` or `/dt init`, project data is stored under:

```text
docs/.decisions/
  .gitignore
  index.json
  session.json
  trees/
    <tree_uuid>/
      tree.json
      raw.jsonl
```

Files use `version: 1`.

- `index.json` stores stable project config.
- `session.json` stores local active tree/item context.
- `trees/*/tree.json` stores committed structured decision data.
- `trees/*/raw.jsonl` is reserved for raw history support.

Trees are discovered by scanning `docs/.decisions/trees/*/tree.json`.

## Git behavior

Decision tree data is project-local and intended to be committed.

Commit these files:

```text
docs/.decisions/.gitignore
docs/.decisions/index.json
docs/.decisions/trees/*/tree.json
docs/.decisions/trees/*/raw.jsonl
```

Do not commit `docs/.decisions/session.json` by default. The extension creates `docs/.decisions/.gitignore` with an entry for `session.json`.

The extension does not silently edit your repository root `.gitignore`.

## Visible agent tools

- `dt_init`
- `dt_get_session`
- `dt_create_tree`
- `dt_list_trees`
- `dt_select_tree`
- `dt_get_tree`
- `dt_as_markdown`
- `dt_get_item`
- `dt_create_item`
- `dt_update_item`
- `dt_update_note`
- `dt_set_active_item`
- `dt_next_unresolved`

Raw history append support exists internally but is not exposed as a visible v1 agent tool.

## Tool usage example

A concise agent workflow:

```text
1. Initialize storage
   dt_init {}

2. Create a tree
   dt_create_tree {
     "title": "Authentication design",
     "priority": "important"
   }

3. Create a group under the active root
   dt_create_item {
     "type": "group",
     "priority": "important",
     "title": "Session model"
   }

4. Create an open decision under the active group
   dt_create_item {
     "type": "decision",
     "priority": "critical",
     "question": "Should sessions be cookie-based or token-based?"
   }

5. Answer or update the active decision
   dt_update_item {
     "answer": "Use secure, HTTP-only cookies for browser sessions.",
     "answer_stage": "accepted",
     "status": "answered",
     "append_notes": [
       { "source": "user", "content": "Browser-only product for v1." }
     ]
   }

6. Read an overview. Leaf decisions are counted, not expanded.
   dt_get_tree { "mode": "overview" }

7. Render the tree as Markdown.
   dt_as_markdown {}

8. Find user-attention items
   dt_next_unresolved { "strategy": "ranked", "limit": 5 }

9. Select an active item explicitly
   dt_set_active_item { "item_id": "<item-uuid>" }
```

Most tools can omit `tree_id` and/or `item_id`. They use the active context from `session.json` where appropriate and report the resolved tree/item/path.

## `/dt` commands

Human commands are minimal wrappers:

```text
/dt init
/dt status
/dt list
/dt select <id-prefix>
```

`/dt` with no arguments is the same as `/dt status`.

`/dt select` without an ID opens a picker when Pi UI selection is available. Otherwise it prints usage.

## Read modes

`dt_get_tree` defaults to overview mode.

- `overview`: returns lightweight structure. It omits answers, notes, raw refs, timestamps, and leaf decision details. Leaf decisions are represented by counts.
- `full`: returns full structured tree data, excluding raw history and deleted notes by default.

Use `dt_get_item` for focused reads of one item and optional child depth.

Use `dt_as_markdown` to render a tree as simple structured Markdown:

```markdown
# Tree title

## Group title

### Decision title or question

Q: Question text
A: Answer text
Notes:
- user: Note text
```

## v1 limitations

Out of scope for v1:

- automatic conversation capture from Pi events
- rich TUI tree browser
- ticket, issue, feature, or epic integration
- arbitrary graph/DAG links
- manual sibling ordering fields
- raw history redaction/deletion tools
- migrations beyond `version: 1` validation
- stored or computed prose summaries
- remote persistence
- complex permission/team workflows
- automatic edits to the repository root `.gitignore`

See [`docs/init.md`](docs/init.md) for the source design decisions and [`docs/smoke-test.md`](docs/smoke-test.md) for manual verification.
