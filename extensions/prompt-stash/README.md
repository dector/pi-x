# prompt-stash

Save and restore in-progress prompt drafts inside the current pi session.

## Commands

- `/prompt-stash.stash` — save the current editor text and clear the editor.
- `/prompt-stash.pop` — restore and remove the newest stash.
- `/prompt-stash.list` — show stashes newest-first; in UI, select one to restore it.
- `/prompt-stash.clear-all` — delete every stash after confirmation.

## UI actions

`prompt-stash` does not register default global shortcuts. If `pi-ui` is installed, use `Ctrl+,` then `s` to open the prompt-stash menu:

- `s` — stash current editor draft.
- `o` — pop newest stash.
- `l` — list stashes; press `Enter` on one to restore it.
- `x` — clear all stashes after confirmation.
- `<-` / `Backspace` — return to the main action dialog.

## Notes

Stashes are stored as custom session entries with type `prompt-stash`. They are session-scoped and branch-aware. Prompt text is not shown in full in non-interactive list output or custom entry rendering.

When restoring over a non-empty editor, prompt-stash asks whether to stash the current editor first, replace it, or cancel.
