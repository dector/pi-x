# notes (pi extension)

Save free-form notes globally and browse them from a two-pane dialog.

Notes are plain Markdown files stored under `~/.pi/agent/notes/` (one file per
note), so they survive across projects and sessions and can be edited with any
editor.

## Commands

- `/px:notes` — open a multi-line note editor.
- `/px:notes:list` — browse saved notes and copy the selected one.

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
| `ctrl+x` `ctrl+x` | Clear the editor. The second press must come within 500 ms of the first. |
| `enter` | Insert a newline (this editor does not submit). |
| `esc` | Close. If there are unsaved changes, asks for `y`/`n` confirmation first. |

The dialog stays open after saving, so you can keep editing and save again to
update the same file.

## `/px:notes:list` dialog

| Key | Action |
| --- | --- |
| `tab` | Cycle current project → Global → all projects → current project. |
| `up` / `down` or `j` / `k` | Select a note in the left list. |
| `shift+j` / `shift+k` | Scroll the note content by 5 lines. |
| `ctrl+c` or `y` | Copy the selected note (raw Markdown) to the clipboard. |
| `g` | Ask for `y`/`n` confirmation, then move a current-project note to Global or a Global note to the current project. Notes from other projects cannot be moved while viewing all projects. |
| `d` | Ask for `y`/`n` confirmation, then move the selected note to recoverable storage. |
| `u` | Undo the most recent deletion made in this open list. |
| `esc` | Close. |

The list shows notes newest-first by modification time. It opens in the current
project view, matching the exact `ctx.cwd` folder recorded when each note is
first saved. Press `tab` to cycle through current-project, Global, and
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
column shows the full content of the selected note.

## Notes

- Notes are human-only: the extension registers no tools and adds nothing to the
  LLM context.
- The clipboard uses pi's built-in `copyToClipboard`, which works with native
  clipboard, OSC 52 over SSH, and Termux.
- This extension requires TUI mode; in non-interactive sessions the commands
  only emit a notification.
