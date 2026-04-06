#!/usr/bin/env bash
set -euo pipefail

SOCKET_PATH="${PI_NVIM_SOCKET_PATH:-/tmp/pi-nvim-latest.sock}"
PROMPT_MESSAGE="${1:-pi-nvim smoke test $(date -u +%Y-%m-%dT%H:%M:%SZ)}"

if ! command -v socat >/dev/null 2>&1; then
  echo "error: socat is required (install socat and retry)" >&2
  exit 1
fi

if [[ ! -e "$SOCKET_PATH" ]]; then
  echo "error: socket not found: $SOCKET_PATH" >&2
  echo "hint: start pi with extensions/pi-nvim loaded" >&2
  exit 1
fi

send_json() {
  local payload="$1"
  printf '%s\n' "$payload" | socat - UNIX-CONNECT:"$SOCKET_PATH"
}

echo "[1/2] ping -> $SOCKET_PATH"
PING_RESP="$(send_json '{"type":"ping"}')"
echo "response: $PING_RESP"
if [[ "$PING_RESP" != *'"ok":true'* ]] || [[ "$PING_RESP" != *'"type":"pong"'* ]]; then
  echo "error: unexpected ping response" >&2
  exit 1
fi

echo "[2/2] prompt send"
PROMPT_PAYLOAD="$(printf '{"type":"prompt","message":%s}' "$(printf '%s' "$PROMPT_MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
PROMPT_RESP="$(send_json "$PROMPT_PAYLOAD")"
echo "response: $PROMPT_RESP"
if [[ "$PROMPT_RESP" != *'"ok":true'* ]]; then
  echo "error: unexpected prompt response" >&2
  exit 1
fi

echo "success: pi-nvim smoke test passed"
