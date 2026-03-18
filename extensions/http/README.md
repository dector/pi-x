# http (pi extension)

Adds an `http` tool that uses **Node's native fetch API** (no shelling out to curl).

## Features

- **HTTPie-like structured mode** via fields like `method`, `url`, `headers`, `query`, `json`, `form`, `body`
- **curl-compatible mode** via `curlArgs` (supported subset, with explicit errors for unsupported flags)
- **Any custom headers** via:
  - `headers` object (`{ "Authorization": "Bearer ..." }`)
  - `headerLines` array (`["X-Trace-Id: 123"]`)
- **Optional web-to-md mode** (`webToMd`) using local `pandoc`
  - checks `pandoc` availability before fetch
  - converts HTML response to Markdown (`pandoc -f html -t gfm`)
  - returns Markdown inline up to `webToMdMaxBytes`
  - spills larger Markdown to `/tmp/pi-http/web-to-md-*/result.md`

## Tool

- Name: `http`

### Structured mode (HTTPie-like)

Provide request fields directly:

- `url` (required)
- `method` (optional; defaults to `GET`, or `POST` when body is present)
- `headers` / `headerLines`
- `query`
- `json` or `form` or `body` or `stdin` (choose one)
- `followRedirects` (default `true`)
- `includeResponseHeaders` (default `true`)
- `failOnHttpError`, `timeoutSec`, `outputFile`
- `webToMd` (default `false`)
- `webToMdMaxBytes` (default `12000`)

Validation notes:

- `webToMd` and `outputFile` cannot be combined.
- `webToMdMaxBytes` must be finite and `> 0`.

### curl-compatible mode

Provide `curlArgs`:

- `curlArgs: ["-X", "POST", "https://example.com", "-H", "Authorization: Bearer ..."]`

Supported examples include common flags like:

- `-X/--request`
- `-H/--header`
- `-d/--data/--data-raw/--data-binary`
- `-L/--location`
- `-i/--include`
- `--fail/--fail-with-body`
- `-m/--max-time`
- `-o/--output`
- `--url`
- `-u/--user`

Unsupported curl flags fail fast with an explicit error message.

## web-to-md examples

### Inline Markdown (small output)

```json
{
  "url": "https://example.com",
  "webToMd": true,
  "webToMdMaxBytes": 12000
}
```

### Large Markdown spills to file

```json
{
  "url": "https://example.com/large-page",
  "webToMd": true,
  "webToMdMaxBytes": 100
}
```

Response body includes a message like:

- `[webToMd output saved to /tmp/pi-http/web-to-md-XXXXXX/result.md (34567 bytes)]`

### `pandoc` missing

If `webToMd=true` and `pandoc` is not on `PATH`, the request fails immediately before network fetch with an explicit error.

## curl → http tool cheat sheet

Use this as a quick mapping from common curl usage to `http` tool calls.

### Basic request

```bash
curl https://httpbin.org/get
```

```json
{
  "url": "https://httpbin.org/get"
}
```

### Method + JSON body

```bash
curl -X POST https://httpbin.org/post \
  -H 'Content-Type: application/json' \
  -d '{"name":"alice"}'
```

```json
{
  "url": "https://httpbin.org/post",
  "method": "POST",
  "json": {
    "name": "alice"
  }
}
```

### Form body

```bash
curl -X POST https://httpbin.org/post \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'a=1&b=2'
```

```json
{
  "url": "https://httpbin.org/post",
  "method": "POST",
  "form": {
    "a": "1",
    "b": "2"
  }
}
```

### Custom headers

```bash
curl https://httpbin.org/anything \
  -H 'Authorization: Bearer TOKEN' \
  -H 'X-Trace-Id: 123'
```

```json
{
  "url": "https://httpbin.org/anything",
  "headers": {
    "Authorization": "Bearer TOKEN"
  },
  "headerLines": ["X-Trace-Id: 123"]
}
```

### Query parameters

```bash
curl 'https://httpbin.org/get?q=pi&page=1'
```

```json
{
  "url": "https://httpbin.org/get",
  "query": {
    "q": "pi",
    "page": "1"
  }
}
```

### Follow redirects

```bash
curl -L http://httpbin.org/redirect-to?url=https://example.com
```

```json
{
  "url": "http://httpbin.org/redirect-to",
  "query": {
    "url": "https://example.com"
  },
  "followRedirects": true
}
```

### Include response headers

```bash
curl -i https://httpbin.org/get
```

```json
{
  "url": "https://httpbin.org/get",
  "includeResponseHeaders": true
}
```

### Timeout

```bash
curl --max-time 5 https://httpbin.org/delay/10
```

```json
{
  "url": "https://httpbin.org/delay/10",
  "timeoutSec": 5
}
```

### Save output to file

```bash
curl -o out.json https://httpbin.org/json
```

```json
{
  "url": "https://httpbin.org/json",
  "outputFile": "out.json"
}
```

### Basic auth

```bash
curl -u user:pass https://httpbin.org/basic-auth/user/pass
```

Structured form:

```json
{
  "url": "https://httpbin.org/basic-auth/user/pass",
  "headers": {
    "Authorization": "Basic dXNlcjpwYXNz"
  }
}
```

curl-compatible form:

```json
{
  "curlArgs": ["-u", "user:pass", "https://httpbin.org/basic-auth/user/pass"]
}
```

### Use curl-compatible args directly

```bash
curl -X POST https://httpbin.org/post -H 'Authorization: Bearer TOKEN' -d '{"ok":true}'
```

```json
{
  "curlArgs": [
    "-X", "POST",
    "https://httpbin.org/post",
    "-H", "Authorization: Bearer TOKEN",
    "-d", "{\"ok\":true}"
  ]
}
```

## Notes

- Output is truncated to pi defaults (**50KB** / **2000 lines**). If truncated, full output is saved to a temp file and path is returned.
- `insecure` / `--insecure` is currently ignored in fetch mode and reported as a warning.
- web-to-md spill files are intentionally written under `/tmp/pi-http` to avoid excessive inline token usage for large pages.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/http/`
- Project-local: `.pi/extensions/http/`

Then run `/reload`.
