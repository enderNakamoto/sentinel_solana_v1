#!/usr/bin/env bash
# scripts/install-toolchain.sh
#
# One-time installer for the Sentinel Solana developer toolchain.
# Idempotent — re-running skips anything already present.
#
# Installs:
#   - Solana CLI (Agave) latest stable     → ~/.local/share/solana/
#   - Anchor CLI v1.0.0 (from source)      → ~/.cargo/bin/
#   - Surfpool latest                       → ~/.cargo/bin/
#   - Default keypair at ~/.config/solana/id.json (if missing)
#
# Updates:
#   - ~/.zshrc and ~/.bashrc with Solana CLI PATH line (append once, idempotent)
#
# Approximate runtime on a typical Mac with broadband:
#   - Solana CLI:   ~1-3 minutes (binary download)
#   - Anchor v1:    ~5-12 minutes (source compile)
#   - Surfpool:     ~3-8 minutes (source compile)
#   - Total:        ~10-25 minutes
#
# Run from anywhere:
#   bash /path/to/sentinel_solana/scripts/install-toolchain.sh

set -euo pipefail

# ─── macOS workaround: disable cross-language LTO ─────────────────────────
# Rust 1.94 emits LLVM 21 bitcode; Apple's libLTO (shipped with older Xcode
# Command Line Tools) is LLVM 17 and rejects new attribute kinds. Anchor's
# release profile uses `lto = "fat"`, which triggers the linker LTO pass
# and exposes the mismatch.
#
# Disabling LTO via env var sidesteps the issue without modifying upstream
# Cargo.toml. The resulting CLI binaries are slightly larger / slower —
# irrelevant for dev tools.
export CARGO_PROFILE_RELEASE_LTO=off
export CARGO_PROFILE_RELEASE_EMBED_BITCODE=no

# ─── Helpers ──────────────────────────────────────────────────────────────
log()  { printf '\n\033[1;36m[install-toolchain]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install-toolchain] WARN:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[install-toolchain] ERROR:\033[0m %s\n' "$*" >&2; }

SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
PATH_LINE='export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"'

ensure_path_in_rc() {
  local rc="$1"
  [[ -f "$rc" ]] || touch "$rc"
  if ! grep -qF "$PATH_LINE" "$rc"; then
    {
      echo ""
      echo "# Added by sentinel_solana/scripts/install-toolchain.sh"
      echo "$PATH_LINE"
    } >> "$rc"
    log "Appended Solana PATH to $rc"
  else
    log "Solana PATH already in $rc — skipping"
  fi
}

# Make Solana CLI available in this script's PATH for verification calls.
add_solana_to_path_now() {
  if [[ -d "$SOLANA_BIN" ]]; then
    export PATH="$SOLANA_BIN:$PATH"
  fi
}

# ─── 0. Pre-flight ────────────────────────────────────────────────────────
log "Pre-flight check..."
for tool in cargo rustc; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    err "$tool not found in PATH. Install Rust first: https://rustup.rs/"
    exit 1
  fi
done
log "rust  $(rustc --version)"
log "cargo $(cargo --version)"

# ─── 1. Solana CLI (Agave) ────────────────────────────────────────────────
add_solana_to_path_now

if command -v solana >/dev/null 2>&1; then
  log "Solana CLI already installed: $(solana --version)"
else
  log "Installing Solana CLI (Agave) latest stable..."
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
  add_solana_to_path_now
  if ! command -v solana >/dev/null 2>&1; then
    err "Solana install completed but \`solana\` still not on PATH. Try opening a new shell."
    exit 1
  fi
  log "Solana CLI installed: $(solana --version)"
fi

# Persist PATH for future shells.
ensure_path_in_rc "$HOME/.zshrc"
ensure_path_in_rc "$HOME/.bashrc"

# ─── 2. Default keypair ───────────────────────────────────────────────────
KEYPAIR="$HOME/.config/solana/id.json"
if [[ -f "$KEYPAIR" ]]; then
  log "Default keypair already exists: $KEYPAIR"
