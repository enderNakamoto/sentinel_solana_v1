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

## Deploy runbook (Phase 7+)

A single parameterized script handles deploy + initialize + wire-up across all 5 programs on Surfpool / devnet / testnet / mainnet.

### Surfpool dev loop (recommended for local QA)

```bash
# Terminal 1: keep surfpool running
pnpm dev:surfpool

# Terminal 2: deploy + run the integration test
pnpm bootstrap-test-actors                                # generate keys/test-actors/*
pnpm run deploy --cluster surfpool --owner $(solana-keygen pubkey ~/.config/solana/id.json)
pnpm test:integration:deployed                            # multi-actor lifecycle test
```

The deploy script:
- creates the mock USDC mint at the canonical `keys/mock-usdc.pubkey` (auto-runs `spl-token create-token` on first invocation)
- deploys all 5 programs sequentially via `solana program deploy`
- initializes governance / vault / oracle_aggregator / flight_pool / controller in dependency order
- wires authorities (`vault.set_controller`, `flight_pool.set_controller`, `oracle.set_authorized_consumer`)
- emits a deployment artifact at `deployments/<cluster>-<unix-ts>.json` + `<cluster>-latest.json`
- is fully idempotent: re-running detects existing state and skips

### Devnet / testnet

```bash
# Pre-fund the deployer keypair (~10–15 SOL on devnet/testnet)
solana airdrop 5 --url devnet --keypair ~/.config/solana/id.json

# First-run: auto-creates the mock USDC mint
pnpm run deploy --cluster devnet --owner $(solana-keygen pubkey ~/.config/solana/id.json)

# Seed test actors with mock USDC
pnpm fund-usdc --cluster devnet --recipient <pubkey> --amount 10000
```

### Mainnet (gated)

```bash
# Required: --confirm-mainnet flag + typed confirmation prompt
pnpm run deploy --cluster mainnet \
                --owner <funded-pubkey> \
                --usdc EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
                --confirm-mainnet
```

The script prints a cost preview (estimated ~14 SOL) and demands you type `deploy to mainnet` before any RPC call. Mainnet refuses to use the mock USDC — `--usdc <real-pubkey>` is required.

### Funding scripts

| Script | Cluster scope | Purpose |
|---|---|---|
| `pnpm fund-sol --cluster surfpool --recipient <pk> --amount <sol>` | surfpool only | Airdrop SOL via `requestAirdrop` (unlimited locally) |
| `pnpm fund-usdc --cluster <surfpool\|localnet\|devnet\|testnet> --recipient <pk> --amount <usdc>` | dev clusters | Mint mock USDC via the committed mint authority (`keys/mock-usdc-authority.json`) |

Mainnet has no mock-USDC mint authority — fund recipients via DEX or transfer.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `--owner ... does not match the deployer keypair ...` | Different pubkey passed than the deployer keypair holds | The deployer signs init txs and becomes config.owner. Pass `--owner <deployer-pubkey>` or use `--deployer <path-to-owner-keypair>`. |
| `Need ~X SOL, deployer ... has Y SOL on <cluster>` | Pre-flight balance check failed | Fund the deployer keypair on the target cluster (e.g. `solana airdrop 5 --url devnet`). |
| `Mock USDC not found on <cluster>` | Mint never created on this cluster | `pnpm run deploy --cluster <cluster> --owner <pk>` auto-creates it on first run. |
| `Mainnet deploys require --confirm-mainnet` | Safety guardrail | Re-run with `--confirm-mainnet` to see the cost preview. |
| Surfpool integration test skipped with warning | Surfpool not running, or no deployment artifact | `pnpm dev:surfpool` in another terminal, then `pnpm run deploy --cluster surfpool --owner <pk>`. |
| `Cannot find package '@solana/program-client-core'` | Codama runtime dep missing | `pnpm install` (root package.json includes it). |

## Running the crons (Phase 8–10)

Three off-chain crons keep the protocol ticking. Each can be invoked as a one-shot via `pnpm` or run together as a `node-cron` daemon.

| Cron | Frequency | Signing key | One-shot |
|---|---|---|---|
| **FlightDataFetcher** (Phase 8) | every 2h | `authorized_oracle` | `pnpm run-fetcher` |
| **FlightClassifier** (Phase 9) | every 1h | `authorized_keeper` | `pnpm run-classifier` |
| **SettlementExecutor** (Phase 10) | every 5min | `authorized_keeper` | `pnpm run-settler` |

### One-shot invocation

```bash
# Set env (or copy executor/.env.example → executor/.env)
export CLUSTER=surfpool
export ORACLE_KEYPAIR=keys/surfpool-oracle.json
export KEEPER_KEYPAIR=keys/surfpool-keeper.json
export AEROAPI_KEY=...

pnpm run-fetcher       # one tick of cron #1
pnpm run-classifier    # one tick of cron #2
pnpm run-settler       # one tick of cron #3
```

