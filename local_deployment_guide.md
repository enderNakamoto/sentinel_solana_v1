# Local Deployment Guide

Everything you need to run Sentinel end-to-end on your own machine — programs, frontend, cron daemon, pricing agent, and tests.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Rust** | 1.79+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Solana CLI** (Agave) | 3.x | `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"` |
| **Anchor CLI** | 1.0.x | `cargo install --git https://github.com/solana-foundation/anchor --tag v1.0.0 anchor-cli --locked` (or via [`avm`](https://www.anchor-lang.com/docs/installation#anchor-version-manager-avm)) |
| **Node.js** | 20+ LTS | [nvm](https://github.com/nvm-sh/nvm) recommended |
| **pnpm** | 9+ | `corepack enable && corepack prepare pnpm@9.9.0 --activate` |
| **Surfpool** | latest | `cargo install surfpool` (~3–5 min on first run) |
| **Python** | 3.11+ | for the Phase 22 pricing agent only |

After installing the Solana CLI, ensure `~/.config/solana/id.json` exists:

```bash
solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/id.json
solana config set --url devnet
```

**Verified versions for this repo (recorded 2026-05-04):**

```
Rust:        1.94.0
Cargo:       1.94.0
Solana CLI:  3.1.14 (Agave)
Anchor CLI:  1.0.0
Surfpool:    1.2.0
Node:        24.11.0
pnpm:        9.9.0
```

**macOS note:** Anchor v1 + Rust 1.94 emits LLVM 21 bitcode that older Xcode `libLTO` (LLVM 17) cannot link. The install script sets `CARGO_PROFILE_RELEASE_LTO=off` to sidestep this. If you re-build Anchor or Surfpool from source manually, export the same env var first.

---

## One-command bring-up

```bash
pnpm install
pnpm sync-idl       # anchor build + copy IDL JSON into frontend/ + executor/
pnpm gen-clients    # Codama → typed Kit clients
pnpm dev:frontend   # Next.js on http://localhost:3000
```

That gets you a frontend wired against **live devnet** by default. For local-only development against Surfpool, see [Surfpool dev loop](#surfpool-dev-loop) below.

---

## Mock PUSD mint (single, shared across envs)

A single mock PUSD mint (Token-2022) is committed via its keypair (`keys/mock-pusd.json`, gitignored) so the same mint pubkey is reused across LiteSVM unit tests, Surfpool integration tests, and devnet deploys. Public addresses:

- `keys/mock-pusd.pubkey` — mint address (`F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE`)
- `keys/mock-pusd-authority.pubkey` — mint authority address
- `keys/executor.pubkey` — oracle / keeper signer address

The mint pubkey is hardcoded into all instruction builders so tests and devnet share the same `Address`. Bootstrap or rotate via:

```bash
bash scripts/keys-bootstrap.sh
```

The script is idempotent — it skips any keypair file that already exists.

---

## Frontend cluster switch (devnet ↔ Surfpool)

The same frontend bundle runs against devnet (default) or a local Surfpool ledger. The switch is a single env var; all program IDs / PDAs / mock-PUSD mint stay identical across clusters because we never rotate those keypairs.

| Value | Devnet | Surfpool (localnet) |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | `http://127.0.0.1:8899` |
| Oracle authority | `3GjT…DNv` | `HqE3…ULaq` |
| Keeper authority | `EXZZ…yEJu` | `89ia…3QA6` |

**Devnet (default):**

```bash
pnpm dev:frontend
```

**Surfpool (local):**

```bash
# Tab 1: local Surfnet
pnpm dev:surfpool

# Tab 2: bootstrap PDAs into the blank ledger
pnpm deploy && pnpm seed-routes --cluster surfpool && pnpm bootstrap-test-actors

# Tab 3: frontend pointed at the local ledger
pnpm dev:frontend:surfpool
```

The faucet API route (`/api/faucet/mint`) auto-picks up `FAUCET_RPC_URL` from the same env, so server-side mints land on whichever cluster the frontend is using.

---

## Deploy runbook

A single parameterized script handles deploy + initialize + wire-up across all 5 programs on Surfpool / devnet / testnet / mainnet.

### Surfpool dev loop

```bash
# Terminal 1: keep surfpool running
pnpm dev:surfpool

# Terminal 2: deploy + run the integration test
pnpm bootstrap-test-actors                                # generate keys/test-actors/*
pnpm run deploy --cluster surfpool --owner $(solana-keygen pubkey ~/.config/solana/id.json)
pnpm test:integration:deployed                            # multi-actor lifecycle test
```

The deploy script:
- creates the mock PUSD mint (Token-2022) at the canonical `keys/mock-pusd.pubkey` (auto-runs `spl-token create-token --program-id <Token-2022>` on first invocation)
- deploys all 5 programs sequentially via `solana program deploy` (in-place upgrade if program IDs already exist on chain)
- initializes governance / vault / oracle_aggregator / flight_pool / controller in dependency order using v2 PDA seeds
- wires authorities (`vault.set_controller`, `flight_pool.set_controller`, `oracle.set_authorized_consumer`)
- emits a deployment artifact at `deployments/<cluster>-<unix-ts>.json` + `<cluster>-latest.json`
- is fully idempotent: re-running detects existing state and skips

### Devnet / testnet

```bash
# Pre-fund the deployer keypair (~10–15 SOL on devnet/testnet)
solana airdrop 5 --url devnet --keypair ~/.config/solana/id.json

# First-run: auto-creates the mock PUSD (Token-2022) mint
pnpm run deploy --cluster devnet --owner $(solana-keygen pubkey ~/.config/solana/id.json)

# Seed test actors with mock PUSD
pnpm fund-pusd --cluster devnet --recipient <pubkey> --amount 10000
```

### Mainnet (gated)

```bash
# Required: --confirm-mainnet flag + typed confirmation prompt
pnpm run deploy --cluster mainnet \
                --owner <funded-pubkey> \
                --usdc CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s \
                --confirm-mainnet
```

The script prints a cost preview (estimated ~14 SOL) and demands you type `deploy to mainnet` before any RPC call. Mainnet refuses the mock mint — `--usdc <real-pubkey>` is required (the flag is named for backwards compat; pass the live **PUSD** mint there).

---

## Funding scripts

| Script | Cluster scope | Purpose |
|---|---|---|
| `pnpm fund-sol --cluster surfpool --recipient <pk> --amount <sol>` | surfpool only | Airdrop SOL via `requestAirdrop` (unlimited locally) |
| `pnpm fund-pusd --cluster <surfpool\|localnet\|devnet\|testnet> --recipient <pk> --amount <pusd>` | dev clusters | Mint mock PUSD (Token-2022) via the committed mint authority |

Mainnet has no mock-PUSD mint authority — fund recipients via DEX or transfer.

---

## Running the crons locally

The cron daemon is a single Node process exposing an Express HTTP surface (`/api/health`, `/api/logs`, `/api/trigger/:job`, `/api/config/:job`). All four crons share the same in-memory ring-buffer log.

### One-shot invocation

```bash
# Set env (or copy executor/.env.example → executor/.env)
export CLUSTER=devnet
export KEEPER_KEYPAIR=keys/devnet-deployer.json
export AEROAPI_KEY=...

pnpm run-fetcher       # one tick of FlightDataFetcher
pnpm run-classifier    # one tick of FlightClassifier
pnpm run-settler       # one tick of SettlementExecutor
pnpm run-repricer      # one tick of RouteRepricer
```

### Daemon mode (all 4 crons)

```bash
cp executor/.env.example executor/.env       # fill in keys
pnpm cron-daemon
# → http://localhost:8080
```

Health check + manual triggers:

```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/config/repricer
curl -X POST 'http://localhost:8080/api/trigger/repricer?mode=mock&dryRun=1'
curl 'http://localhost:8080/api/logs?cron=repricer&limit=5'
```

### Full local pipeline (3 processes)

The repricer needs the Phase 22 pricing agent reachable. Full local bring-up:

```bash
# Terminal 1 — Phase 22 agent (Python, see "Premium pricing agent" below)
make serve
# → http://localhost:8000

# Terminal 2 — cron daemon (Node)
pnpm cron-daemon
# → http://localhost:8080

# Terminal 3 — frontend pointed at the local executor
echo 'EXECUTOR_BASE_URL=http://localhost:8080' >> frontend/.env.local
pnpm dev:frontend
# → http://localhost:3000/crons
#   Click "Trigger now" on each cron card; activity feed populates within
#   one 10s poll (entries live in the executor's in-memory buffer).
```

You can skip Terminal 1 and run the repricer in mock mode by setting `AGENT_MOCK=1` instead of `AGENT_BASE_URL`.

### Cron schedule overrides

| Var | Default | Description |
|---|---|---|
| `FETCHER_CRON` | `0 */2 * * *` | Fetcher cron expression |
| `CLASSIFIER_CRON` | `0 * * * *` | Classifier cron expression |
| `SETTLER_CRON` | `*/5 * * * *` | Settler cron expression |
| `REPRICER_CRON` | `0 0 * * *` | Repricer cron expression (daily 00:00 UTC) |
| `HEALTH_PORT` | `8080` | Express server port |
| `REPRICER_DRY_RUN` | `0` | Set to `1` to globally force dry-run on the repricer |

### Mock vs live API toggles

The `/crons` UI has Live/Mock toggles per cron and forwards mode through query params. Programmatic equivalents:

```bash
# Force live AeroAPI (requires AEROAPI_KEY)
curl -X POST 'http://localhost:3000/api/cron/fetcher/trigger?mode=live'

# Force mock with the cancelled scenario
curl -X POST 'http://localhost:3000/api/cron/fetcher/trigger?mode=mock&scenario=cancelled'

# Force live Grok + agent (requires XAI_API_KEY + reachable AGENT_BASE_URL)
curl -X POST 'http://localhost:3000/api/cron/repricer/trigger?mode=live'

# Mock repricer + dry-run + force a "disable all routes" verdict for the demo
GROK_MOCK_VERDICT=disable curl -X POST 'http://localhost:3000/api/cron/repricer/trigger?mode=mock&dryRun=1'
```

---

## Premium pricing agent (Phase 22)

`agent/` is a Python FastAPI service that wraps an XGBoost model trained on the U.S. BTS flight-delay dataset and returns a PUSD premium clamped to `[$1, $5]` for any flight tuple. It has no on-chain authority and is called only by the RouteRepricer cron via `POST /price`.

The agent is **not** in `pnpm-workspace.yaml` — it's Python, run via the top-level `Makefile`.

```bash
# macOS only — xgboost's native lib needs the OpenMP runtime
brew install libomp

# One-time setup
python3 -m venv agent/.venv
agent/.venv/bin/pip install -r agent/requirements.txt   # or: make install

# Train (~30s; produces agent/artifacts/{model,encoder,...}.joblib)
# Drop flight_delays_train.csv into agent/data/ first, or run `make download-data`
make train

# Serve on http://localhost:8000
make serve

# Test (4 pytest cases, ~1.5s)
make test
```

For the demo, just run `make serve` and point the repricer at `AGENT_BASE_URL=http://localhost:8000`. Docker (`agent/Dockerfile`) is provided for production-style deploy but is not required.

The trained model artifacts ship in the repo at `agent/artifacts/{model,encoder,feature_names,model_version}.joblib` so you can `make serve` without `make train` if you don't need to retrain.

---

## Running the e2e cron suite

End-to-end validation that drives the protocol on a live Surfpool through 8 parameterized scenarios using the **real cron core functions** (`runFetcherOnce` / `runClassifierOnce` / `runSettlerOnce`) with a mocked AeroAPI.

```bash
# Terminal 1: keep surfpool running
pnpm dev:surfpool

# Terminal 2: bootstrap actor keys + deploy
pnpm bootstrap-test-actors                                # idempotent
pnpm run deploy --cluster surfpool --owner $(solana-keygen pubkey ~/.config/solana/id.json)

# Terminal 3: run the e2e suite
pnpm test:e2e:crons
```

The suite skips with a clear warning if Surfpool is unreachable or no deployment artifact exists at `deployments/surfpool-latest.json` — it will not auto-start Surfpool or auto-deploy.

**Scenarios:**

| # | Scenario | Validates |
|---|---|---|
| S1 | on-time landing | premium realized, vault TMA ↑ premium, locked ↓ payoff, no payout |
| S2 | delayed beyond threshold | buyer claims payoff, vault locked ↓ |
| S3 | cancelled before ETA-seed | atomic 2-ix-in-1-tx (NotInitiated → Active → Cancelled), claim |
| S4 | cancelled after ETA-seed | single-ix `set_cancelled`, claim |
| S5 | multi-flight in single settler tick | `MAX_FLIGHTS_PER_TX=2` chunking → 2 batches for 3 flights |
| S6 | queued withdrawal | Model B value-at-request-time, queue drains during settlement, `collect()` |
| S7 | status-string-ignored invariant | misleading `status: "Cancelled"` with `cancelled: false` is ignored |
| S8 | 4xx envelope path | structured `[aero] 4xx envelope: ...` log, skip + resume next tick |

Total runtime: ~38 seconds on a fresh deploy (Surfpool startup + deploy not counted).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `--owner ... does not match the deployer keypair ...` | Different pubkey passed than the deployer keypair holds | Pass `--owner <deployer-pubkey>` or `--deployer <path-to-owner-keypair>`. |
| `Need ~X SOL, deployer ... has Y SOL on <cluster>` | Pre-flight balance check failed | Fund the deployer keypair on the target cluster (`solana airdrop 5 --url devnet`). |
| `Mock PUSD not found on <cluster>` | Mint never created on this cluster | `pnpm run deploy --cluster <cluster> --owner <pk>` auto-creates it on first run. |
| `Mainnet deploys require --confirm-mainnet` | Safety guardrail | Re-run with `--confirm-mainnet` to see the cost preview. |
| Surfpool integration test skipped with warning | Surfpool not running, or no deployment artifact | `pnpm dev:surfpool`, then `pnpm run deploy --cluster surfpool --owner <pk>`. |
| `Cannot find package '@solana/program-client-core'` | Codama runtime dep missing | `pnpm install` (root package.json includes it). |
| Frontend `/api/cron/*` returns `502 executor unreachable` | Cron daemon not running, or `EXECUTOR_BASE_URL` mis-set | Start `pnpm cron-daemon`, set `EXECUTOR_BASE_URL=http://localhost:8080` in `frontend/.env.local`. |
| Repricer trigger returns `503 agent unreachable` | Agent not running in live mode | Run `make serve`, or set `AGENT_MOCK=1` to bypass the agent. |
| `xgboost` import fails on macOS | libomp missing | `brew install libomp`. |

---

## Authority rotation

Devnet's `authorized_oracle` (`3GjT…DNv`) and `authorized_keeper` (`EXZZ…yEJu`) are distinct from the deployer pubkey. The cron daemon signs as the deployer by default. To let the fetcher / classifier / settler succeed on chain, rotate the authorities to the deployer once:

```bash
NO_DNA=1 pnpm rotate-oracle --cluster devnet
NO_DNA=1 pnpm rotate-keeper --cluster devnet
```

Or override per-tick with `--oracle <pubkey-or-path>` / `--keeper <pubkey-or-path>` to point at a different signer.

---

## Agent CLI conventions

When this repo is driven by Claude Code or another agent, all CLI invocations are prefixed with `NO_DNA=1` to disable interactive prompts:

```bash
NO_DNA=1 anchor build
NO_DNA=1 surfpool start
```
