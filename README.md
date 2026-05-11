# Sentinel Protocol

> **A prediction market for flight delays — used as travel insurance. Settled on Solana.**

Sentinel is two things in one. Underneath, it's a two-sided market on whether a given flight will be late. From the traveler's seat, it works exactly like parametric flight insurance: pay a premium in stablecoin, and if your flight is delayed beyond the per-route threshold, the smart contract pays you out automatically. No claim form. No adjuster. No waiting weeks for a decision.

Underwriters take the other side — they deposit **Palm USD (PUSD)** into a shared vault and earn the spread when flights run on time. Pricing, settlement, and payouts all happen on-chain. Off-chain keepers drive the inputs: flight-data oracle, classification, settlement, and per-route premium repricing.

- **Pitch deck:** [`/presentation`](frontend/public/presentation/slides.html) — 10 slides (problem, solution, architecture, oracle on Acurast TEE, the 4 keepers, XGBoost+Grok pricing brain, solvency, Monte Carlo)
- **Live Monte Carlo:** [`/quant`](frontend/app/quant/page.tsx) — 10,000-trial yield simulator
- **Frontend:** Next.js 15 dApp in `frontend/`, wired against devnet (Phantom on "Solana Devnet" connects today)

---

## Live on Solana Devnet

Deployed 2026-05-08, re-deployed in place on **2026-05-11** as part of the Phase 24 Token-2022 / PUSD migration (program IDs unchanged; v2 PDAs and Token-2022 mock-PUSD now canonical — see [§Token-2022 / PUSD migration](#token-2022--pusd-migration) and [pre_pusd_migration.md](pre_pusd_migration.md) for the rollback recipe). Canonical artifact path: `deployments/devnet-latest.json` (gitignored — re-deploy to regenerate, or copy from below).

| Component | Address |
|---|---|
| Cluster | `devnet` &middot; `https://api.devnet.solana.com` |
| Deployer / Owner | [`FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy`](https://explorer.solana.com/address/FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy?cluster=devnet) |
| Stablecoin mint (mock PUSD on devnet, Token-2022; mirrors live PUSD on mainnet) | [`F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE`](https://explorer.solana.com/address/F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE?cluster=devnet) |
| Stable token program (Token-2022) | [`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`](https://explorer.solana.com/address/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) |

**Programs** — canonical IDs, identical on every cluster (declared via committed program keypairs):

| Program | Address |
|---|---|
| `governance` | [`6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT`](https://explorer.solana.com/address/6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT?cluster=devnet) |
| `vault` | [`3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p`](https://explorer.solana.com/address/3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p?cluster=devnet) |
| `oracle_aggregator` | [`EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`](https://explorer.solana.com/address/EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6?cluster=devnet) |
| `flight_pool` | [`GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq`](https://explorer.solana.com/address/GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq?cluster=devnet) |
| `controller` | [`G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot`](https://explorer.solana.com/address/G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot?cluster=devnet) |

**Cron authorities:**

| Authority | Pubkey |
|---|---|
| `authorized_oracle` (FlightDataFetcher signer) | [`3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv`](https://explorer.solana.com/address/3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv?cluster=devnet) |
| `authorized_keeper` (Classifier + Settler signer) | [`EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu`](https://explorer.solana.com/address/EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu?cluster=devnet) |

Full PDA table (governance config, vault state, share mint, controller config, withdrawal queue, etc.) lives further down in [Deploy runbook → Live deployments](#live-deployments).

---

## Architecture

Five Anchor programs on Solana, driven by an off-chain executor that runs four keeper jobs:

```
                          EXECUTOR (off-chain crons)
                  Fetch  ·  Classify  ·  Settle  ·  Reprice
                    ↙              ↓              ↘
            reprices    classify · settle    writes ETA
   ┌─────────────────── Solana (on-chain) ───────────────────┐
   │  ┌──────────┐    ┌────────────┐    ┌─────────────────┐  │
   │  │Governance│←──→│ Controller │←──→│OracleAggregator │  │
   │  └──────────┘    └─────┬──────┘    └─────────────────┘  │
   │                        │                                 │
   │                ┌───────┴────────┐                        │
   │  Traveler ←─→  │   FlightPool ⇄ Vault   ←─→ Underwriter  │
   │                └────────────────┘                        │
   └──────────────────────────────────────────────────────────┘
```

| Program | Role |
|---|---|
| `governance` | Per-route terms (premium, payout, delay threshold). Routes can be whitelisted, disabled, repriced. |
| `controller` | Orchestrator. Owns `buy_insurance`, `classify_flights`, `execute_settlements`. CPIs into all other programs. |
| `flight_pool` | Per-flight pool registry + buyer records. Custodies premiums and pays out claims. |
| `vault` | Underwriter capital pool. Mints share tokens (RVS). Handles deposits, redemptions, FIFO withdrawal queue, and the solvency check. |
| `oracle_aggregator` | Flight-data feed. Stores ETA + actual arrival per flight. Forward-only state machine. Authority-gated writes (TEE-attested signer). |

→ Full account layouts, instruction catalog, CPI graph, and PDA seeds: [`spec/architecture.md`](spec/architecture.md).
→ Phased build plan + per-phase deliverables: [`spec/dev_steps.md`](spec/dev_steps.md).

---

## Oracle — runs on a phone

Sentinel's flight-data oracle runs on **[Acurast](https://acurast.com)** — a DePIN network where the workers are real Android phones, each one a hardware-attested Trusted Execution Environment (TEE).

- **Our TypeScript runs inside the phone's secure chip.** The AeroAPI calls *and* the signed Solana writes both originate from inside the TEE.
- **Keys can't be extracted.** The signing key lives in attested hardware. Nobody — not even the phone's owner — can read or steal it. Solana verifies the attested signature on every write, or rejects it.
- **No central operator.** If one phone goes offline, another Acurast Processor picks up the job. We pay per run, not per server. No AWS.
- **Publicly verifiable.** We can publish the hash of the code running inside the TEE. Anyone can verify what's executing on the phones matches what Sentinel claims.

The on-chain surface — `OracleConfig.authorized_oracle` — is a swap-friendly indirection. It accepts writes from a TEE phone, a Switchboard SGX worker, or (today's devnet posture) a centralised cron on Render, without any program change.

---

## Keepers — 4 off-chain crons

Four idempotent keeper jobs keep the protocol ticking. Each is a single TypeScript function (`runFetcherOnce`, `runClassifierOnce`, `runSettlerOnce`, `runRepricerOnce`) that can be invoked as a one-shot via `pnpm`, run together as a `node-cron` daemon, or triggered manually from the `/crons` operator dashboard.

| Keeper | Frequency | Signer | What it does |
|---|---|---|---|
| **FlightDataFetcher** | every 2h | `authorized_oracle` | Reads `ActiveFlightList`, calls AeroAPI for each flight whose ETA has passed by ≥1h, writes ETA/actual arrival to `oracle_aggregator`. Runs inside the Acurast TEE in production. |
| **FlightClassifier** | every 1h | `authorized_keeper` | For each `Landed` / `Cancelled` flight, calls `controller.classify_flights` to transition it into `ToBeSettled{OnTime, Delayed, Cancelled}`. |
| **SettlementExecutor** | every 5m | `authorized_keeper` | For each `ToBeSettled*` flight, calls `controller.execute_settlements` — pays out claims, releases locked capital, and drains the FIFO withdrawal queue. |
| **RouteRepricer** | daily | deployer | For each whitelisted route: fetches a baseline premium from the XGBoost agent + a live disruption signal from Grok, then calls `governance.update_route_terms` (or `disable_route` / idempotent re-`whitelist_route`). See the next section. |

The `/crons` dashboard exposes per-cron manual triggers, a 10s-poll run history, and a live view of `ActiveFlightList` + each entry's `FlightStatus`. Mock / live AeroAPI toggle and mock / live Grok toggle let you demo the full pipeline without burning API credits. See [Cron control panel](#cron-control-panel-phases-17--18--23) for the operational details.

---

## Pricing brain — XGBoost + Grok → Governance

Routes are priced in two layers, then written on-chain by the **RouteRepricer** cron:

**Layer 1 — XGBoost classifier on BTS data.** An XGBoost model trained on the U.S. Bureau of Transportation Statistics on-time-performance dataset predicts `P(delay ≥ 15min)` per `(carrier, origin, destination, departure time, distance, day of week)`. The Phase 22 FastAPI service (`agent/`, Python) exposes this as `POST /price` and returns a USDC premium clamped to `[$1, $5]`. Formula: `premium = clamp(1 + 4·p_delay, 1, 5)`. Validation ROC AUC: **0.7505**.

**Layer 2 — Grok with Live Search.** xAI Grok queries real-time news + weather for each route via Live Search and returns structured JSON (`response_format: json_schema`) — a multiplier on the base premium plus a kill-switch for unsafe conditions. A winter storm bumps the premium ×1.4; an active war zone flips `disable_route: true`.

**On-chain write.** The RouteRepricer cron walks every whitelisted route, calls both layers, and applies the result via the `governance` program:

| Decision | Instruction |
|---|---|
| Premium changed beyond a 100k base-unit (~$0.10) drift threshold | `governance.update_route_terms` |
| Grok flagged the route unsafe | `governance.disable_route` |
| Conditions cleared on a route the cron previously disabled | `governance.whitelist_route` (idempotent re-enable) |

**Idempotency rule:** the cron only re-enables routes it disabled itself. It never overrides a human admin's `disable_route` decision.

```
BTS data → XGBoost → Grok (live search) → RouteRepricer cron → governance.update_route_terms
```

→ Agent service runbook (install, train, serve, env vars, Docker): [Premium pricing agent](#premium-pricing-agent-phase-22).
→ Cron runbook (one-shot, daemon, mock/live toggles): [Cron control panel](#cron-control-panel-phases-17--18--23).

---

## Stablecoin — Palm USD (PUSD)

Sentinel is built around **Palm USD (PUSD)** as the unit of account. Travelers pay premiums in PUSD; underwriters deposit PUSD into the vault to back claims; payouts and yield redemptions are denominated in PUSD. Every `controller.buy_insurance`, `vault.deposit / redeem / collect`, and `flight_pool.claim` instruction moves PUSD.

PUSD is a **Token-2022** mint (program `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`). Mainnet PUSD is at [`CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s`](https://explorer.solana.com/address/CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s) with the `MetadataPointer` + `TokenMetadata` extensions only — no transfer fee, no hooks, no permanent delegate, no freeze. On **devnet / Surfpool / LiteSVM** the protocol uses a mock-PUSD mirror at [`F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE`](https://explorer.solana.com/address/F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE?cluster=devnet) (Token-2022, base mint layout only, no extensions) so testing is unblocked and `pnpm fund-pusd` can mint test balances on demand.

The mint address is the **only** thing that changes when swapping to live PUSD on mainnet — the contracts treat the stablecoin as a single Token-2022 `Mint` address configured at init time. Same instruction set, same authority model, same accounting. RVS vault shares stay on the classic SPL Token program (Sentinel-native mint, no metadata needed); the protocol uses Anchor's `token_interface` on the stable side to support both Token-2022 and classic SPL transparently.

---

## Token-2022 / PUSD migration

The protocol migrated from a classic-SPL mock USDC mint to **Token-2022 mock PUSD** as of 2026-05-11. Program IDs are unchanged (in-place `solana program deploy` upgrade). What changed:

- **Stable mint**: classic SPL `epYcquLhSzRpNZCYrdhv81J4mHAXHEChxnejTmMp91K` → Token-2022 `F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE` on devnet (Token-2022 program `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`). Mainnet target: live PUSD at `CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s`.
- **Stable-side accounts**: programs moved from `Program<Token>` + `Account<TokenAccount>` to `Interface<TokenInterface>` + `InterfaceAccount<TokenAccount>` (Anchor's `token_interface` module). SPL transfers go through `transfer_checked` so the same binary handles classic-SPL or Token-2022 mints.
- **ATAs**: stable-side associated token accounts now derive against Token-2022 (`associated_token::token_program = token_program` constraint must be explicit; Anchor defaults to classic SPL). The frontend, executor, scripts, and tests all pass the Token-2022 program id to `findAssociatedTokenPda` / `getAssociatedTokenAddressSync` for stable-side derivations.
- **PDA seeds bumped to `_v2`**: `vault_state`, `withdrawal_queue`, `share_mint`, `flight_pool_config`, `pool_treasury`, `controller_config`, `active_flights`, `oracle_config`. Pre-Phase-24 v1 PDAs are still on chain (orphaned, no longer referenced by the deployed binaries). `governance_config` kept its v1 seed (governance schema unchanged).
- **Share-side unchanged**: RVS shares remain on classic SPL Token. The vault PDA still owns the share mint and signs `token::transfer` / `mint_to` / `burn` against `Program<Token>`.
- **CLI surface**: `pnpm fund-usdc` → `pnpm fund-pusd` (passes `--program-id <Token-2022>` to `spl-token create-token`).
- **Frontend e2e tests removed**: the Synpress + Playwright suite at `frontend/tests/` was deleted because Synpress did not work reliably with the Solana Wallet Standard flow under the pinned framework-kit version. Cross-program protocol behavior is still covered by the 88-test LiteSVM suite and the 8-scenario Phase 11 Surfpool cron e2e.

**Rollback** — if the migration needs to be reverted, see [pre_pusd_migration.md](pre_pusd_migration.md). The pre-migration state is pinned at git tag `pre-pusd-migration`; the keys `keys/mock-usdc.{json,pubkey,-authority.json,-authority.pubkey}` are retained on disk for that path.

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

Five Anchor programs: `governance`, `vault`, `flight_pool`, `oracle_aggregator`, `controller`. Additional Python agent (`agent/`) for the Phase 22 XGBoost service; runs outside the pnpm workspace via the top-level `Makefile`.

See:
- [`spec/architecture.md`](spec/architecture.md) — full system architecture
- [`spec/dev_steps.md`](spec/dev_steps.md) — phased build plan
- [`spec/workflow.md`](spec/workflow.md) — phase lifecycle / agent commands
- [`CLAUDE.md`](CLAUDE.md) — locked stack, hard rules

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
├── Surfpool.toml          # Surfnet config (mock PUSD seed, Token-2022)
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

### Mock PUSD mint (single, shared across envs)

A single mock PUSD mint (Token-2022) is committed via its keypair (`keys/mock-pusd.json`, gitignored) so the same mint pubkey is reused across LiteSVM unit tests, Surfpool integration tests, and devnet deploys. Public addresses are committed at:

- `keys/mock-pusd.pubkey` — mint address (`F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE`)
- `keys/mock-pusd-authority.pubkey` — mint authority address
- `keys/mock-usdc{,authority}.pubkey` — **legacy** classic-SPL mock USDC, retained only for rollback to the `pre-pusd-migration` git tag; not used by current binaries (see [pre_pusd_migration.md](pre_pusd_migration.md))
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

The same frontend bundle runs against devnet (default) or a local Surfpool ledger. The switch is a single env var; all program IDs / PDAs / mock-PUSD mint / mock-pusd-authority stay identical across clusters because we never rotate those keypairs. Only four things differ per cluster:

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

### Cron control panel (Phases 17 + 18 + 23)

`/crons` exposes manual triggers for **all four** crons against whichever cluster the frontend is currently configured for. The page polls run history every 10s and shows the live `ActiveFlightList` so it's obvious what the next tick would do.

The four crons:
- **FlightDataFetcher** — AeroAPI → `oracle_aggregator_program` (Phase 8/18).
- **FlightClassifier** — `controller.classify_flights` (Phase 9/17).
- **SettlementExecutor** — `controller.execute_settlements` (Phase 10/17).
- **RouteRepricer** *(new in Phase 23)* — for each whitelisted route: Phase 22 agent baseline premium + Grok geopolitical signal → `update_route_terms` / `disable_route` / idempotent `whitelist_route` re-enable.

API routes:

| Route | Method | Purpose |
|---|---|---|
| `/api/cron/[id]/trigger` | POST | Run one tick. `id ∈ {fetcher, classifier, settler}`. Returns `{ ok, summary, signatures, logs }`. The same `runFetcherOnce / runClassifierOnce / runSettlerOnce` helpers from `executor/src/core/` are reused — no duplicated cron logic. |
| `/api/cron/repricer/trigger` | POST | Run one repricer tick. Returns the same envelope plus `{ decisions, histogram, newlyDisabledPdas, dryRun }`. Sibling to `[id]/trigger` because the per-route iteration shape is materially different. |
| `/api/cron/repricer/config` | GET | Reports `liveAvailable` (XAI_API_KEY set), `agentReachable` (1s healthcheck), `agentBaseUrl`, `defaultMode`, `defaultGrokVerdict`. |
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

**RouteRepricer (Phase 23) — agent + Grok env vars + UI toggle:**

| Var | Required | Purpose |
|---|---|---|
| `AGENT_BASE_URL` | live agent | Phase 22 agent endpoint (e.g. `http://localhost:8000`). The repricer pre-flights `GET ${AGENT_BASE_URL}/healthz` before iterating routes; 503 on failure. |
| `XAI_API_KEY` | live grok | xAI Grok API key — sets the `Authorization: Bearer …` header. Drop into `frontend/.env.local` (gitignored). Live mode uses `model: "grok-4"` + Live Search (`sources: [{ type: "news" }]`) + structured JSON outputs. |
| `AGENT_MOCK` | mock agent | Set to `1` to bypass HTTP and use a fixed-premium fixture. Useful for grok-only demos. |
| `AGENT_MOCK_PREMIUM_USDC` | optional | Fixed premium returned in mock-agent mode. Default `2.5`. |
| `GROK_MOCK` | mock grok | Set to `1` to bypass xAI and use a pinned verdict fixture. |
| `GROK_MOCK_VERDICT` | optional | Mock verdict spec: `ok` (default), `raise:1.5`, `raise:2.0`, `disable`. |
| `REPRICER_DRY_RUN` | optional | Set to `1` to globally force dry-run (decide actions, skip on-chain txs). The `/crons` UI also exposes a per-request 💭 dry-run checkbox. |

**Per-request override** — the `/crons` repricer card has a Live/Mock toggle, a verdict dropdown when Mock is selected, and a 💭 dry-run checkbox. Clicking *Trigger now* appends `?mode=mock|live&dryRun=1` to the request, so the operator can flip without restarting. Live mode requires both `XAI_API_KEY` and a reachable `AGENT_BASE_URL`. Programmatic equivalent:

```bash
# Force live mode (requires XAI_API_KEY + reachable AGENT_BASE_URL)
curl -X POST 'http://localhost:3000/api/cron/repricer/trigger?mode=live'

# Mock mode + dry-run + force a "disable all routes" verdict for the demo
GROK_MOCK_VERDICT=disable curl -X POST 'http://localhost:3000/api/cron/repricer/trigger?mode=mock&dryRun=1'
```

The repricer route returns `400` if neither path is configured, `503` if `AGENT_BASE_URL` is set but unreachable, `409` if another tick is in flight. Grok failures (5xx, timeout, invalid JSON) silently fall back to a safe-default verdict — they never block the run. The activity feed renders the per-route decision list (route, baseline, Grok action, on-chain action, tx signature, Grok reason) in "View log" so the demo can show *why* each route moved.

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

Deployed: 2026-05-08, re-deployed in place 2026-05-11 (Phase 24 Token-2022 migration). Canonical artifact path on disk: `deployments/devnet-latest.json` (gitignored — re-deploy to regenerate, or copy from below).

Program IDs, deployer / owner, stablecoin mint, and cron authorities are listed in the top-of-README [Live on Solana Devnet](#live-on-solana-devnet) section. Below is the **PDA reference table** — all v2 PDAs (post-Phase-24); the pre-Phase-24 v1 PDAs are still on chain but orphaned (referenced only from the `pre-pusd-migration` git tag):

| PDA | v2 seed | Address | Owner program |
|---|---|---|---|
| `governanceConfig` | `governance_config` | `AsVZzrc2ong7kU1bkfE4FM4q8mE5kVdRTa3pDW5yr74x` | governance |
| `vaultState` | `vault_state_v2` | `CZ7Cnntu7uSWmzKNudfd6v8UHJqjELiCJuBX1pn43ecc` | vault |
| `shareMint` | `share_mint_v2` | `68SbS4XW5ACfbWr6TBFxLK7rHc6P7uLkBRd26o4ZGQM` | vault (PDA-owned mint, classic SPL) |
| `withdrawalQueue` | `withdrawal_queue_v2` | `2iXD7wBgunLeVXaSDGSzHKC89ms8RKXpzSLoPJPLcvaT` | vault |
| `oracleConfig` | `oracle_config_v2` | `7FimnDxjyVw2T4cGR2fTv3vG1t5zS8iVEHBxNmR4J8xt` | oracle_aggregator |
| `flightPoolConfig` | `flight_pool_config_v2` | `G9RRspS8p9R1wvSVCJ8kgefKMJDjRTDQtfwbTHK2D7eV` | flight_pool |
| `poolTreasuryAuthority` | `pool_treasury_v2` | `6VDsbh8nxpwj9tj8F27Ftfior3Wc8C5vDW9LKAr1KVR7` | flight_pool |
| `controllerConfig` | `controller_config_v2` | `496TgyNMNYDoGgGmUEviJ2hvc9cvvf788sSn5WTsEKqw` | controller |
| `activeFlightList` | `active_flights_v2` | `6Jisfz6sgbMZiCN2iKhjrkdRRTBwRyYLB4Tb4gFyJxJs` | controller |

Cron authority keypairs are auto-generated by the deploy script at gitignored paths: `keys/devnet-oracle.json` (FlightDataFetcher signer) and `keys/devnet-keeper.json` (Classifier + Settler signer).

**Frontend wiring (Phase 13+):** point `NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com` (or any devnet RPC provider) in `frontend/.env.local`. The page-level data layer at `frontend/src/data/` swaps from mocks to real RPC reads using these program IDs + PDAs in Phase 13–15. Wallet UX is already live — Phantom set to "Solana Devnet" connects today; Phase 13 wires real `controller.buy_insurance` etc.

**Executor wiring (cron daemon):** point `CLUSTER=devnet`, `ORACLE_KEYPAIR=keys/devnet-oracle.json`, `KEEPER_KEYPAIR=keys/devnet-keeper.json`, plus `AEROAPI_KEY=<your-key>` and (for the repricer) `AGENT_BASE_URL=<agent host>` + `XAI_API_KEY=<grok key>`. The cron core fns load `deployments/devnet-latest.json` automatically — no code change.

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
- creates the mock PUSD mint (Token-2022) at the canonical `keys/mock-pusd.pubkey` (auto-runs `spl-token create-token --program-id <Token-2022>` on first invocation)
- deploys all 5 programs sequentially via `solana program deploy` (in-place upgrade if program IDs already exist on chain)
- initializes governance / vault / oracle_aggregator / flight_pool / controller in dependency order using v2 PDA seeds (post-Phase-24)
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

The script prints a cost preview (estimated ~14 SOL) and demands you type `deploy to mainnet` before any RPC call. Mainnet refuses the mock mint — `--usdc <real-pubkey>` is required. The `--usdc` flag is named for backwards compat; pass the live **PUSD** mint there (Token-2022 program, mainnet pubkey `CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s`).

### Funding scripts

| Script | Cluster scope | Purpose |
|---|---|---|
| `pnpm fund-sol --cluster surfpool --recipient <pk> --amount <sol>` | surfpool only | Airdrop SOL via `requestAirdrop` (unlimited locally) |
| `pnpm fund-pusd --cluster <surfpool\|localnet\|devnet\|testnet> --recipient <pk> --amount <pusd>` | dev clusters | Mint mock PUSD (Token-2022) via the committed mint authority (`keys/mock-pusd-authority.json`) |

Mainnet has no mock-PUSD mint authority — fund recipients via DEX or transfer.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `--owner ... does not match the deployer keypair ...` | Different pubkey passed than the deployer keypair holds | The deployer signs init txs and becomes config.owner. Pass `--owner <deployer-pubkey>` or use `--deployer <path-to-owner-keypair>`. |
| `Need ~X SOL, deployer ... has Y SOL on <cluster>` | Pre-flight balance check failed | Fund the deployer keypair on the target cluster (e.g. `solana airdrop 5 --url devnet`). |
| `Mock PUSD not found on <cluster>` | Mint never created on this cluster | `pnpm run deploy --cluster <cluster> --owner <pk>` auto-creates it on first run (Token-2022 program). |
| `Mainnet deploys require --confirm-mainnet` | Safety guardrail | Re-run with `--confirm-mainnet` to see the cost preview. |
| Surfpool integration test skipped with warning | Surfpool not running, or no deployment artifact | `pnpm dev:surfpool` in another terminal, then `pnpm run deploy --cluster surfpool --owner <pk>`. |
| `Cannot find package '@solana/program-client-core'` | Codama runtime dep missing | `pnpm install` (root package.json includes it). |

## Running the crons (Phase 8–10, daemon revamped in Phase 25)

Four off-chain crons keep the protocol ticking. Each can be invoked as a one-shot via `pnpm`, OR run together as a single Node process exposing an Express HTTP surface (`/api/health`, `/api/logs`, `/api/trigger/:job`, `/api/config/:job`). Production deploys the daemon to a Render Web Service — see [Render deploy (Phase 25)](#render-deploy-phase-25) below.

| Cron | Frequency | Signing key | One-shot |
|---|---|---|---|
| **FlightDataFetcher** (Phase 8) | every 2h | `authorized_oracle` | `pnpm run-fetcher` |
| **FlightClassifier** (Phase 9) | every 1h | `authorized_keeper` | `pnpm run-classifier` |
| **SettlementExecutor** (Phase 10) | every 5min | `authorized_keeper` | `pnpm run-settler` |
| **RouteRepricer** (Phase 23) | daily 00:00 UTC | deployer (governance owner) | `pnpm run-repricer` |

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
| `REPRICER_CRON` | `0 0 * * *` | Repricer cron expression (daily 00:00 UTC) |
| `RUN_AT_BOOT` | `0` | Set `1` to fire all 4 schedules once on startup |
| `HEALTH_PORT` | `8080` | Express server port (`/api/*`) |

## Render deploy (Phase 25)

The cron daemon is built to run as a **single Render Web Service** with all four crons in one Node process. Both scheduled ticks and manual UI-triggered ticks land in the same in-memory ring-buffer log; the Vercel frontend proxies through to render that log in the `/crons` activity feed.

### Localhost validation (recommended before Render)

The full local pipeline needs three processes — the Phase 22 pricing agent on `:8000`, the cron daemon on `:8080`, the Next.js frontend on `:3000`. You can skip the agent and run the repricer in mock mode by setting `AGENT_MOCK=1` instead of `AGENT_BASE_URL`.

```bash
# Terminal 1 — Phase 22 agent (Python, see "Premium pricing agent" section)
make serve
# → http://localhost:8000

# Terminal 2 — cron daemon (Node)
cp executor/.env.example executor/.env       # if you haven't already
pnpm cron-daemon
# → http://localhost:8080
# (esbuild bundles run-cron.ts → run-cron.mjs then `node` runs it. tsx
#  directly can't resolve the Codama clients' bare directory imports —
#  see scripts/run.sh.)

# Terminal 3 — sanity-check the HTTP surface
curl http://localhost:8080/api/health
curl http://localhost:8080/api/config/repricer
curl -X POST 'http://localhost:8080/api/trigger/repricer'
curl 'http://localhost:8080/api/logs?cron=repricer&limit=5'

# Terminal 4 — frontend pointed at the local executor
echo 'EXECUTOR_BASE_URL=http://localhost:8080' >> frontend/.env.local
pnpm dev:frontend
# → http://localhost:3000/crons
#   Click "Trigger now" on each cron card; activity feed populates within
#   one 10s poll (entries live in the executor's in-memory buffer).
```

If the executor isn't reachable from the frontend, every `/api/cron/*` proxy route returns `502 executor unreachable at <url>`. If the agent isn't reachable from the executor, repricer triggers return `503 agent unreachable` (live mode only; mock mode bypasses the check).

### Render setup

The `render.yaml` defines **two** Web Services that get provisioned together:

| Service | Runtime | Purpose |
|---|---|---|
| `sentinel-executor` | Node | The cron daemon + Express surface (`/api/health`, `/api/logs`, `/api/trigger/:job`, `/api/active-flights`). |
| `sentinel-agent` | Python | The Phase 22 XGBoost FastAPI service the repricer cron POSTs to for baseline premiums. Trained model ships with the repo at `agent/artifacts/*.joblib` so the build is `pip install` only — no `make train` at deploy time. |

The executor reaches the agent via its public Render URL (`AGENT_BASE_URL=https://sentinel-agent-<hash>.onrender.com`). Render Web Services on Starter+ plans stay warm so the daily repricer tick always finds the agent ready.

1. **Connect the repo to Render.** Render auto-detects `render.yaml` at the repo root and provisions both services.

2. **Set the `sync: false` env vars** on `sentinel-executor` in the Render dashboard before the first deploy:

   | Var | What |
   |---|---|
   | `SOLANA_RPC_URL` | `https://api.devnet.solana.com` (or your devnet RPC provider) |
   | `CRON_KEEPER_BASE58` | base58 of `keys/devnet-deployer.json` (see [keypair → base58](#deriving-base58-from-a-keypair-json) below) |
   | `AEROAPI_KEY` | FlightAware key — enables fetcher live mode |
   | `XAI_API_KEY` | xAI Grok key — enables repricer live mode |
   | `AGENT_BASE_URL` | the **public URL of `sentinel-agent`** (visible in the Render dashboard once that service finishes its first deploy; format `https://sentinel-agent-<hash>.onrender.com`) |
   | `EXECUTOR_TRIGGER_SECRET` | any random string — gates `POST /api/trigger/*` |

   `sentinel-agent` doesn't need any custom env vars; its trained model ships with the repo.

3. **Deploy.** Render builds the executor with `pnpm install --frozen-lockfile` + `scripts/run.sh run-cron` (esbuild bundle), and the agent with `pip install -r requirements.txt` + `uvicorn`. Health-checks every 30s on `/api/health` (executor) and `/healthz` (agent).

4. **Point Vercel at the Render service.** Set these on the Vercel project:
   ```
   EXECUTOR_BASE_URL=https://sentinel-executor.onrender.com
   EXECUTOR_TRIGGER_SECRET=<same value as on Render>
   ```
   Then redeploy the frontend. The `/crons` page now mirrors whichever ticks Render fires (scheduled + UI-triggered).

5. **Remove obsolete env vars from Vercel.** The following moved to Render and should be deleted from the Vercel project:
   `AEROAPI_KEY`, `AEROAPI_MOCK`, `AEROAPI_MOCK_SCENARIO`, `XAI_API_KEY`, `GROK_MOCK`, `GROK_MOCK_VERDICT`, `AGENT_BASE_URL`, `AGENT_MOCK`, `AGENT_MOCK_PREMIUM_USDC`, `REPRICER_DRY_RUN`, `CRON_KEEPER_BASE58`, `CRON_KEEPER_PATH`. Keep `FAUCET_FEE_PAYER_BASE58` + `FAUCET_MINT_AUTHORITY_BASE58` (the `/api/faucet/mint` route still lives on Vercel).

### Deriving base58 from a keypair JSON

Render takes the signer as a base58 string. Convert any `keys/*.json` locally:

```bash
node -e "import('bs58').then(m => process.stdout.write(m.default.encode(new Uint8Array(JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8'))))))" keys/devnet-deployer.json | pbcopy
```

That puts the base58 secret on your clipboard. Paste it into the `CRON_KEEPER_BASE58` field on Render. **Devnet keys only** — never reuse a key that's touched mainnet on a third-party dashboard.

### Caveats

- **Single point of failure.** node-cron is in-process, so if the Render container crashes or redeploys, all four jobs miss their tick. Missed ticks don't replay — the next scheduled tick runs normally.
- **Restart wipes logs.** The ring buffer is module-scope state in the running Node process. Every redeploy resets the dashboard history. Audit/forensic history lives on chain via `getSignaturesForAddress`.
- **Free tier sleep.** Render free-tier Web Services spin down after 15min idle; only paid plans (Starter+) stay warm. `render.yaml` defaults to `plan: starter` for this reason.
- **No horizontal scaling.** Don't bump `numInstances` above 1 — two replicas would double-submit every cron tick.

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
  day snapshot validation, use the `surfnet_setTime` cheatcode.
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

## Tests

Sentinel has 5 test surfaces &mdash; one per execution context. Each is a one-liner from the repo root.

### Test matrix

| Surface | Location | Runner | Count | Coverage |
|---|---|---|---|---|
| Anchor program unit tests | `contracts/tests/{governance,vault,flight_pool,oracle_aggregator,controller,smoke}.test.ts` | LiteSVM (vitest) | ~88 | Per-instruction coverage + edge cases + auth isolation for each of the 5 programs. Runs entirely in-process &mdash; no validator, no RPC. |
| Cross-program integration | `contracts/tests/integration.test.ts` | LiteSVM (vitest) | 9 | Full lifecycle on LiteSVM: deploy &rarr; whitelist &rarr; deposit &rarr; buy &rarr; oracle write &rarr; classify &rarr; settle &rarr; claim. Three flight outcomes (on-time / delayed / cancelled) + withdrawal queue + solvency + auth isolation. |
| Surfpool integration | `contracts/tests/integration/{surfpool,full-flow-deployed}.test.ts` | Surfpool (vitest) | 2 suites | Sanity RPC reachability + multi-actor full-flow lifecycle against a live local Surfnet. Same code paths the frontend hits. |
| E2E with real crons | `contracts/tests/integration/e2e-with-crons-deployed.test.ts` | Surfpool (vitest) | 8 scenarios | Drives `runFetcherOnce` / `runClassifierOnce` / `runSettlerOnce` against live Surfpool with a parameterized mock AeroAPI. Highest-fidelity test we have &mdash; real RPC, real Anchor programs, real Codama ixs. |
| Executor unit tests | `executor/tests/*.test.ts` | vitest | 114 | Pure unit tests on each cron's decision module (classifier batches, fetcher actions, settlement batches, route actions), AeroAPI client + 4xx envelope decoder, Grok client + structured-output decoder. |
| Agent service | `agent/tests/test_price.py` | pytest | 4 | XGBoost service smoke: model loads, `/price` request/response contract, `/healthz` contract, premium clamp invariant. |

### Running the tests

**1. Anchor program unit tests (LiteSVM)** &mdash; fast, no infrastructure, ~88 tests, runs in-process.

```bash
pnpm test:contracts
```

`pretest` triggers `anchor build` automatically. Add `--filter <pattern>` to scope: `pnpm --filter @sentinel/contracts test -- vault` runs only `vault.test.ts`.

**2. Surfpool integration suite** &mdash; needs Surfpool running + a fresh deploy.

```bash
# Terminal 1: keep surfpool running
pnpm dev:surfpool

# Terminal 2: deploy + run
pnpm bootstrap-test-actors
pnpm run deploy --cluster surfpool --owner $(solana-keygen pubkey ~/.config/solana/id.json)
pnpm test:integration                    # all integration suites
pnpm test:integration:deployed           # just the multi-actor full-flow
```

Skips with a clear warning if surfpool is unreachable or no deployment artifact exists at `deployments/surfpool-latest.json` &mdash; will not auto-start surfpool or auto-deploy.

**3. E2E cron suite (highest-fidelity)** &mdash; drives the real cron core fns through 8 parameterized scenarios.

```bash
# Surfpool + deploy as above, then:
pnpm test:e2e:crons
```

Total runtime ~38 seconds on a fresh deploy (Surfpool startup + deploy not counted). See [Running the e2e cron suite](#running-the-e2e-cron-suite-phase-11) for the full scenario matrix.

**4. Executor unit tests** &mdash; pure Vitest on the decision modules + API clients.

```bash
pnpm --filter @sentinel/executor test
```

No infrastructure. Tests run in milliseconds. Covers all four crons' decision logic plus the AeroAPI 4xx-envelope decoder and the Grok structured-JSON contract.

**5. Agent service (Python pytest)** &mdash; needs the Python env + the trained model.

```bash
# macOS only: xgboost needs libomp
brew install libomp

# One-time install + train
make install
make train      # ~30s; produces agent/artifacts/{model,encoder,...}.joblib

# Run the test suite
make test       # 4 pytest cases, ~1.5s
```

**7. Typecheck (all 3 TS workspaces)** &mdash; fast sanity gate.

```bash
pnpm typecheck
```

### Fast local check (one shell)

The non-infrastructure suites can be chained &mdash; runs in well under a minute on a fresh checkout:

```bash
pnpm typecheck && \
  pnpm test:contracts && \
  pnpm --filter @sentinel/executor test && \
  make test
```

The Surfpool + Playwright suites need extra setup (running Surfpool, a deploy, the dev server) and are excluded from this fast loop.

### CI

No CI workflow today &mdash; deferred. Locally the suites above are the source of truth. First CI workflow lands when there's a real artifact to gate (mainnet deploy or hosted demo).

## Phase status

See `spec/progress.md` for the live phase dashboard. Each phase has its own plan + work log under `spec/phases/`.

Run `/plan-phase N` to plan, `/start-phase N` to execute, `/complete-phase N` after validation.
