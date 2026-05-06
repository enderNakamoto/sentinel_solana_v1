#!/usr/bin/env bash
# scripts/run.sh
#
# Bundle a TS script in scripts/<name>.ts via esbuild and run the resulting
# .mjs via Node. Used by package.json scripts (`pnpm deploy`, `pnpm fund-sol`,
# etc.) to side-step Node 24's native --experimental-strip-types not handling
# the directory imports that Codama-generated clients use (`export * from "./accounts"`
# without a /index.ts suffix).
#
# Why bundle? `tsx` works for inline `tsx -e "..."` but defers to Node's native
# loader for files when package.json has `type: module`, and Node's native
# loader rejects directory-extension-less imports. esbuild handles them
# correctly during bundling and emits a single ESM file Node loads cleanly.
#
# Usage: bash scripts/run.sh <script-name> [args...]
#
# Bundles scripts/<script-name>.ts → scripts/dist/<script-name>.mjs, then
# runs via `exec node`. Args after the script name pass through verbatim.

set -euo pipefail

SCRIPT="${1:-}"
if [[ -z "$SCRIPT" ]]; then
  echo "Usage: bash scripts/run.sh <script-name> [args...]" >&2
  exit 1
fi
shift

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/scripts/$SCRIPT.ts"
DIST_DIR="$REPO_ROOT/scripts/dist"
OUT="$DIST_DIR/$SCRIPT.mjs"

if [[ ! -f "$SRC" ]]; then
  echo "[run.sh] not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"

"$REPO_ROOT/node_modules/.bin/esbuild" "$SRC" \
  --bundle \
  --platform=node \
  --format=esm \
  --packages=external \
  --target=node22 \
  --outfile="$OUT" \
  --log-level=warning

exec node "$OUT" "$@"
