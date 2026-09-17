# notes (pi extension)

Save free-form notes globally and browse them from a two-pane dialog.

Notes are plain Markdown files stored under `~/.pi/agent/notes/` (one file per
note), so they survive across projects and sessions and can be edited with any
editor.

## Commands

- `/notes` — open a multi-line note editor.
- `/notes:list` — browse saved notes and copy the selected one.

## pi-ui integration

When the [pi-ui](../pi-ui) extension is enabled, the same dialogs are also
reachable from its `Ctrl+,` action dialog:

- `n` — open the `/notes` editor (pi-ui emits the `notes:open` event).
- `N` — open the `/notes:list` browser (pi-ui emits the `notes:list` event).

Both events carry `{ ctx }` in their payload, matching the convention used by
`safe-mode` and `prompt-stash`.

## `/notes` dialog

| Key | Action |
| --- | --- |
| `ctrl+s` | Save. The first save creates a note; later saves in the same dialog update it. |
| `ctrl+x` `ctrl+x` | Clear the editor. The second press must come within 500 ms of the first. |
| `enter` | Insert a newline (this editor does not submit). |
| `esc` | Close. If there are unsaved changes, asks for `y`/`n` confirmation first. |

The dialog stays open after saving, so you can keep editing and save again to
update the same file.

## `/notes:list` dialog

| Key | Action |
| --- | --- |
| `up` / `down` or `j` / `k` | Select a note in the left list. |
| `shift+j` / `shift+k` | Scroll the note content by 5 lines. |
| `ctrl+c` or `y` | Copy the selected note (raw Markdown) to the clipboard. |
| `esc` | Close. |

The list shows notes newest-first by modification time. The left column shows
the first non-empty line of each note (truncated to 80 characters); the right
column shows the full content of the selected note.

## Notes

- Notes are human-only: the extension registers no tools and adds nothing to the
  LLM context.
- The clipboard uses pi's built-in `copyToClipboard`, which works with native
  clipboard, OSC 52 over SSH, and Termux.
- This extension requires TUI mode; in non-interactive sessions the commands
  only emit a notification.
