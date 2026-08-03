# Milestone 7: `/dt` Commands

Goal: add minimal human-facing commands for setup, status, listing, and selection.

## Deliverables

- Register `/dt` command namespace.
- Implement subcommands:
  - `/dt init`
  - `/dt status`
  - `/dt list`
  - `/dt select`
- Provide concise help for unknown/no-op cases.

## Suggested Files

```text
extensions/decision-tree/
  pi/
    commands.ts
    command-format.ts
```

## Command Routing

- `/dt` with no args aliases to `/dt status`.
- First arg is subcommand.
- Unknown subcommand shows short help.
- Commands should use the same core service as tools.

## `/dt init`

Behavior:

- Create `docs/.decisions/` scaffolding.
- Idempotent and non-destructive.
- Report created/existing files.
- Do not create a tree.

Output should include:

- project root
- decisions path
- index path
- session path
- whether `.gitignore` was created/existed

## `/dt status`

Show:

- initialized/not initialized
- project root
- decisions path
- active tree title/id
- active item id/path
- tree count
- brief unresolved count if cheap

If not initialized, suggest `/dt init`.

## `/dt list`

Show:

- active marker
- title
- short ID
- status
- updated_at

If no trees exist, suggest creating one through the agent/tool workflow.

## `/dt select`

Modes:

- `/dt select <id-prefix>` selects by full ID or unique prefix.
- `/dt select` with UI available opens interactive picker.
- `/dt select` without UI and without arg prints usage.

Behavior:

- Updates `session.json`.
- Defaults active item to root if previous active item is missing/invalid.
- Reports selected tree and active item path.

## Formatting

- Keep output readable in plain text.
- Use short IDs for display but preserve full IDs where needed.
- Avoid dumping full tree content in command output.

## Acceptance Criteria

- Commands are usable by humans without invoking tools manually.
- Commands do not implement separate business logic.
- `/dt status` is a quick sanity check for project state.
- `/dt select` works both interactively and with ID prefix.