else
  log "Generating default keypair at $KEYPAIR..."
  mkdir -p "$(dirname "$KEYPAIR")"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$KEYPAIR"
  log "Default keypair generated: $(solana-keygen pubkey "$KEYPAIR")"
fi

# Default cluster → devnet (safe; never mainnet without explicit user action).
solana config set --url devnet >/dev/null
log "Solana CLI cluster set to devnet"

# ─── 3. Anchor CLI v1 ─────────────────────────────────────────────────────
if command -v anchor >/dev/null 2>&1 && anchor --version 2>/dev/null | grep -q '1\.'; then
  log "Anchor CLI already installed: $(anchor --version)"
else
  log "Installing Anchor CLI v1.0.0 from source (~5–12 min)..."
  cargo install \
    --git https://github.com/solana-foundation/anchor \
    --tag v1.0.0 \
    anchor-cli \
    --locked
  if ! command -v anchor >/dev/null 2>&1; then
    err "anchor binary not on PATH after install. Check ~/.cargo/bin is on PATH."
    exit 1
  fi
  log "Anchor CLI installed: $(anchor --version)"
fi

# ─── 4. Surfpool ──────────────────────────────────────────────────────────
# Surfpool is NOT a working crates.io binary — `cargo install surfpool` fails
# with "there is nothing to install" (crates.io 0.1.0 is a placeholder).
# Use the official installer at run.surfpool.run, which drops a prebuilt
# binary into ~/.local/bin or wherever the script chooses.
SURFPOOL_LOCAL_BIN="$HOME/.local/bin"
if [[ -d "$SURFPOOL_LOCAL_BIN" ]]; then
  export PATH="$SURFPOOL_LOCAL_BIN:$PATH"
fi

if command -v surfpool >/dev/null 2>&1; then
  log "Surfpool already installed: $(surfpool --version 2>/dev/null || echo 'unknown')"
else
  log "Installing Surfpool via official installer..."
  curl -sL https://run.surfpool.run/ | bash
  # The installer typically puts the binary under ~/.local/bin (or similar).
  if [[ -d "$SURFPOOL_LOCAL_BIN" ]]; then
    export PATH="$SURFPOOL_LOCAL_BIN:$PATH"
  fi
  if ! command -v surfpool >/dev/null 2>&1; then
    err "surfpool binary not on PATH after install. Check the installer output above."
    err "If it landed somewhere unusual, add that dir to your shell PATH."
    exit 1
  fi
  log "Surfpool installed: $(surfpool --version 2>/dev/null || echo 'unknown')"
fi

# ─── 5. Final summary ─────────────────────────────────────────────────────
log "─────────────────────────────────────────────────────────────"
log "Toolchain ready."
log ""
log "  rust       $(rustc --version)"
log "  cargo      $(cargo --version)"
log "  solana     $(solana --version)"
log "  anchor     $(anchor --version)"
log "  surfpool   $(surfpool --version 2>/dev/null || echo 'unknown')"
log "  node       $(node --version 2>/dev/null || echo 'NOT FOUND')"
log "  pnpm       $(pnpm --version 2>/dev/null || echo 'NOT FOUND')"
log ""
log "  default keypair: $(solana-keygen pubkey "$KEYPAIR")"
log "  default cluster: $(solana config get | awk '/RPC URL/ {print $3}')"
log ""
log "Open a NEW terminal (or run \`source ~/.zshrc\`) so the PATH update takes effect"
log "in interactive shells, then proceed with Phase 0 resume:"
log ""
log "  cd $(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log "  pnpm install"
log "  bash scripts/keys-bootstrap.sh"
log "  # paste the program addresses into Anchor.toml + each declare_id!()"
log "  cd contracts && NO_DNA=1 anchor build && cd .."
log "─────────────────────────────────────────────────────────────"
