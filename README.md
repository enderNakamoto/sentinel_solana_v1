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
├── agent/                 # Premium pricing FastAPI service (Phase 22 — Python, NOT in pnpm)
├── scripts/               # sync-idl, gen-clients, dev-surfpool, keys-bootstrap
├── keys/                  # Public keypairs (*.pubkey committed; *.json gitignored)
├── spec/                  # Architecture, phase plans, progress
├── Anchor.toml            # Anchor workspace config (program IDs pinned here)
├── Surfpool.toml          # Surfnet config (mock USDC seed)
├── Makefile               # Python agent targets (Phase 22)
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

### Frontend cluster switch (devnet ↔ Surfpool)

The same frontend bundle runs against devnet (default) or a local Surfpool ledger. The switch is a single env var; all program IDs / PDAs / mock USDC mint / mock-usdc-authority stay identical across clusters because we never rotate those keypairs. Only four things differ per cluster:

| Value | Devnet | Surfpool (localnet) |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | `http://127.0.0.1:8899` |
| Oracle authority | `3GjT…DNv` | `HqE3…ULaq` |
| Keeper authority | `EXZZ…yEJu` | `89ia…3QA6` |
| Explorer link | `explorer.solana.com?cluster=devnet` | (suppressed — no public explorer) |

**Devnet (default)** — wired to the live deployment from Phase 7:

```bash
pnpm dev:frontend
```

**Surfpool (local)** — point at `127.0.0.1:8899` with one script:

```bash
# Tab 1: local Surfnet
pnpm dev:surfpool

# Tab 2: bootstrap PDAs into the blank ledger
pnpm deploy && pnpm seed-routes --cluster surfpool && pnpm bootstrap-test-actors

# Tab 3: frontend pointed at the local ledger
pnpm dev:frontend:surfpool
```

The faucet API route (`/api/faucet/mint`) auto-picks up `FAUCET_RPC_URL` from the same env, so server-side mints land on whichever cluster the frontend is using. The activity-log drawer (bottom-right) and BottomNav both display the active cluster name so it's obvious which environment the UI is talking to.

### Cron control panel (Phases 17 + 18)

`/crons` exposes manual triggers for **all three** crons (FlightDataFetcher, FlightClassifier, SettlementExecutor) against whichever cluster the frontend is currently configured for. The page polls run history every 10s and shows the live `ActiveFlightList` so it's obvious what the next tick would do.

Three API routes back the page:

| Route | Method | Purpose |
|---|---|---|
| `/api/cron/[id]/trigger` | POST | Run one tick. `id ∈ {fetcher, classifier, settler}`. Returns `{ ok, summary, signatures, logs }`. The same `runFetcherOnce / runClassifierOnce / runSettlerOnce` helpers from `executor/src/core/` are reused — no duplicated cron logic. |
| `/api/cron/runs` | GET | Recent run history. Optional `?cron=<id>&limit=N`. Reads `frontend/.cache-cron-runs.jsonl`. |
| `/api/cron/active-flights` | GET | Reads the on-chain `ActiveFlightList` PDA + each entry's `FlightStatus`. |

**Server-side keypair (all three crons)** — the routes load the cron signer keypair via this priority order:

1. `CRON_KEEPER_BASE58` — base58-encoded 64-byte secret key (prod / hosted deploys).
2. `CRON_KEEPER_PATH` — explicit path to a JSON keypair file, resolved from the repo root.
3. Cluster default — `keys/surfpool-deployer.json` if `NEXT_PUBLIC_SOLANA_RPC_URL` points at `127.0.0.1`, else `keys/devnet-deployer.json`. The deployer is the controller + oracle owner; running both `NO_DNA=1 pnpm rotate-keeper --cluster <cluster>` and `NO_DNA=1 pnpm rotate-oracle --cluster <cluster>` once flips `ControllerConfig.authorized_keeper` and `OracleConfig.authorized_oracle` to the deployer pubkey so this single signer is accepted by `controller.{classify_flights,execute_settlements}` and `oracle_aggregator.{set_estimated_arrival,set_landed,set_cancelled}`. Override either with `--keeper <pubkey-or-path>` / `--oracle <pubkey-or-path>` to point at a different signer.

**FlightDataFetcher (Phase 18) — AeroAPI env vars + UI toggle:**

| Var | Required | Purpose |
|---|---|---|
| `AEROAPI_KEY` | live mode | FlightAware AeroAPI key — sets the `x-apikey` header. Drop into `frontend/.env.local` (gitignored). |
| `AEROAPI_MOCK` | mock mode | Set to `1` to default the fetcher into mock mode (the in-process stub). |
| `AEROAPI_MOCK_SCENARIO` | optional | Default mock scenario: `on_time` (default), `delayed`, `cancelled`, `scheduled`, `not_found`. |

**Per-request override** — the `/crons` fetcher card has a Live/Mock toggle (and a scenario dropdown when Mock is selected). Clicking *Trigger now* appends `?mode=mock|live&scenario=...` to the request, so the operator can flip between paths **without restarting the dev server**. The Live button is disabled when no `AEROAPI_KEY` is detected. Programmatic equivalent:

