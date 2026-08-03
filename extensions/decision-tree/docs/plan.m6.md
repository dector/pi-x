# Milestone 6: Pi Tool Adapter

Goal: expose the core service as Pi LLM tools with concise, deterministic schemas and responses.

## Deliverables

- Extension entry point registers visible `dt_*` tools.
- Tool schemas using TypeBox.
- Adapter code maps Pi `ctx.cwd` to project root and calls the core service.
- Tool responses include resolved context where relevant.
- Hidden raw append remains unregistered from the LLM-visible tool list.

## Suggested Files

```text
extensions/decision-tree/
  index.ts
  pi/
    tools.ts
    schemas.ts
    format.ts
    context.ts
```

## Visible Tools

Register:

- `dt_init`
- `dt_get_session`
- `dt_create_tree`
- `dt_list_trees`
- `dt_select_tree`
- `dt_get_tree`
- `dt_get_item`
- `dt_create_item`
- `dt_update_item`
- `dt_update_note`
- `dt_set_active_item`
- `dt_next_unresolved`

Do not register `dt_append_raw` in v1.

## Tool Schema Principles

- Keep inputs small and explicit.
- Prefer separate tools over many optional parameters.
- Allow omitted tree/item IDs only where active context is well-defined.
- Use enums for status, priority, answer stage, item type, note source, and strategy.
- Make `dt_get_tree` mode default to `overview`.
- Make raw-history options absent or disabled in visible v1 schemas.

## Response Principles

Every focus-dependent response should include:

- `project_root`
- `decisions_path`
- resolved `tree_id`
- resolved tree title when available
- resolved `item_id` when relevant
- computed active/path context when relevant
- concise operation result

Avoid returning full tree content unless requested explicitly.

## Error Handling

Map core errors to clear tool text:

- not initialized -> suggest `dt_init`
- no active tree -> suggest `dt_create_tree` or `dt_select_tree`
- no active item -> suggest selecting tree/item
- tree/item not found -> include requested ID/prefix
- validation error -> include concise validation messages

## Tool Details

### `dt_init`

- No create-tree shortcut.
- Idempotent result with created/existing paths.

### `dt_get_session`

- Return project root, decisions path, initialized state, active tree/item, and active path if available.

### `dt_create_tree`

- Require title and root priority.
- Return created tree and root path.

### `dt_list_trees`

- Return discovered trees and validation/read errors if any.

### `dt_select_tree`

- Accept tree ID or ID prefix.
- Update session.
- Return active root/item context.

### `dt_get_tree`

- Default mode overview.
- Explicit full mode.

### `dt_get_item`

- Support include path, children depth, include deleted notes.

### `dt_create_item`

- Support group/decision creation.
- Created item becomes active.

### `dt_update_item`

- Patch scalar fields and append notes/raw refs if core supports those fields.

### `dt_update_note`

- Require item ID and note ID.
- Edit content/source and/or set deleted timestamp.

### `dt_set_active_item`

- Set active item and return full path.

### `dt_next_unresolved`

- Support filters and strategy.
- Return ranked list by default.

## Acceptance Criteria

- Pi adapter imports Pi APIs only in adapter files.
- Core tests still run without Pi installed if possible.
- Tool outputs are concise and agent-friendly.
- Hidden raw append is not visible to the LLM in v1.
