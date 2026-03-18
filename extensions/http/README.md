# http (pi extension)

Adds two tools powered by **Node's native fetch API**:

- `http` for regular HTTP requests
- `http_md` for webpage → Markdown conversion (via local `pandoc`)

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
