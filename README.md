# Sentinel Protocol

> **A prediction market for flight delays — used as travel insurance. Settled on Solana.**

---

## 1. Overview

Sentinel is two things in one. Underneath, it's a two-sided market on whether a given flight will be late. From the traveler's seat, it works exactly like parametric flight insurance: pay a premium in stablecoin, and if your flight is delayed beyond the per-route threshold, the smart contract pays you out automatically. **No claim form. No adjuster. No waiting weeks for a decision.**

Underwriters take the other side — they deposit **Palm USD (PUSD)** into a shared vault and earn the spread when flights run on time. Pricing, settlement, and payouts all happen on-chain. Off-chain keepers drive the inputs: a flight-data oracle, classifier, settlement, and per-route premium repricing.

- **Pitch deck:** [`/presentation`](frontend/public/presentation/slides.html) — 10 slides (problem, solution, architecture, oracle on Acurast TEE, the 4 keepers, XGBoost + Grok pricing brain, solvency, Monte Carlo)
- **Live Monte Carlo yield simulator:** [`/quant`](frontend/app/quant/page.tsx) — 10,000-trial
- **Frontend:** Next.js 15 dApp in `frontend/`, wired against devnet (Phantom on "Solana Devnet" connects today)

---

## 2. Live on Solana Devnet

Deployed 2026-05-08, re-deployed in place on 2026-05-11 as part of the Token-2022 / PUSD migration (program IDs unchanged).

**Hosted services (Render):**

| Service | URL |
|---|---|
| Frontend | `https://sentinel-frontend-solana.onrender.com` |
| Cron executor | `https://sentinel-executor-solana.onrender.com` |
| Pricing agent | `https://sentinel-agent-solana.onrender.com` |

**On-chain — programs (canonical IDs, identical on every cluster):**

