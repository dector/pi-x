# http (pi extension)

Adds three tools powered by **Node's native fetch API**:

- `http` for regular HTTP requests
- `http_md` for webpage → Markdown conversion (via local `pandoc`)
- `web_search` for DuckDuckGo HTML search result extraction

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
- `outputFile`
- `curlArgs`

## `http_md`

Fetches a webpage and converts HTML response to Markdown using:

- `pandoc -f html -t gfm`

### Structured fields

Same request fields as `http`, except no `outputFile`.

Additional field:

- `webToMdMaxBytes` (default `12000`): max Markdown bytes returned inline

If converted Markdown exceeds `webToMdMaxBytes`, output is spilled to:

- `/tmp/pi-http/web-to-md-*/result.md`

and the tool returns a pointer message with the path.

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
- `followRedirects` (default `true`)

### Output

Returns JSON with:

- query/page metadata
- merged `results` across requested pages
- optional `warnings`
- optional `errorsByPage` for partial failures

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

- Output is truncated to pi defaults (**50KB** / **2000 lines**). If truncated, full output is saved to a temp file and path is returned.
- `insecure` / `--insecure` is ignored in fetch mode and reported as a warning.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/http/`
- Project-local: `.pi/extensions/http/`

Then run `/reload`.
