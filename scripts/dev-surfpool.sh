#!/usr/bin/env bash
# scripts/dev-surfpool.sh
#
# Start a local Surfnet for integration tests. Reads `Surfpool.toml` at the
# repo root for cheatcodes (mock USDC mint seeded at the canonical pubkey).
#
# Run as: `pnpm dev:surfpool`
#
# Default Surfnet RPC: http://127.0.0.1:8899
# Default Surfnet WS:  ws://127.0.0.1:8900

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v surfpool >/dev/null 2>&1; then
  cat <<'EOF' >&2
[dev-surfpool] surfpool not found in PATH.

Install:
  cargo install surfpool      # ~3-5 min on first run

Or follow https://docs.surfpool.run/ for binary releases.
EOF
  exit 1
fi

echo "[dev-surfpool] starting Surfnet on 127.0.0.1:8899 (Ctrl-C to stop)..."
exec env NO_DNA=1 surfpool start
