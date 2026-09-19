# save (pi extension)

Adds a `/save` command that writes the latest assistant response to a file.

## Usage

- `/save`
  - Saves to default filename with current local date/time, e.g. `pi-2026-04-06-14-32-10.md`
- `/save file.md`
  - Saves to the provided path (relative to current cwd, unless absolute)

## Behavior

- Finds the latest assistant message in the current session branch.
- Extracts text content blocks from that message.
- Writes the result to disk as UTF-8 Markdown.
- If no assistant response exists yet, shows a warning.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/save/`
- Project-local: `.pi/extensions/save/`

Then run `/reload`.