| Program | Address |
|---|---|
| `governance` | [`6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT`](https://explorer.solana.com/address/6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT?cluster=devnet) |
| `vault` | [`3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p`](https://explorer.solana.com/address/3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p?cluster=devnet) |
| `oracle_aggregator` | [`EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`](https://explorer.solana.com/address/EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6?cluster=devnet) |
| `flight_pool` | [`GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq`](https://explorer.solana.com/address/GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq?cluster=devnet) |
| `controller` | [`G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot`](https://explorer.solana.com/address/G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot?cluster=devnet) |

**On-chain — addresses:**

| Component | Address |
|---|---|
| Cluster | `devnet` · `https://api.devnet.solana.com` |
| Deployer / owner | [`FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy`](https://explorer.solana.com/address/FA6BiUu3AwKsMziXvKdFpJd9v9Zb623AhLj9gzeNbywy?cluster=devnet) |
| Stablecoin mint — mock PUSD (Token-2022) | [`F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE`](https://explorer.solana.com/address/F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE?cluster=devnet) |
| Token-2022 program (stable side) | [`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`](https://explorer.solana.com/address/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) |
| `authorized_oracle` (FlightDataFetcher signer) | [`3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv`](https://explorer.solana.com/address/3GjTYVmMyY3H2JomUL4e7YvVYALyskAjdWrmux7i3DNv?cluster=devnet) |
| `authorized_keeper` (Classifier + Settler signer) | [`EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu`](https://explorer.solana.com/address/EXZZGnbBZAM8DKimCbpeW9BvF4TxcKe8pCYm5KfWyEJu?cluster=devnet) |

**Mainnet PUSD target:** [`CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s`](https://explorer.solana.com/address/CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s) (Token-2022). Mainnet deploy is gated — see [local_deployment_guide.md](local_deployment_guide.md).

Canonical deployment artifact on disk: `deployments/devnet-latest.json` — full PDA table, mints, authorities. Frontend + executor load it at startup.

---

## 3. Repo Layout

```
sentinel_solana/
├── contracts/             # Anchor workspace — 5 programs
│   ├── programs/
│   │   ├── governance/        # Per-route terms (premium, payout, delay threshold)
│   │   ├── controller/        # Orchestrator; owns buy/classify/settle ixs
│   │   ├── vault/             # Underwriter capital pool + RVS share mint (classic SPL)
│   │   ├── flight_pool/       # Per-flight pools + buyer records + treasury (Token-2022)
│   │   └── oracle_aggregator/ # Flight data feed; TEE-attested writes
│   └── tests/                 # LiteSVM unit + Surfpool integration
├── frontend/              # Next.js 15 dApp (App Router + framework-kit)
├── executor/              # Off-chain cron daemon (Express + node-cron, 4 jobs)
├── agent/                 # Premium pricing FastAPI service (Python, NOT in pnpm)
├── scripts/               # sync-idl, gen-clients, dev-surfpool, keys-bootstrap, deploy
├── keys/                  # Public keypairs (*.pubkey committed; *.json gitignored)
├── spec/                  # Architecture, phase plans, progress dashboard
├── deployments/           # Per-cluster deployment artifacts
├── Anchor.toml            # Anchor workspace config (program IDs pinned here)
├── Surfpool.toml          # Surfnet config (mock PUSD seed, Token-2022)
├── render.yaml            # Render blueprint — 3 hosted services
└── Makefile               # Python agent targets (install/train/serve/test)
```

---

## 4. Architecture

Five Anchor programs on Solana, driven by an off-chain executor running four keeper jobs:

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
| `flight_pool` | Per-flight pool registry + buyer records. Custodies premiums and pays out claims. Token-2022 on the stable side. |
| `vault` | Underwriter capital pool. Mints classic-SPL share tokens (RVS). Deposits, redemptions, FIFO withdrawal queue, solvency check. |
| `oracle_aggregator` | Flight-data feed. Stores ETA + actual arrival per flight. Forward-only state machine. Authority-gated writes. |

→ **Full account layouts, instruction catalog, CPI graph, PDA seeds:** [`spec/architecture.md`](spec/architecture.md)

---

## 5. Oracle — runs on a phone

Sentinel's flight-data oracle is designed to run on **[Acurast](https://acurast.com)** — a DePIN network where the workers are real Android phones, each one a hardware-attested Trusted Execution Environment (TEE).

**What runs in the TEE.** The `FlightDataFetcher` keeper. It calls the FlightAware **AeroAPI** for each flight in `ActiveFlightList` whose ETA has passed, then signs and submits `oracle_aggregator.{set_estimated_arrival, set_landed, set_cancelled}` writes to Solana. Both the AeroAPI calls and the on-chain signature originate from inside the secure chip.

**Why a phone TEE.**
- **Keys can't be extracted.** The signing key lives in attested hardware. Nobody — not even the phone's owner — can read or steal it. Solana verifies the attested signature on every write, or rejects it.
- **No central operator.** If one phone goes offline, another Acurast Processor picks up the job. We pay per run, not per server.
- **Publicly verifiable.** We can publish the hash of the code running inside the TEE. Anyone can verify what's executing on the phones matches what Sentinel claims.

**Same TypeScript runs in both postures.** The Acurast TEE is **simulation-compatible with the centralized cron** — it executes the *same* `runFetcherOnce` TypeScript function from `executor/src/core/`. The only difference is *where* the process runs and *who* holds the signer key. The on-chain surface (`OracleConfig.authorized_oracle`) is a swap-friendly indirection: it accepts writes from a TEE phone, a Switchboard SGX worker, or a centralized cron, without any contract change.

**Today's posture (hackathon demo):** the fetcher runs as a centralized cron on Render, signing as `authorized_oracle`. Same code. **Production posture:** rotate `OracleConfig.authorized_oracle` to the Acurast processor's attested key, drop the Render service, and the protocol is fully decentralized at the oracle layer — no recompile.

→ **Proof-of-concept Acurast deployments live in [`acurast/`](acurast/)** — all four crons ported as TEE-attested job scripts (`acurast.json` manifests + webpack bundles per cron). Demonstrates that Solana transactions can be signed inside the Acurast TEE via `_STD_.signers.ed25519.sign(...)` without the signing key ever leaving the secure chip. Not wired into the pnpm workspace; standalone proof.

---

## 6. Keepers — 4 off-chain crons

Four idempotent keeper jobs keep the protocol ticking. Two of them are effectively **oracles** because they write trusted data on chain (FlightDataFetcher writes flight outcomes; FlightClassifier writes the canonical "ready-to-settle" classification). The other two move money based on what those two have written.

Each keeper is a single TypeScript function in `executor/src/core/` (`runFetcherOnce`, `runClassifierOnce`, `runSettlerOnce`, `runRepricerOnce`). They run together as a `node-cron` daemon on Render, exposing an Express HTTP surface (`/api/health`, `/api/logs`, `/api/trigger/:job`). Both scheduled ticks and manual UI-triggered ticks land in the same in-memory ring-buffer log; the frontend at `/crons` proxies through to render that log in real time.

| Keeper | Frequency | Signer | Role | Writes data? |
|---|---|---|---|---|
| **FlightDataFetcher** | every 2h | `authorized_oracle` | Reads `ActiveFlightList`, calls AeroAPI for each flight whose ETA has passed by ≥1h, writes ETA / actual arrival / cancellation to `oracle_aggregator`. | **Yes — oracle** |
| **FlightClassifier** | every 1h | `authorized_keeper` | For each `Landed` / `Cancelled` flight, calls `controller.classify_flights` to transition it into `ToBeSettled{OnTime, Delayed, Cancelled}`. | **Yes — oracle** |
| **SettlementExecutor** | every 5m | `authorized_keeper` | For each `ToBeSettled*` flight, calls `controller.execute_settlements` — pays out claims, releases locked capital, drains the FIFO withdrawal queue. | No (just dispatches) |
| **RouteRepricer** | daily 00:00 UTC | deployer (governance owner) | Reprices every whitelisted route — XGBoost baseline + Grok signal → `governance.update_route_terms` / `disable_route` / `whitelist_route`. See §7. | No (writes governance) |

The `/crons` operator dashboard exposes per-cron manual triggers, a 10s-poll run history, the live `ActiveFlightList`, and mock/live API toggles so you can demo the full pipeline without burning AeroAPI or xAI credits.

---

## 7. Pricing brain — XGBoost + Grok → Governance

Routes are priced in two layers, then written on-chain by the **RouteRepricer** cron once per day.

**Layer 1 — XGBoost classifier on BTS data.** An XGBoost model trained on the U.S. Bureau of Transportation Statistics on-time-performance dataset predicts `P(delay ≥ 15min)` per `(carrier, origin, destination, departure time, distance, day of week)`. The Phase 22 FastAPI service (`agent/`) exposes this as `POST /price` and returns a PUSD premium clamped to `[$1, $5]`. Formula: `premium = clamp(1 + 4·p_delay, 1, 5)`. **Validation ROC AUC: 0.7505.**

**Layer 2 — Grok with web search (xAI Agent Tools API).** Grok queries real-time news + weather for each route via the built-in `web_search` tool and returns schema-constrained JSON: a multiplier on the base premium plus a kill-switch for unsafe conditions. A winter storm forecast bumps the premium ×1.4; an active war zone flips `disable_route: true`.

**On-chain write.** The RouteRepricer cron walks every whitelisted route, calls both layers, and applies the result via the `governance` program:

| Decision | Governance instruction |
|---|---|
| Premium changed beyond ~$0.10 drift threshold | `update_route_terms` |
| Grok flagged the route unsafe | `disable_route` |
| Conditions cleared on a route the cron previously disabled | `whitelist_route` (idempotent re-enable) |

**Idempotency rule:** the cron only re-enables routes it disabled itself. It never overrides a human admin's `disable_route` decision.

```
BTS data → XGBoost → Grok (web search) → RouteRepricer cron → governance ix
```

---

## 8. Stablecoin — Palm USD (PUSD)

Sentinel is built around **Palm USD (PUSD)** as the unit of account. Travelers pay premiums in PUSD; underwriters deposit PUSD into the vault to back claims; payouts and yield redemptions are denominated in PUSD. Every `controller.buy_insurance`, `vault.deposit / redeem / collect`, and `flight_pool.claim` instruction moves PUSD.

PUSD is a **Token-2022** mint (program [`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`](https://explorer.solana.com/address/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)).

- **Mainnet PUSD:** [`CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s`](https://explorer.solana.com/address/CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s) — `MetadataPointer` + `TokenMetadata` extensions only. **No transfer fee, no hooks, no permanent delegate, no freeze.**
- **Devnet / Surfpool / LiteSVM:** mock PUSD at [`F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE`](https://explorer.solana.com/address/F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE?cluster=devnet) — Token-2022 base layout, no extensions, so testing is unblocked and `pnpm fund-pusd` can mint test balances on demand.

The mint address is the **only** thing that changes when swapping to live PUSD on mainnet — the contracts treat the stablecoin as a single Token-2022 `Mint` address configured at init time. Same instruction set, same authority model, same accounting.

RVS vault shares stay on the **classic SPL Token** program (Sentinel-native mint, PDA-owned, no metadata needed). The protocol uses Anchor's `token_interface` module on the stable side to support both Token-2022 and classic SPL transparently — all stable transfers go through `transfer_checked`.

---

## 9. Tests

Six test surfaces, one per execution context. Each is a one-liner from the repo root.

| Surface | Runner | Count | Coverage |
|---|---|---|---|
| Anchor program unit tests | LiteSVM (vitest) | 88 | Per-instruction coverage + edge cases + auth isolation for each of the 5 programs. Runs entirely in-process — no validator, no RPC. |
| Cross-program integration | LiteSVM (vitest) | 9 | Full lifecycle: deploy → whitelist → deposit → buy → oracle write → classify → settle → claim. Three flight outcomes + withdrawal queue + solvency + auth isolation. |
| Surfpool integration | Surfpool (vitest) | 2 suites | Sanity RPC reachability + multi-actor full-flow against a live local Surfnet. Same code paths the frontend hits. |
| E2E with real crons | Surfpool (vitest) | 8 scenarios | Drives `runFetcherOnce` / `runClassifierOnce` / `runSettlerOnce` against live Surfpool with a parameterized mock AeroAPI. **Highest-fidelity test we have** — real RPC, real Anchor programs, real Codama ixs. |
| Executor unit tests | vitest | 116 | Pure unit tests on each cron's decision module, AeroAPI client + 4xx envelope decoder, Grok client + Agent Tools API decoder. |
| Agent service | pytest | 4 | XGBoost service smoke: model loads, `/price` request/response contract, `/healthz` contract, premium clamp invariant. |

**Fast local check (no infrastructure):**

```bash
pnpm typecheck && \
  pnpm test:contracts && \
  pnpm --filter @sentinel/executor test && \
  make test
```

Runs in well under a minute on a fresh checkout. The Surfpool suites need a running Surfpool + deploy — see [local_deployment_guide.md](local_deployment_guide.md).

---

## 10. Local deployment

See **[local_deployment_guide.md](local_deployment_guide.md)** for the full local setup procedure — prerequisites, one-command bring-up, mock PUSD mint, deploy runbook (Surfpool / devnet / mainnet), funding scripts, running the cron daemon locally, the e2e cron suite, and the Phase 22 pricing agent.
