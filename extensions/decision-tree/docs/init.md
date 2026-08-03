# Decision Tree Extension — Initial Decisions

## Purpose

- Build a Pi extension that improves the `askme` workflow by moving decision tracking out of flat files/chat context into structured project-local state.
- Primary problems to solve: poor structure and context bloat in file-based Q/A logs.
- Optimize for both agent workflow and user inspection, with first-class agent support.
- Use generic-enough concepts so this can later become an entry point for tickets, issues, features, epics, etc., without implementing those in v1.

## Terminology

- UX term: **decision tree**.
- Internal term: **tree**.
- Node term: **graph item**.
- Initial item types:
  - `group`
  - `decision`
- A decision item contains a question and one accepted/polished answer.
- Decision items can have children as a zoom-in / mind-map style structure.
- v1 is tree-first, not a general graph/DAG.

## Tree Model

- Support multiple decision trees per project.
- Each tree has exactly one root item.
- Root item is a normal `group` item.
- Root group uses an empty title `""`.
- Only the root group may have an empty title; non-root groups must have non-empty titles.
- The tree-level title is the root display label and is used for listing/selecting trees.
- Tree item IDs use UUIDs.
- Sibling order is defined by the order in the data model; no explicit manual ordering field in v1.
- Parent links / nesting are the source of truth; paths are computed dynamically and returned by tools when useful.

## Project Scope

- Active tree/item context is scoped per project.
- Project identity is the git repository root when available, otherwise current working directory.
- Storage is project-local and intended to be committed to git.

## Storage Layout

Decision data lives under:

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

- `docs/.decisions/` is the extension folder-space.
- `docs/.decisions/index.json` stores stable project config only.
- Trees are discovered by scanning `docs/.decisions/trees/*/tree.json`; `index.json` does not list trees in v1.
- `docs/.decisions/session.json` stores frequently changing local session context.
- `session.json` is local by default and ignored by `docs/.decisions/.gitignore`.
- `docs/.decisions/.gitignore` should be committed and should ignore `session.json`.
- Each tree gets its own folder for future extensibility.
- Main tree data lives in `tree.json`.
- Raw history lives in `raw.jsonl`.

## File Versioning

- Use `version: 1` in all JSON files.

## `index.json`

v1 shape:

```json
{
  "version": 1,
  "history": {
    "capture_default": true
  }
}
```

- Project-level raw history capture defaults to on.
- Raw history capture can be overridden per tree.

## `session.json`

v1 shape:

