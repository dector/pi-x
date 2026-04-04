# http (pi extension)

Adds four tools powered by **Node's native fetch API**:

- `http` for regular HTTP requests
- `http_md` for webpage → Markdown conversion (via local `pandoc`)
- `web_search` for DuckDuckGo HTML search result extraction
- `read_memoryfs` for reading overflow content saved in-memory

## Tools

## `http`

HTTP client with:

- **Structured mode** (`url`, `method`, `headers`, `query`, `json`, `form`, `body`, ...)
- **curl-compatible mode** (`curlArgs`, supported subset)
- Optional response body output to file via `outputFile`

### Structured fields

- `url` (required)
- `method` (optional; defaults to `GET`, or `POST` when body is present)
- `headers` / `headerLines`
- `query`
- exactly one of: `json`, `form`, `body`, `stdin`
- `followRedirects` (default `true`)
- `includeResponseHeaders` (default `true`)
- `failOnHttpError`
- `timeoutSec`
- `spillMode` (`in_memory` default, or `to_file`)
- `outputFile`
- `curlArgs`

## `http_md`

Fetches a webpage and converts HTML response to Markdown using:

- `pandoc -f html -t gfm`

### Structured fields

Same request fields as `http`, except no `outputFile`.

Additional fields:

- `webToMdMaxBytes` (default `12000`): max Markdown bytes returned inline
- `spillMode` (`in_memory` default, or `to_file`) for oversized output

If converted Markdown exceeds `webToMdMaxBytes`, output is spilled according to `spillMode`:

- `in_memory`: saved to memoryfs with an ID (read via `read_memoryfs`)
- `to_file`: saved to `/tmp/pi-http/web-to-md-*/result.md`

### Validation notes

- `webToMdMaxBytes` must be finite and `> 0`.
- `outputFile` / `-o` / `--output` are not supported in `http_md`.

### `pandoc` requirement

`http_md` requires `pandoc` to be available on `PATH` and fails fast if missing.

## `web_search`

Searches DuckDuckGo's HTML endpoint and parses result DOM nodes.

Returns only:

- `url`
- `title`
- `description`

### Fields

- `query` (required)
- `page` (default `1`) — start page, 1-indexed
- `pages` (default `1`, max `10`) — number of pages to fetch from `page`
- `resultsPerPage` (default `30`) — used to compute page offsets
- `timeoutSec` — per-page timeout
- `spillMode` (`in_memory` default, or `to_file`) for oversized output
- `followRedirects` (default `true`)

### Output

Returns JSON with:

- query/page metadata
- merged `results` across requested pages
- optional `warnings`
- optional `errorsByPage` for partial failures

## `read_memoryfs`

Reads content previously spilled to in-memory storage.

### Fields

- `id` (required): memoryfs entry ID returned by `http`/`http_md`/`web_search`
- `offset` (default `1`): line number to start from (1-indexed)
- `limit` (default `200`, max `2000`): maximum lines returned

## curl-compatible mode

Supported subset includes:

- `-X/--request`
- `-H/--header`
- `-d/--data/--data-raw/--data-binary`
- `-L/--location`
- `-i/--include`
- `--fail/--fail-with-body`
- `-m/--max-time`
- `-o/--output` (only `http`)
- `--url`
- `-u/--user`

Unsupported curl flags fail with explicit errors.

## Notes

- Tool rows use collapsed preview mode by default (first few lines). Press `Ctrl+O` to expand and view the full tool output inline.
- Output is truncated to pi defaults (**50KB** / **2000 lines**).
- Oversized output spill behavior is controlled by `spillMode`:
  - `in_memory` (default): stores full output in this extension's memoryfs and returns an ID
  - `to_file`: stores full output in a temp file and returns the path
- Memoryfs data is process-local and ephemeral (cleared on restart/reload and on `/new`).
- Memoryfs eviction policy: entries expire after ~1 hour and total cache is capped at ~30MB (oldest entries evicted first).
- `insecure` / `--insecure` is ignored in fetch mode and reported as a warning.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/http/`
- Project-local: `.pi/extensions/http/`

Then run `/reload`.
