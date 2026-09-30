# prompt-stash

Save and restore in-progress prompt drafts inside the current pi session.

## Commands

- `/px:prompt-stash.stash` — save the current editor text and clear the editor.
- `/px:prompt-stash.new` — compose a prompt and save it directly to the stash.
- `/px:prompt-stash.pop` — restore and remove the newest stash.
- `/px:prompt-stash.list` — show stashes newest-first; in UI, select one to restore it.
- `/px:prompt-stash.clear-all` — delete every stash after confirmation.

## UI actions

`prompt-stash` does not register default global shortcuts. If `pi-ui` is installed, use `Ctrl+,` then `s` to open the prompt-stash menu:

- `s` — stash current editor draft.
- `n` — compose a new prompt in a separate editor and save it directly to the stash.
- `o` — pop newest stash.
- `l` — list stashes; press `Enter` on one to restore it.
- `x` — clear all stashes after confirmation.
- `<-` / `Backspace` — return to the main action dialog.

## Notes

Stashes are stored as custom session entries with type `prompt-stash`. They are session-scoped and branch-aware. When stashes exist, the neo-bar editor frame's bottom-right border shows an orange `󱊖 <count>` indicator after the draft token and notes counts; it disappears when the active branch has no stashes. In legacy display mode, it appears on the status line. Prompt text is not shown in full in non-interactive list output or custom entry rendering.

When restoring over a non-empty editor, prompt-stash asks whether to stash the current editor first, replace it, or cancel.