```json
{
  "version": 1,
  "active_tree_id": "uuid-or-null",
  "active_item_id": "uuid-or-null",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

- Stores active tree and active item pointers.
- Persisted locally, not committed by default.
- Used so tools can safely default omitted tree/item IDs to active context.
- Tool responses should state resolved tree/item/path when active context is used.

## `tree.json`

Top-level v1 shape:

```json
{
  "version": 1,
  "id": "uuid",
  "title": "Decision tree title",
  "status": "open|answered|resolved|superseded",
  "history": {
    "capture": null
  },
  "root": {
    "id": "uuid",
    "type": "group",
    "priority": "important",
    "title": "",
    "status": "open",
    "notes": [],
    "raw_refs": [],
    "children": [],
    "created_at": "ISO-8601",
    "updated_at": "ISO-8601"
  },
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

- `history.capture: null` means inherit project default.
- Tree status values are shared with items.

## Item Fields

### Common fields

All items have:

- `id`
- `type`
- `priority`
- `title` according to type rules
- `status`
- `notes`
- `raw_refs`
- `children`
- `created_at`
- `updated_at`

### Group item

```json
{
  "id": "uuid",
  "type": "group",
  "priority": "critical|important|major|minor|nitpick",
  "title": "Section title",
  "status": "open|answered|resolved|superseded",
  "notes": [],
  "raw_refs": [],
  "children": [],
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

- Non-root group title must be non-empty.
- Root group title must be `""`.
- Groups do not require Q/A fields.

### Decision item

```json
{
  "id": "uuid",
  "type": "decision",
  "priority": "critical|important|major|minor|nitpick",
  "title": null,
  "question": "Question text",
  "answer": null,
  "answer_stage": null,
  "status": "open|answered|resolved|superseded",
  "notes": [],
  "raw_refs": [],
  "children": [],
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

- Decision `title` is nullable.
- `question` is required and non-empty.
- `answer` is one current accepted/polished answer, not necessarily verbatim user wording.
- Original wording belongs in raw history.
- Unanswered decisions use `answer: null` and `answer_stage: null`.
- Non-null answers must be non-empty.

## Statuses

Supported values:

- `open`
- `answered`
- `resolved`
- `superseded`

Rules:

- Status is manual per item.
- No automatic status rollup in v1.
- Computed branch hints may be added later, but no stored summaries in v1.
- Groups and decisions share statuses with type-specific interpretation.

## Answer Stage

Supported values:

- `accepted`
- `need_polishing`
- `need_approval`
- `null`

Rules:

- `accepted` is the default when an answer is provided.
- `need_polishing` means answer exists but should later be improved by the agent.
- `need_approval` means answer needs explicit user attention/approval, usually for critical decisions.
- `answer_stage` applies only when `answer` exists.
- If `answer` is null, `answer_stage` must be null.

## Priority

Supported priority values, in ranking order:

1. `critical`
2. `important`
3. `major`
4. `minor`
5. `nitpick`

Rules:

- `priority` is required for all items, including groups.
- Priority is a strong traversal hint, not a hard constraint.

## Notes

Notes are curated structured context and are included in default reads.

Note shape:

```json
{
  "id": "uuid",
  "timestamp": "ISO-8601",
  "source": "user|tool",
  "content": "...",
  "deleted_at": null
}
```

Rules:

- `source` distinguishes user-authored constraints from agent/tool observations.
- Deleted notes are retained with `deleted_at` set to an ISO timestamp.
- `deleted_at: null` means active note.
- Default fetches exclude deleted notes.
- Reads may optionally include deleted notes.
- Note content and source can be edited.
- Note deletion is handled by an update operation that sets `deleted_at`.

## Raw History

- Raw conversation history is useful for historical reasons, not core workflow.
- Raw history is not returned by default.
- Raw history capture is default-on but can be opted out.
- Capture config exists at project level and can be overridden per tree.
- In visible v1 agent tools, raw capture is skipped; raw append support is implemented internally/hidden for future use.
- No raw deletion/redaction tool in v1.

`raw.jsonl` format:

- One JSON object per line.
- Each raw entry has its own UUID in `id`.
- Raw entries do not backreference `item_id`.
- Items own references via `raw_refs`.

Raw entry shape:

```json
{
  "id": "uuid",
  "timestamp": "ISO-8601",
  "role": "user|tool",
  "content": "raw message text"
}
```

Roles:

- `user` means user-provided answer/input.
- `tool` means auto-answered/suggested/prompted by the agent/tool.

Items may reference multiple raw entries:

```json
"raw_refs": ["uuid1", "uuid2"]
```

## Validation Invariants

Core must enforce in v1:

- File `version === 1`.
- All IDs are UUIDs.
- Item IDs are unique within a tree.
- Exactly one root item.
- Root item type is `group`.
- Root group title is allowed to be `""`.
- Non-root group titles must be non-empty.
- Decision `question` must be non-empty.
- Decision `answer === null` iff `answer_stage === null`.
- Non-null answer must be non-empty.
- Enum fields must be valid.
- Children must form a tree.
- No duplicate child IDs.
- `raw_refs` are UUID-like strings.
- `raw_refs` existence in `raw.jsonl` is not hard-validated in v1.
- Timestamps are valid ISO strings.
- Mutations update relevant item/tree `updated_at` values.

Validation behavior:

- Mutations reject invalid data.
- Reads/lists can report validation errors where practical.

## Architecture

Implementation should have at least two layers, preferably three:

1. **Core layer**
   - Pi-agnostic business logic.
   - Testable.
   - Usable by CLI/GUI later.
   - Owns validation, tree mutation rules, path computation, active-item rules, and query semantics.

2. **Persistence layer/interface**
   - Dumb load/save/append operations.
   - File-backed implementation for v1.
   - In-memory implementation for tests.
   - Allows future remote or alternate storage.

3. **Pi extension adapter**
   - Registers Pi tools and `/dt` command.
   - Uses core and persistence.
   - Should be implemented last.

Implementation order:

1. Core types/schema/validation.
2. Persistence interface plus in-memory/file implementations.
3. Core service/mutations/queries with tests.
4. Pi extension adapter/tools/commands.

## Extension Placement and Naming

- Extension path: `extensions/decision-tree`.
- Tool prefix: `dt_`.
- Human command namespace: `/dt`.
- Distributed extension in this monorepo; no separate external package structure required beyond repo conventions.

## Visible v1 Tools

Visible agent tools:

1. `dt_init`
2. `dt_get_session`
3. `dt_create_tree`
4. `dt_list_trees`
5. `dt_select_tree`
6. `dt_get_tree`
7. `dt_get_item`
8. `dt_create_item`
9. `dt_update_item`
10. `dt_update_note`
11. `dt_set_active_item`
12. `dt_next_unresolved`

Hidden/internal:

- raw append support, conceptually `dt_append_raw` / core `appendRaw`, implemented but not registered as a visible LLM tool in v1.

## Tool Semantics

General rules:

- Tools may accept explicit tree/item IDs.
- If IDs are omitted, tools use active context where appropriate.
- Responses must clearly state resolved tree/item/path when active context is used.
- Avoid returning the whole tree by default unless explicitly requested.
- Raw history is always opt-in and is not visible in v1 agent workflow.

### `dt_init`

- Explicit init is required before creating files/directories.
- Idempotent and non-destructive by default.
- Creates scaffolding only.
- Does not create an initial tree.
- Does not silently modify root `.gitignore`.
- Creates committed `docs/.decisions/.gitignore` to ignore local session state.

### `dt_create_tree`

Requires:

- `title`
- root `priority`

Behavior:

- Creates a new tree folder and `tree.json`.
- Creates root group with empty title.
- Root status starts `open`.
- Tree inherits project history capture default via `history.capture: null`.
- New tree/root become active.

### `dt_create_item`

Requires:

- `type`
- `priority`

Parent:

- Optional `parent_id`, defaults to active item.

Group:

- Requires `title`.

Decision:

- Requires `question`.
- `title` may be null/omitted.
- Can be created already answered.
- If `answer` is provided, default `answer_stage` is `accepted` and default status is `answered`.
- If no answer is provided, default status is `open` and `answer_stage` is null.

Behavior:

- Created item becomes active by default.
- Raw history is not captured automatically in visible v1 tools.

### `dt_update_item`

Supports scalar patching:

- `priority`
- `title`
- `question`
- `answer`
- `answer_stage`
- `status`

Also supports appending notes and raw refs where appropriate.

Rules:

- Does not allow arbitrary child replacement.
- Clearing `answer` back to null is allowed.
- Clearing answer requires/sets `answer_stage: null`.
- Status likely becomes `open` unless explicitly supplied validly.

### `dt_update_note`

Requires:

- `item_id`
- `note_id`

Supports:

- changing `content`
- changing `source`
- setting `deleted_at` to mark deleted

Default reads hide notes with non-null `deleted_at`.

### `dt_get_tree`

- Defaults to active tree if `tree_id` omitted.
- Default mode is `overview`.
- Explicit `full` mode returns full structured tree.
- Raw history is excluded.
- Deleted notes are excluded by default.

Modes:

- `overview`
  - Shows structure without content-heavy leaf detail.
  - Does not fetch/render leaf nodes individually.
  - Omits leaf decision items and represents them as aggregate counts under parents.
  - Includes non-leaf decision items as lightweight structural nodes because they are branch points.
  - Excludes answer, notes, raw refs, and timestamps.
- `full`
  - Returns full structured tree, excluding raw history and deleted notes by default.

### `dt_get_item`

- Defaults to active tree/item when omitted where appropriate.
- Supports independent options:
  - include ancestors/path
  - children depth
  - include deleted notes
  - raw history opt-in later, not default
- Includes real child items up to requested depth.
- No overview mode in v1.

### `dt_next_unresolved`

Default view means user attention:

- Includes `status: open`.
- Includes `answer_stage: need_approval`.
- Excludes `answer_stage: need_polishing` by default because that is agent work.
- Excludes resolved/superseded items unless filters say otherwise.

Sorting:

1. priority order: `critical`, `important`, `major`, `minor`, `nitpick`
2. tree order

Supports:

- `strategy: ranked|one`
- `priorities`
- `statuses`
- `answer_stages`
- `subtree_root_id`
- `limit`

Rules:

- Returns both groups and decisions if they match.
- Actionable decision items are primary.
- Open items can be returned even if they have children.

### Hidden raw append

- Implement internally but do not register as visible agent tool in v1.
- If history capture is disabled, append returns a successful skipped result and does not modify `raw_refs`.

## Read Behavior and Context Control

- Default reads avoid raw history.
- Default tree read is overview mode.
- Full tree read must be explicit.
- Specific item/subtree reads are supported for focused context.
- No computed prose summaries in v1.
- Curated notes are the mechanism for storing summaries/context.

## `/dt` Command UX

v1 commands are minimal wrappers for humans:

- `/dt init`
- `/dt status`
- `/dt list`
- `/dt select`

Rules:

- `/dt` with no args is alias for `/dt status`.
- Unknown subcommands show short help.
- No rich TUI tree browser in v1.

### `/dt init`

- Creates project scaffolding.
- Idempotent and non-destructive.

### `/dt status`

Shows:

- initialized/not initialized
- project root
- decisions path
- active tree id/title
- active item id/path
- tree count
- brief unresolved count if cheap

### `/dt list`

Shows discovered trees with:

- active marker
- title
- short id
- status
- updated_at

### `/dt select`

- Supports `/dt select <id-prefix>`.
- With no arg and UI available, opens an interactive picker.
- Updates `session.json`.
- Defaults active item to root if previous active item is missing/invalid.

## Out of Scope for v1

- Automatic conversation capture from Pi events.
- Rich TUI tree browser.
- Ticket/issue/epic integration.
- Arbitrary graph/DAG links.
- Manual sibling ordering.
- Raw history redaction/deletion tools.
- Migrations beyond `version: 1` validation.
- Stored/computed prose summaries.
- Remote persistence.
- Complex permission/team workflows.
- Auto-modifying root `.gitignore`.
