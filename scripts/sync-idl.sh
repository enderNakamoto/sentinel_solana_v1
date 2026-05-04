#!/usr/bin/env bash
# scripts/sync-idl.sh
#
# Build the Anchor workspace and copy the resulting IDL JSON + TypeScript
# types into frontend/src/idl/ and executor/src/idl/. Both consumers
# import from those paths after Codama generates typed Kit clients via
# `pnpm gen-clients`.
#
# Wired as the `postbuild` hook in contracts/package.json. Also runnable
# manually as `pnpm sync-idl` from the repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
IDL_SRC="$CONTRACTS_DIR/target/idl"
TYPES_SRC="$CONTRACTS_DIR/target/types"

PROGRAMS=(governance vault flight_pool oracle_aggregator controller)

# Step 1: ensure the workspace is built. Skip if `target/idl/` already exists
# and contains all 5 IDLs (allows callers to skip a redundant build).
needs_build=0
for p in "${PROGRAMS[@]}"; do
  if [[ ! -f "$IDL_SRC/$p.json" ]]; then needs_build=1; break; fi
done

if [[ "$needs_build" -eq 1 ]]; then
  echo "[sync-idl] anchor build (missing IDLs)..."
  ( cd "$CONTRACTS_DIR" && NO_DNA=1 anchor build )
fi

# Step 2: copy IDLs into frontend + executor.
for target in "frontend/src/idl" "executor/src/idl"; do
  dest="$REPO_ROOT/$target"
  mkdir -p "$dest"
  for p in "${PROGRAMS[@]}"; do
    if [[ -f "$IDL_SRC/$p.json" ]]; then
      cp "$IDL_SRC/$p.json" "$dest/$p.json"
    else
      echo "[sync-idl] WARN: $IDL_SRC/$p.json missing — was anchor build successful?" >&2
    fi
    if [[ -f "$TYPES_SRC/$p.ts" ]]; then
      cp "$TYPES_SRC/$p.ts" "$dest/$p.ts"
    fi
  done
done

echo "[sync-idl] OK — synced IDLs for ${#PROGRAMS[@]} programs into frontend/ and executor/."
