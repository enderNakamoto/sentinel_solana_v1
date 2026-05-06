#!/usr/bin/env bash
# scripts/run.sh
#
# Bundle a TS script via esbuild and run the resulting .mjs via Node.
# Used by package.json scripts (`pnpm deploy`, `pnpm fund-sol`, the
# Phase 8/9/10 cron runners, etc.) to side-step Node 24's native
# `--experimental-strip-types` not handling Codama-generated directory
# imports (`export * from "./accounts"` without `/index.ts`).
#
# Usage: bash scripts/run.sh <script-name> [args...]
#
# Resolution order for <script-name>:
#   1. scripts/<script-name>.ts             — root scripts (Phase 7)
#   2. executor/src/scripts/<script-name>.ts — cron runners (Phase 8+)
#
# Bundles to <src-dir>/dist/<script-name>.mjs and `exec node`s it.
# Args after the script name pass through verbatim.

set -euo pipefail

SCRIPT="${1:-}"
if [[ -z "$SCRIPT" ]]; then
  echo "Usage: bash scripts/run.sh <script-name> [args...]" >&2
  exit 1
fi
shift

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pick the source file location.
if [[ -f "$REPO_ROOT/scripts/$SCRIPT.ts" ]]; then
  SRC="$REPO_ROOT/scripts/$SCRIPT.ts"
  DIST_DIR="$REPO_ROOT/scripts/dist"
elif [[ -f "$REPO_ROOT/executor/src/scripts/$SCRIPT.ts" ]]; then
  SRC="$REPO_ROOT/executor/src/scripts/$SCRIPT.ts"
  DIST_DIR="$REPO_ROOT/executor/src/scripts/dist"
else
  echo "[run.sh] script not found: tried scripts/$SCRIPT.ts and executor/src/scripts/$SCRIPT.ts" >&2
  exit 1
fi

OUT="$DIST_DIR/$SCRIPT.mjs"
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
