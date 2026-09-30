# notes (pi extension)

Save free-form notes globally and browse them from a two-pane dialog.

Notes are plain Markdown files stored under `~/.pi/agent/notes/` (one file per
note), so they survive across projects and sessions and can be edited with any
editor. When notes are available, neo-bar shows a muted-purple `󰈙 <count>` in the
bottom-right editor border between the draft token and stash counters. It counts global and
current-project notes, and refreshes after closing a notes dialog.

## Commands

- `/px:notes` — open a multi-line note editor.
- `/px:notes:list` — browse saved notes, copy or apply the selected one.

## pi-ui integration

When the [pi-ui](../pi-ui) extension is enabled, the same dialogs are also
reachable from its `Ctrl+,` action dialog:

- `n` — open the `/px:notes` editor (pi-ui emits the `px:notes:open` event).
- `N` — open the `/px:notes:list` browser (pi-ui emits the `px:notes:list` event).

Both events carry `{ ctx }` in their payload, matching the convention used by
`safe-mode` and `prompt-stash`.

## `/px:notes` dialog

| Key | Action |
| --- | --- |
| `ctrl+s` | Save. The first save creates a note; later saves in the same dialog update it. |
| `ctrl+g` | Toggle between Current project and Global scope. The current scope is always shown in the editor. Before the first save, this chooses the new note's scope; afterward, it updates the saved note's metadata immediately without changing its Markdown. |
| `ctrl+x` `ctrl+x` | Clear the editor. The second press must come within 500 ms of the first. |
| `enter` | Insert a newline (this editor does not submit). |
| `esc` | Close. If there are unsaved changes, asks for `y`/`n` confirmation first. |

The dialog stays open after saving, so you can keep editing and save again to
update the same file. Global notes have no project metadata sidecar. Changing
scope is independent of editor text and does not make the note appear unsaved.

## `/px:notes:list` dialog

| Key | Action |
| --- | --- |
| `n` | Open a blank note editor. Closing the editor returns to the list, including when the list was empty. |
| `N` | When the prompt is non-empty, open a new note editor prefilled with the prompt text. This action is hidden and does nothing when the prompt is blank. |
| `enter` | Preview the selected note. In the preview, press `e` to edit it or `esc` to return to the list. |
| `}` or `tab` | Cycle current project → Global → all projects → current project. |
| `up` / `down` or `j` / `k` | Select a note in the left list. |
| `shift+j` / `shift+k` | Scroll the note content by 5 lines. |
| `ctrl+c` or `y` | Copy the selected note (raw Markdown) to the clipboard. |
| `shift+a` (`A`) | Close the list and put the selected note into the prompt if the prompt is empty. Otherwise, show a warning and leave the prompt unchanged. Applied notes show `[Applied]` before their title when the list is reopened. |
| `g` | Ask for `y`/`n` confirmation, then move a current-project note to Global or a Global note to the current project. Notes from other projects cannot be moved while viewing all projects. |
| `d` | Ask for `y`/`n` confirmation, then move the selected note to recoverable storage. |
| `u` | Undo the most recent deletion made in this open list. |
| `esc` | Close. |

The list shows notes newest-first by modification time. It opens in the current
project view, matching the exact `ctx.cwd` folder recorded when each note is
first saved. Press `}` or `tab` to cycle through current-project, Global, and
all-projects views. Global contains notes with no cwd metadata, including legacy
notes; moving a note between Global and the current project changes only its
hidden metadata sidecar, never its Markdown. In all-projects view, `g` only
moves Global notes or notes belonging to the current project. All views exclude
soft-deleted notes.

Project metadata is stored in hidden sidecar files under
`~/.pi/agent/notes/.metadata/`; note files remain plain Markdown with no
frontmatter. Deleted notes and their sidecars move together under
`~/.pi/agent/notes/.trash/`. `u` restores the latest deletion from the current
list dialog. Undo refuses to overwrite a note recreated at its original path,
and metadata remains recoverable if undo fails.

The left column shows
the first non-empty line of each note (truncated to 80 characters); the right
column shows the content of the selected note. The full-width preview can be
scrolled with `up`/`down` or `j`/`k`. Editing an existing note saves back to the
same file.

## Notes

- The extension registers no tools. Notes enter the LLM context only if you apply
  one to the prompt and submit it.
- The clipboard uses pi's built-in `copyToClipboard`, which works with native
  clipboard, OSC 52 over SSH, and Termux.
- This extension requires TUI mode; in non-interactive sessions the commands
  only emit a notification.
