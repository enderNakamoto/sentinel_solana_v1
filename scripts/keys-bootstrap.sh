#!/usr/bin/env bash
# scripts/keys-bootstrap.sh
#
# One-time idempotent generator for all Phase 0 keypair material.
# Skips any file that already exists.
#
# Generates:
#   contracts/target/deploy/<program>-keypair.json   (5 program keypairs)
#   keys/mock-usdc.json + keys/mock-usdc.pubkey
#   keys/mock-usdc-authority.json + keys/mock-usdc-authority.pubkey
#   keys/executor.json + keys/executor.pubkey
#
# After running, paste the program addresses (printed at the end) into:
#   1. contracts/Anchor.toml — [programs.localnet] and [programs.devnet]
#   2. contracts/programs/<name>/src/lib.rs — declare_id!("...")
#
# Then run `anchor build` to produce IDLs against the real program IDs.

set -euo pipefail

if ! command -v solana-keygen >/dev/null 2>&1; then
  cat <<'EOF' >&2
[keys-bootstrap] solana-keygen not found in PATH.

Install Solana CLI:
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
EOF
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS_DIR="$REPO_ROOT/keys"
DEPLOY_DIR="$REPO_ROOT/contracts/target/deploy"

mkdir -p "$KEYS_DIR" "$DEPLOY_DIR"

PROGRAMS=(governance vault flight_pool oracle_aggregator controller)
KEYS=(mock-usdc mock-usdc-authority executor)

generate_if_missing() {
  local outpath="$1"
  if [[ -f "$outpath" ]]; then
    echo "[keys-bootstrap] ✓ exists: $outpath"
    return 0
  fi
  echo "[keys-bootstrap] + generating: $outpath"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$outpath" >/dev/null
}

write_pubkey() {
  local kp_path="$1"
  local pk_path="$2"
  if [[ -f "$pk_path" ]]; then
    return 0
  fi
  solana-keygen pubkey "$kp_path" > "$pk_path"
  echo "[keys-bootstrap] + wrote: $pk_path"
}

# 1. Program keypairs (committed only via .gitignore exception? no — gitignored).
for p in "${PROGRAMS[@]}"; do
  generate_if_missing "$DEPLOY_DIR/${p}-keypair.json"
done

# 2. Mock USDC + executor keypairs in keys/
for k in "${KEYS[@]}"; do
  generate_if_missing "$KEYS_DIR/${k}.json"
  write_pubkey "$KEYS_DIR/${k}.json" "$KEYS_DIR/${k}.pubkey"
done

# 3. Print program addresses for manual paste into Anchor.toml + declare_id!.
echo ""
echo "──────────────────────────────────────────────────────────────────"
echo "Program addresses — paste into contracts/Anchor.toml AND each"
echo "program's src/lib.rs declare_id!() macro:"
echo "──────────────────────────────────────────────────────────────────"
for p in "${PROGRAMS[@]}"; do
  printf "  %-20s = %s\n" "$p" "$(solana-keygen pubkey "$DEPLOY_DIR/${p}-keypair.json")"
done
echo ""
echo "Then run:  cd contracts && NO_DNA=1 anchor build"