### Daemon mode (all 3 crons)

```bash
# Local
pnpm cron-daemon

# In Docker (built from the repo root)
docker build -t sentinel-executor -f executor/Dockerfile .
docker run --rm -p 8080:8080 \
  -e CLUSTER=devnet \
  -e ORACLE_KEYPAIR=/keys/devnet-oracle.json \
  -e KEEPER_KEYPAIR=/keys/devnet-keeper.json \
  -e AEROAPI_KEY=$AEROAPI_KEY \
  -v $(pwd)/keys:/keys:ro \
  -v $(pwd)/deployments:/app/deployments:ro \
  sentinel-executor

# Health check
curl http://127.0.0.1:8080/health
# {"ok":true,"schedules":{"fetcher":{...},"classifier":{...},"settler":{...}}}
```

The daemon shares one Solana RPC client + one AeroAPI client across all three schedules. Per-tick failures are caught + logged; the `/health` endpoint reports `ok: false` if any schedule's last run failed, letting Docker/Kubernetes orchestrators restart on persistent stuck schedules.

### Cron schedule overrides (env vars)

Useful for testing/staging:

| Var | Default | Description |
|---|---|---|
| `FETCHER_CRON` | `0 */2 * * *` | Fetcher cron expression |
| `CLASSIFIER_CRON` | `0 * * * *` | Classifier cron expression |
| `SETTLER_CRON` | `*/5 * * * *` | Settler cron expression |
| `RUN_AT_BOOT` | `0` | Set `1` to fire all 3 schedules once on startup |
| `HEALTH_PORT` | `8080` | /health server port |

## Running the e2e cron suite (Phase 11)

End-to-end validation that drives the protocol on a live Surfpool through 8
parameterized scenarios using the **real cron core functions** (`runFetcherOnce` /
`runClassifierOnce` / `runSettlerOnce`) with a mocked AeroAPI. Highest-fidelity
test we have — exercises real RPC, real Anchor programs, real Codama ixs, the
actual runner code paths. The mock AeroAPI is the only stub.

### Prerequisites

Three terminals (or one with backgrounded surfpool):

```bash
# Terminal 1: keep surfpool running
pnpm dev:surfpool

# Terminal 2: bootstrap actor keys + deploy
pnpm bootstrap-test-actors                                # idempotent
pnpm run deploy --cluster surfpool --owner $(solana-keygen pubkey ~/.config/solana/id.json)

# Terminal 3: run the e2e suite
pnpm test:e2e:crons
```

The suite skips with a clear warning if surfpool is unreachable or no
deployment artifact exists at `deployments/surfpool-latest.json`. It does NOT
auto-start surfpool or auto-deploy.

### What it validates

| # | Scenario | Validates |
|---|---|---|
| S1 | on-time landing | premium realized, vault TMA ↑ premium, locked ↓ payoff, no payout |
| S2 | delayed beyond threshold | buyer claims `PAYOFF`, vault locked ↓ |
| S3 | cancelled before ETA-seed | atomic 2-ix-in-1-tx (NotInitiated → Active → Cancelled), claim |
| S4 | cancelled after ETA-seed | single-ix `set_cancelled`, claim |
| S6 | queued withdrawal | Model B value-at-request-time, queue drains during settlement, `collect()` |
| S7 | status-string-ignored invariant | misleading `status: "Cancelled"` with `cancelled: false` ignored |
| S8 | 4xx envelope path | structured `[aero] 4xx envelope: ...` log, skip + resume next tick |
| S5 | multi-flight in single settler tick | `MAX_FLIGHTS_PER_TX=2` chunking → 2 batches for 3 flights |

### Notes

- Scenarios use timestamped flight idents (`E{runId}{i}`) to avoid PDA
  collisions across runs. Vault/governance/route state is durable.
- S5 runs **last** intentionally — the controller reallocs `ActiveFlightList`
  on every buy and Anchor v1 realloc fails to balance lamports when shrinking,
  so the suite avoids ever shrinking by keeping the multi-flight scenario at
  the end. Phase 6 D-Phase6-2 already flagged this for a future compaction ix.
- Surfpool clock advances slot-only by default; if the test ever needs cross-
  day snapshot validation, use the `surfnet_setTime` cheatcode (deferred to
  Phase 16 — browser e2e).
- Total runtime: ~38 seconds on a fresh deploy (Surfpool startup + deploy not
  counted; assume those are pre-flight).

## Phase status

See `spec/progress.md` for the live phase dashboard. Each phase has its own plan + work log under `spec/phases/`.

Run `/plan-phase N` to plan, `/start-phase N` to execute, `/complete-phase N` after validation.
