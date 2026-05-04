# Sentinel Protocol — Solana

Decentralised flight delay insurance on Solana. Underwriters deposit USDC to back claims; travelers pay a premium and receive a fixed payoff if their flight is delayed beyond a per-route threshold.

See:
- `spec/architecture.md` — full system architecture
- `spec/dev_steps.md` — phased build plan
- `spec/workflow.md` — phase lifecycle / agent commands
- `CLAUDE.md` — locked stack, hard rules

---

## Stack (locked)

| Layer | Tool |
|---|---|
| On-chain programs | **Anchor** (v1.x latest stable) |
| Client SDK | **`@solana/kit`** + `@solana-program/*` |
| Frontend / wallet | **framework-kit** (`@solana/client` + `@solana/react-hooks`, Wallet Standard) |
| Typed program clients | **Codama** (generated from Anchor IDL) |
| Unit tests | **LiteSVM** (TypeScript) |
| Integration tests | **Surfpool** (local Surfnet) |
| Package manager | **pnpm workspaces** |

5 programs: `governance`, `vault`, `flight_pool`, `oracle_aggregator`, `controller`.

---

## Repo layout

```
sentinel_solana/
├── contracts/             # Anchor workspace — 5 programs
│   ├── programs/
│   │   ├── governance/
│   │   ├── vault/
│   │   ├── flight_pool/
│   │   ├── oracle_aggregator/
│   │   └── controller/
│   └── tests/             # LiteSVM unit + Surfpool integration
├── frontend/              # Next.js dApp (App Router + framework-kit)
├── executor/              # Off-chain cron backend (Phase 8+)
├── scripts/               # sync-idl, gen-clients, dev-surfpool, keys-bootstrap
├── keys/                  # Public keypairs (*.pubkey committed; *.json gitignored)
├── spec/                  # Architecture, phase plans, progress
├── Anchor.toml            # Anchor workspace config (program IDs pinned here)
├── Surfpool.toml          # Surfnet config (mock USDC seed)
└── package.json           # Root scripts
```

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Rust** | 1.79+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Solana CLI** (Agave) | 3.x | `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"` |
| **Anchor CLI** | 1.0.x | `cargo install --git https://github.com/solana-foundation/anchor --tag v1.0.0 anchor-cli --locked` (or via [`avm`](https://www.anchor-lang.com/docs/installation#anchor-version-manager-avm)) |
| **Node.js** | 20+ LTS | [nvm](https://github.com/nvm-sh/nvm) recommended |
| **pnpm** | 9+ | `corepack enable && corepack prepare pnpm@9.9.0 --activate` |
| **Surfpool** | latest | `cargo install surfpool` (⏱ ~3–5 min on first run; downloads & compiles) |

After installing the Solana CLI, ensure `~/.config/solana/id.json` exists:

```bash
solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/id.json
solana config set --url devnet
```

Resolved versions for this repo (recorded 2026-05-04):

```
Rust:        1.94.0
Cargo:       1.94.0
Solana CLI:  3.1.14 (Agave)
Anchor CLI:  1.0.0
Surfpool:    1.2.0
Node:        24.11.0
pnpm:        9.9.0
```

**macOS note:** Anchor v1 + Rust 1.94 produces LLVM 21 bitcode that older Xcode `libLTO` (LLVM 17) cannot link. The install script sets `CARGO_PROFILE_RELEASE_LTO=off` to sidestep this. If you re-build Anchor or Surfpool from source manually, export the same env var first.

---

## One-command bring-up

```bash
pnpm install
pnpm sync-idl       # runs anchor build + copies IDL JSON into frontend/ + executor/
pnpm gen-clients    # runs Codama, emits typed Kit clients
pnpm dev:frontend   # Next.js on http://localhost:3000
```

In another terminal for integration tests:

```bash
pnpm dev:surfpool   # local Surfnet on http://127.0.0.1:8899
pnpm test:integration
```

---

## Local development

### Mock USDC mint (single, shared across envs)

A single mock USDC mint is committed via its keypair (`keys/mock-usdc.json`, gitignored) so the same mint pubkey is reused across LiteSVM unit tests, Surfpool integration tests, and devnet deploys. Public addresses are committed at:

- `keys/mock-usdc.pubkey` — mint address
- `keys/mock-usdc-authority.pubkey` — mint authority address
- `keys/executor.pubkey` — oracle/keeper signer address

Hardcoded into all instruction builders so tests and devnet share the same `Address`. Bootstrap or rotate via:

```bash
bash scripts/keys-bootstrap.sh
```

The script is idempotent — it skips any keypair file that already exists.

### Devnet smoke

```bash
solana airdrop 5 --url devnet
pnpm sync-idl && pnpm gen-clients
pnpm dev:executor   # builds Kit client against $SOLANA_RPC_URL, exits 0
```

---

## Agent CLI conventions

When this repo is driven by Claude Code or another agent, all CLI invocations are prefixed with `NO_DNA=1` to disable interactive prompts. See `CLAUDE.md` and [no-dna.org](https://no-dna.org).

```bash
NO_DNA=1 anchor build
NO_DNA=1 surfpool start
```

---

## Phase status

See `spec/progress.md` for the live phase dashboard. Each phase has its own plan + work log under `spec/phases/`.

Run `/plan-phase N` to plan, `/start-phase N` to execute, `/complete-phase N` after validation.