```bash
# Force live mode (requires AEROAPI_KEY in env)
curl -X POST 'http://localhost:3000/api/cron/fetcher/trigger?mode=live'

# Force mock mode with the cancelled scenario
curl -X POST 'http://localhost:3000/api/cron/fetcher/trigger?mode=mock&scenario=cancelled'
```

The fetcher route returns `400` if neither `AEROAPI_KEY` nor a mock override is configured, with an actionable error message.

**Phase 19 (open) — trust-hardened oracle.** The current Phase 18 posture is **centralised**: a single off-chain cron signs as `authorized_oracle` from the same Render/Railway box. Phase 19 will swap this for a TEE-attested oracle (Switchboard On-Demand v2 SGX, Acurast mobile TEE) or a decentralised feed adapter. The on-chain surface stays unchanged — `OracleConfig.authorized_oracle` is already a swap-friendly indirection.

**Caveats / posture:**
- Trigger endpoints are **public-unauth** — same posture as `/api/faucet/mint`. Acceptable for devnet/demo. Mainnet rollout would need a shared-secret header or session check.
- Run logs persist to a JSONL file (`frontend/.cache-cron-runs.jsonl`, gitignored, bounded to 100 records per cron). On Vercel/serverless deploys the filesystem is ephemeral, so the log resets on each cold start / redeploy. For longer-term retention, swap the `appendRun` / `readRecentRuns` impl in `frontend/src/lib/cron-runs.ts` for KV/Postgres behind the same interface.
- Triggers run synchronously — concurrent button-mashing is rejected with HTTP 409. The `pnpm cron-daemon` background process remains the answer for "real" automated cadence; the UI is for ad-hoc operator pokes + auditing.

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

### Live deployments

Canonical addresses for each cluster the protocol has been deployed to. Frontend, executor, and any external integration should read from these. Keypairs are gitignored; only `*.pubkey` files are committed.

#### Solana Devnet

Deployed: 2026-05-08. Canonical artifact path on disk: `deployments/devnet-latest.json` (gitignored — re-deploy to regenerate, or copy from below).

| Component | Address |
|---|---|
| **Cluster** | `devnet` (`https://api.devnet.solana.com`) |
| **Deployer / Owner** | `FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy` (`keys/devnet-deployer.pubkey`) |
| **Mock USDC mint** | `epYcquLhSzRpNZCYrdhv81J4mHAXHEChxnejTmMp91K` (`keys/mock-usdc.pubkey`) |

**Programs** (canonical IDs — same on every cluster, declared via committed program keypairs):
| Program | Address |
|---|---|
| `governance` | `6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT` |
| `vault` | `3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p` |
| `oracle_aggregator` | `EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6` |
| `flight_pool` | `GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq` |
| `controller` | `G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot` |

**PDA addresses** (derived from program IDs + seeds; needed by the frontend / executor for fast reads without re-deriving):
| PDA | Address | Owner program |
|---|---|---|
| `governanceConfig` | `AsVZzrc2ong7kU1bkfE4FM4q8mE5kVdRTa3pDW5yr74x` | governance |
| `vaultState` | `FpUBQSCehFHhSLjLhspNwFeknqTKeLG8FhjZqunaEkxw` | vault |
| `shareMint` | `JS95NxFcdefTANTiLNL8mjmAHrirR8qQJJGUpYkvZPr` | vault (PDA-owned mint) |
| `withdrawalQueue` | `AdrAPEPqELwJUAcqmZkx2tigBkEKdSXdZwTRRFSaKVER` | vault |
| `oracleConfig` | `jkTcNGgvbPVXRsUF6QSdk28jN7g9f7AYhYUP7DniBPg` | oracle_aggregator |
| `flightPoolConfig` | `89YRV2EdUtCi321YgLfuMCzzHWKJyEtoNo3c8gLsvXkq` | flight_pool |
| `poolTreasuryAuthority` | `491ShdDXTEGFpYhzhLmdAPyEMXSuQms2iygBqepuRZxa` | flight_pool |
| `controllerConfig` | `mCKrLhjbapVxbD4AGK99jPg1s3neXfpezQLMZFfNPTR` | controller |
| `activeFlightList` | `8c64now3ENjNohx7NNyoJbtd2p6T1w1qaUner6boh6X1` | controller |

**Cron authority keypairs** (auto-generated by the deploy script; private parts at gitignored paths):
| Authority | Pubkey | Keypair |
|---|---|---|
| `authorized_oracle` (FlightDataFetcher cron signer) | `3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv` | `keys/devnet-oracle.json` |
| `authorized_keeper` (FlightClassifier + SettlementExecutor cron signer) | `EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu` | `keys/devnet-keeper.json` |

**Frontend wiring (Phase 13+):** point `NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com` (or any devnet RPC provider) in `frontend/.env.local`. The page-level data layer at `frontend/src/data/` swaps from mocks to real RPC reads using these program IDs + PDAs in Phase 13–15. Wallet UX is already live — Phantom set to "Solana Devnet" connects today; Phase 13 wires real `controller.buy_insurance` etc.

