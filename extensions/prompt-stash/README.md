# prompt-stash

Save and restore in-progress prompt drafts inside the current pi session.

## Commands

- `/prompt-stash.stash` — save the current editor text and clear the editor.
- `/prompt-stash.pop` — restore and remove the newest stash.
- `/prompt-stash.pop-choose` — choose a stash to restore and remove.
- `/prompt-stash.list` — show stashes newest-first without changing them.
- `/prompt-stash.clear-all` — delete every stash after confirmation.

## Shortcuts

- `Ctrl+Alt+S` — stash current editor draft.
- `Ctrl+Alt+Shift+S` — pop newest stash.

## Notes

Stashes are stored as custom session entries with type `prompt-stash`. They are session-scoped and branch-aware. Prompt text is not shown in full in list output or custom entry rendering.

When restoring over a non-empty editor, prompt-stash asks whether to stash the current editor first, replace it, or cancel.
