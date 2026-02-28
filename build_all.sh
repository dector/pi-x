#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

build_extension() {
  local name="$1"
  local src="./extensions/${name}/index.ts"
  local out="./extensions/${name}/dist/index.js"

  if [[ ! -f "$src" ]]; then
    echo "[skip] ${name}: missing ${src}"
    return 0
  fi

  mkdir -p "./extensions/${name}/dist"
  echo "[build] ${name} -> ${out}"

  bun build "$src" \
    --outfile "$out" \
    --target=node \
    --format=esm \
    --packages=bundle \
    --external @mariozechner/pi-coding-agent \
    --external @mariozechner/pi-tui
}

# Add extension directory names here as needed.
EXTENSIONS=(
  "switch-thinking"
)

for ext in "${EXTENSIONS[@]}"; do
  build_extension "$ext"
done

echo "Done."
