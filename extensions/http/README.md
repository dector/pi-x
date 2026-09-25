# http (pi extension)

Adds three tools powered by **Node's native fetch API**:

- `http` for regular HTTP requests
- `http_md` for webpage → Markdown conversion (via local `pandoc`)
- `web_search` for DuckDuckGo HTML search result extraction

Each tool can also read overflow content saved in-memory via its `memfs` field.

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
- `memfs` (`{ id, offset?, limit? }`) to read in-memory spilled output instead of making a request

## `http_md`

Fetches a webpage and converts HTML response to Markdown using:

- `pandoc -f html -t gfm`

### Structured fields

Same request fields as `http`, except no `outputFile`. It also supports `memfs` (`{ id, offset?, limit? }`) to read in-memory spilled output instead of making a request.

Additional fields:

- `webToMdMaxBytes` (default `12000`): max Markdown bytes returned inline
- `spillMode` (`in_memory` default, or `to_file`) for oversized output

If converted Markdown exceeds `webToMdMaxBytes`, output is spilled according to `spillMode`:

- `in_memory`: saved to memoryfs with an ID (read via `http_md` with `memfs: { id }`)
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

- `query` (required unless `memfs` is present)
- `page` (default `1`) — start page, 1-indexed
- `pages` (default `1`, max `10`) — number of pages to fetch from `page`
- `resultsPerPage` (default `30`) — used to compute page offsets
- `timeoutSec` — per-page timeout
- `spillMode` (`in_memory` default, or `to_file`) for oversized output
- `followRedirects` (default `true`)
- `memfs` (`{ id, offset?, limit? }`) to read in-memory spilled output instead of making a search request

### Output

Returns JSON with:

- query/page metadata
- merged `results` across requested pages
- optional `warnings`
- optional `errorsByPage` for partial failures

## Memoryfs reads

Reads content previously spilled to in-memory storage through the tool that needs it:

```json
{
  "memfs": {
    "id": "mem-...",
    "offset": 1,
    "limit": 200
  }
}
```

Fields:

- `id` (required): memoryfs entry ID returned by `http`/`http_md`/`web_search`
- `offset` (default `1`): line number to start from (1-indexed)
- `limit` (default `200`, max `2000`): maximum lines returned

When `memfs` is present, it cannot be combined with request/search fields.

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

## Permissions

`http` registers as a hub `perm:tool` provider and owns the non-network risk
rules for `http`, `http_md`, and `web_search` (output files, memfs reads). The
actual network decision is requested from `permissions-core` through the hub
`perm:net` capability, so method trust and policy live in one place.

Filesystem rules for `http` output files (`outputFile`, `curlArgs` `-o`,
`curlArgs` `--output`), by safe-mode mode:

| Mode | Inside project root | Outside project root |
|---|---|---|
| `reader` / `smart` | ask | ask |
| `yolo` | allow | ask |
| `yolo+` (`yolo` with `outerAccess=true`) | allow | allow |

A missing or malformed `outerAccess` in the `perm:tool` data fails closed to
`false`, so the outside-project ask stays. `http_md` `spillMode: "to_file"`
keeps requiring approval in every mode, including `yolo+`.

Classification is not enforcement. Because the nested `perm:tool -> perm:net`
flow only runs when safe-mode *and* the hub are present, each real network
operation also requires a one-time execution authorization ticket:

1. `safe-mode` asks the hub for `perm:tool`, including the
tool call id in the data.
2. `http` revokes any stale ticket for that id, then validates and normalizes
the request. MemoryFS-only reads skip the network request entirely; invalid
requests store nothing.
3. `http` sends the normalized `{ toolName, operation, url, method, query? }`
request to `perm:net` and merges the answer with the filesystem decision
(most restrictive wins). A missing, timed-out, or malformed provider blocks.
4. Only after that complete merge, and only for an `allow`/`confirm` result,
`http` stores a pending (unauthorized) ticket immediately before sending its
provider reply. A merged `block` stores nothing. Storing the ticket after
classification means a safe-mode timeout fallback emitted while the request is
still in flight is missed and the late ticket stays unauthorized.
5. If and only if safe-mode's final decision is `allow` (provider allow or a
successful user approval), safe-mode emits
`px:safe-mode:tool-authorized` with the same id *and* `source: "safe-mode"`.
A provider `allow` alone never authorizes anything: hub arbitration, PARANOID,
outer-access confirmation, a denied prompt, or a non-interactive block still
prevent it, and a handoff without the safe-mode source is ignored.
6. The actual `execute()` consumes the ticket exactly once after re-normalizing
the arguments and confirming they did not change. The fingerprint covers all
output-affecting options, including `spillMode` and (for `http_md`)
`webToMdMaxBytes`, so changing an option invalidates the approval. MemoryFS-only
reads bypass this gate.

Consequences (all fail closed):

- hub absent, safe-mode absent, or a direct tool call with no `tool_call` flow;
- `perm:net` timeout or malformed answer;
- denied confirmation or a confirmation with no UI;
- changed parameters between preflight and execution, including `spillMode` or
  `webToMdMaxBytes`;
- a replayed or mismatched call id;
- a timeout fallback handoff that arrives before the late ticket is stored, or
  a handoff that is not sourced from safe-mode.

Tickets are bounded (TTL + count) and cleared on session start/tree/shutdown and
on `/new`. Authorizing a ticket refreshes its TTL so an approved request does not
expire while a delayed tool call is still waiting.

Approval summaries are built from the normalized request and are sanitized:
URL userinfo is stripped and control characters are removed, so a prompt never
echoes credentials or terminal escapes.

See [`../hub/PROTOCOL.md`](../hub/PROTOCOL.md) and
[`../permissions-core/README.md`](../permissions-core/README.md).

## Network scope

Only `http`, `http_md`, and `web_search` request `perm:net`. Network traffic
from other extensions or tools (shell commands, Git remotes, package managers,
MCP/custom tools, direct extension fetch) is **not** covered in V1. See
[`../permissions-core/README.md`](../permissions-core/README.md) for the model,
matrix, and known gaps.

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/http/`
- Project-local: `.pi/extensions/http/`

Then run `/reload`.
