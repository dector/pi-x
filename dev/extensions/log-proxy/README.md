# Codex traffic proxy (dev-only)

`./pitest` loads this extension, but it does nothing unless `LOG_PROXY=1` is set. When enabled, it overrides only the **openai-codex** endpoint; Pi's Codex models and OAuth credentials are unchanged. Codex model calls route through `127.0.0.1:17381` to `https://chatgpt.com/backend-api`, even when logging is off. It forwards HTTP/SSE and WebSocket traffic without changing application payloads. Other providers and OAuth login/refresh traffic are not intercepted.

- `ror dev:proxy` — enable the proxy with capture off.
- `ror dev:proxy:init` — enable the proxy with capture on from startup.
- `/dev:log on` — capture new requests/connections.
- `/dev:log off` — stop capturing new requests/connections; forwarding continues. In-flight captures finish normally.
- `/dev:log status` — current setting.
- `LOG_PROXY=1 ./pitest` — start the proxy with capture off (default: proxy disabled).
- `LOG_PROXY=1 LOG_PROXY_INIT=1 ./pitest` — start the proxy with capture on.
- `LOG_PROXY_PORT=17382 ./pitest` — change the local listening port if necessary.

Each logging period gets **one** timestamped newline-delimited JSON file under `dev/extensions/log-proxy/logs/` (git-ignored), e.g. `2026-09-27T02-39-11-039Z-<id>.jsonl`. `/dev:log off` ends that period; the next `/dev:log on` gets a new filename. `LOG_PROXY_INIT=1` starts a period at startup when the proxy is enabled. The file is created on the first request after logging starts; in-flight captures can finish in the previous file after `off`. Read a file with `less <file>` or `jq . <file>`. Every line has a timestamp and `requestId` to correlate interleaved requests. Lines include request/response headers (including credentials), the request body, and response events. SSE lines contain the original event text in `raw` (including delimiters and whitespace), plus parsed JSON in `data` when applicable. HTTP non-SSE responses appear as `response_body`. WebSocket lines include every frame (`ws_frame`) in arrival order, decoded complete messages (`ws_message`), and control frames (`ws_control`). Negotiated `permessage-deflate` messages are decompressed for reading while original compressed frame payloads remain in `ws_frame`. Binary frame headers, which include the mask key, are `BASE64::...`; decoded frame payloads and complete messages are readable text. Invalid UTF-8 and truncated frames are marked `BASE64::...` rather than silently dropped. The per-frame header and payload can reconstruct the original wire frames.

For parsed SSE events: `jq 'select(.type == "sse_event") | .data' <file>`. For decoded WebSocket messages: `jq -r 'select(.type == "ws_message") | .data' <file>`.

The file is created with mode 0600; the directory is created with mode 0700. Logs contain prompts, responses, and authorization secrets. No automatic pruning is performed. **Existing three-file captures from older versions are left untouched.**

This captures the application-level request/response, not TLS bytes or HTTP transport framing. Extremely large streams are buffered per event/message, and logs may grow substantially. The outbound `Host` header must be changed from the local listener to `chatgpt.com`; Node may also serialize HTTP headers differently. For cached WebSocket connections, toggle logging **before** the connection starts (start with `LOG_PROXY=1 LOG_PROXY_INIT=1` for complete traffic).

Run local tests: `node --test dev/extensions/log-proxy/proxy.test.ts`. These use a fake upstream and do not use Codex credentials. A live Codex call is still needed to verify the production OAuth/streaming flow.