**Executor wiring (cron daemon):** point `CLUSTER=devnet`, `ORACLE_KEYPAIR=keys/devnet-oracle.json`, `KEEPER_KEYPAIR=keys/devnet-keeper.json`, plus `AEROAPI_KEY=<your-key>`. The cron core fns load `deployments/devnet-latest.json` automatically — no code change.

**Explorer links:**
- Deployer: https://explorer.solana.com/address/FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy?cluster=devnet
- Controller: https://explorer.solana.com/address/G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot?cluster=devnet
- Mock USDC: https://explorer.solana.com/address/epYcquLhSzRpNZCYrdhv81J4mHAXHEChxnejTmMp91K?cluster=devnet

#### Solana Mainnet

Not yet deployed. See "Mainnet (gated)" below for the deploy command + safety guardrails.

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

## Frontend (Phase 12+)

The dApp lives in `frontend/` — Next.js 15 (App Router) + React 19 +
**framework-kit** (`@solana/client` + `@solana/react-hooks`) + Tailwind 3.
Wallet Standard discovery via `autoDiscover()`. **No** `@solana/wallet-adapter-*`.

### Quickstart

```bash
pnpm install
pnpm sync-idl && pnpm gen-clients          # required after any contract change
pnpm dev:frontend                          # http://localhost:3000
```

5 routes:
- `/` — Home (hero + protocol stats + how-it-works + live-markets preview)
- `/markets` — Live Markets globe (drag-to-rotate, arc-rendered)
- `/buy` — Buy Coverage (flight picker + premium calc + Cover button)
- `/earn` — Vault (TVL chart + risk tiers + deposit / redeem)
- `/portfolio` — Active + history policies + Claim button

Wallet connect (Phantom etc.) works against devnet; mock data drives every
on-chain stat. Phases 13–15 will swap the data layer to real RPC reads,
file by file.

### Modularity rules (locked-in for Phases 13–15)

Three rules enforce that the visual phase doesn't entangle with the
on-chain phases. Phase 13–15 work must honor these — gate-tested in
Phase 12 and verifiable by `git grep`.

**M1 — Fun mode is folder-isolated.**
Everything under `frontend/src/theme/fun/`. Pages never inline fun-mode
JSX; they render `<Mascots />` (a fun-mode-only component that returns
null in serious mode) and read `useTheme().mode === 'fun'` for any
conditional. Future fun-mode redesigns must touch only files under
`src/theme/fun/`.

**M2 — Globe is internally swappable.**
Pages import only `frontend/src/components/globe/Globe.tsx`. The current
implementation is `SvgGlobe.tsx`. Future swap to `ThreeGlobe.tsx` (or
similar) replaces the default export of `Globe.tsx` and pages don't
change. Same `GlobeProps` interface for both.

**M3 — Mock data layer mirrors the future contract layer.**
React components ALWAYS import data from `frontend/src/data/`. They
never import `@solana/kit` or `frontend/src/clients/` directly for data
reads — only for type imports if needed. Phases 13–15 swap function
bodies in `src/data/index.ts` from the mock to real RPC + Codama calls,
one function at a time.

### Theme + wallet UX

- Topbar mode toggle flips serious↔fun — persists in `localStorage` under
  `sentinel.theme.mode`.
- Topbar wallet chip — disconnected shows "Connect" → connector picker;
  connected shows truncated address + mock balance + dropdown
  (Copy / Disconnect).
- Stub buttons (Cover / Deposit / Redeem / Claim) log a `TODO: <ix-name>`
  line and fire a Phantom-style toast — proves handler wiring is in
  place ahead of Phase 13.

## Premium pricing agent (Phase 22)

`agent/` is a Python FastAPI service that wraps an XGBoost model trained on
the Kaggle 2008 flight-delay dataset and returns a USDC premium clamped to
`[$1, $5]` for any flight tuple. It has no on-chain authority and is called
only by the Phase 23 `RouteRepricer` cron via `POST /price`.

The agent is **not** in `pnpm-workspace.yaml` — it's Python, run via the
top-level `Makefile`.

```bash
# macOS only — xgboost's native lib needs the OpenMP runtime
brew install libomp

# One-time setup
python3 -m venv agent/.venv
agent/.venv/bin/pip install -r agent/requirements.txt   # or: make install

# Drop flight_delays_train.csv into agent/data/ (see `make download-data`)
make train       # ~30s; produces agent/artifacts/{model,encoder,...}.joblib
make serve       # FastAPI on http://localhost:8000
make test        # 4 pytest cases, ~1.5s
```

For the hackathon demo, run `make serve` — Phase 23 sees
`AGENT_BASE_URL=http://localhost:8000`. Docker (`agent/Dockerfile`) is
provided for production-style deploy on Render/Railway but not required.

See `agent/README.md` for the full endpoint contract, env vars, known
limitations (proxy target, no calibration), and deploy notes.

## Phase status

See `spec/progress.md` for the live phase dashboard. Each phase has its own plan + work log under `spec/phases/`.

Run `/plan-phase N` to plan, `/start-phase N` to execute, `/complete-phase N` after validation.
