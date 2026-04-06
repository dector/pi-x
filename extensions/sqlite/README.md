# sqlite (pi extension)

Adds a `sqlite` tool for querying SQLite databases with either:

- file-backed DB (`database` path), or
- in-memory DB (`memory: true`)

## Tool

### `sqlite`

Parameters:

- `action`: currently only `"query"`
- `database?`: file path to SQLite DB
- `memory?`: set `true` to use `:memory:`
- `sql`: SQL statement or script
- `params?`: positional values for `?1`, `?2`, ...
- `timeoutSec?`: query timeout in seconds

Validation:

- exactly one target mode (`database` xor `memory=true`)
- non-empty SQL
- database path rejects NUL/newline characters
- params must be scalar values (`string | number | boolean | null`)

Notes:

- read-only queries run sqlite3 with `-readonly`
- mutating/unknown queries run without `-readonly`
- output is JSON mode (`sqlite3 -json`)
- oversized output is truncated with a metadata notice

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/sqlite/`
- Project-local: `.pi/extensions/sqlite/`

Then run `/reload`.
