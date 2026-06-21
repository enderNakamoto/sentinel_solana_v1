# Sentinel Protocol — Investment Memo

Section-for-section mirror of `deck.md`. Each section here elaborates one slide and adds the supporting research, citations, and analysis a partner needs to forward this to their IC.

Last updated: 2026-05-17. Status: actively raising.

---

## 1. One-liner

**Sentinel Protocol is a niche prediction market for flight delays — wrapped in the rails (oracle, vault, pricing brain, distribution) that turn it into parametric travel insurance. Settled on blockchain.**

Travelers pay a small premium in USDC and receive an automatic payout if their flight is delayed beyond a per-route threshold. Underwriters take the other side of every market and earn yield from on-time flights. No claim form, no adjuster, no insurer judgment. Every policy is 100% pre-funded — solvency is enforced by the protocol on every sale.

The architecture is feed-agnostic: replace "flight" with "wildfire perimeter," "hurricane category," or "crop yield" and the contracts work without structural change. Flights are the first feed because they are the cleanest. Climate risks are the destination.

The protocol is live today on **Solana devnet** and **Stellar Soroban testnet**, with full hosted infrastructure (frontend, executor crons, AI pricing service) running 24/7.

---

## 2. Problem

Travel insurance is a **$23.8B global market** in 2024[^amr], projected to reach **$132.9B by 2034 at 18.4% CAGR**. It is structurally broken because the party that decides whether to pay you is the same party that profits when it doesn't.

The numbers we cite on the slide:

| Stat | Value | Source |
|---|---|---|
| 2024 global travel insurance market | $23.8B | Allied Market Research[^amr] |
| Projected 2034 size | $132.9B | Allied Market Research[^amr] |
| Forecast CAGR | 18.4% | Allied Market Research[^amr] |
| US flight on-time arrival rate, full-year 2024 | 78.10% (= **21.9%** delayed/cancelled) | DOT Air Travel Consumer Report[^dot] |
| US travel insurance claim denial rate | 33% | Squaremouth study, via News4Jax[^squaremouth] |
| Average claim resolution time | 4–6 weeks | Industry observation; consistent with GAO travel-insurance review[^gao] |

### Concrete passenger experience (not inflated TAM)

The modal experience, not the worst case:

> A passenger pays $80 for travel insurance covering a $1,200 international ticket. The flight is cancelled due to weather; the airline rebooks them onto a flight that arrives the next day. The insurer denies the claim because the airline "provided an alternative." The passenger eats the meal/hotel cost. Their premium is gone.

Under Sentinel, the same passenger pays a **$3 premium** at booking and **$30 USDC is automatically credited to their wallet within minutes** of the oracle confirming the delay. No form. No call. No insurer judgment.

[^amr]: Allied Market Research / PR Newswire, ["Global travel insurance market size was valued at $23.8B in 2024, projected to reach $132.9B by 2034, 18.4% CAGR"](https://www.prnewswire.com/news-releases/the-global-travel-insurance-market-size-was-valued-at-23-8-billion-in-2024--and-is-projected-to-reach-132-9-billion-by-2034--growing-at-a-cagr-of-18-4-from-2025-to-2034--302605504.html). Note: estimates vary across firms; Precedence Research, Fortune Business Insights, Mordor Intelligence, and Grand View Research give 2025 figures between $22B and $31B with CAGRs between 10% and 18% — we use the Allied Market Research figure as the middle of the credible range.

[^dot]: US Department of Transportation, [Air Travel Consumer Report: December 2024, Full Year 2024 Numbers](https://www.bts.gov/newsroom/air-travel-consumer-report-december-2024-full-year-2024-numbers). 78.10% on-time arrival rate; 21.9% of flights arrived late, were cancelled, or were diverted.

[^squaremouth]: News4Jax / WJXT (Sept 2024), ["Why 33% of travelers are being denied travel insurance claims, and how to avoid it"](https://www.news4jax.com/news/local/2024/09/23/why-33-of-travelers-are-being-denied-travel-insurance-claims-and-how-to-avoid-it/). Cites Squaremouth's industry survey data. Caveat: some industry-affiliated sources report >95% claim pay-out, so the denial rate is contested; the 33% figure represents a consumer-side study and we treat it as the upper bound of credible estimates.

[^gao]: US GAO, [Report on travel insurance market consumer protections](https://www.gao.gov/assets/gao-11-268-highlights.pdf) — referenced for the structural observation that resolution timelines depend on insurer discretion.

---

## 3. The reframe — prediction market with rails = insurance

This is the section partners need to understand for the rest of the memo to make sense.

### The primitive

A flight-delay smart contract is, fundamentally, a **binary prediction market**:

- The question: "Will AA123 on 2026-05-20 arrive within 2 hours of its scheduled time?"
- YES side: someone who thinks the flight will be on time (the underwriter)
- NO side: someone who thinks it might be delayed (the traveler, who is also hedging real exposure)
- The oracle resolves the question after the fact
- The smart contract pays the winner

This is exactly the Polymarket primitive, applied to flights.

### What turns the primitive into insurance

Four rails:

1. **Oracle** that resolves the outcome without trusting any single party (we use Acurast TEE — see §5)
2. **Vault** that pre-funds every payout so the YES side cannot default (`vault_program` — see §4)
3. **Pricing brain** that quotes a premium accurate enough that the YES side has positive EV in aggregate (XGBoost + Grok — see §6)
4. **Distribution** that meets travelers in the moment of purchase decision (Chrome extension — see §12)

Without (3), nobody underwrites. Without (2), nobody trusts the underwriter. Without (1), the contract can't settle. Without (4), nobody buys. We build all four.

### Why this framing wins

**For the investor:** prediction markets have just normalised on-chain real-world settlement. Polymarket settled over $1B on the 2024 US election; Kalshi is licensed in the US. The primitive is no longer exotic. Sentinel takes the same primitive and points it at a market 10× larger than political prediction.

**For the traveler:** the traveler doesn't care that they're betting against an algorithmic market-maker. They see a familiar product (insurance) at a familiar price ($3) with a better outcome guarantee (automatic).

**For the regulator:** parametric insurance is well-understood. Prediction markets have an evolving but increasingly clear regulatory frame. Sentinel sits at the well-established side of both worlds.

### Why we are uniquely positioned

Three teams could in principle build this:

1. An insurance incumbent — has distribution but won't cannibalise its denial-rate margin.
2. A prediction-market team (Polymarket, Kalshi) — has the primitive but not the insurance-product-thinking or oracle infrastructure for per-event resolution at flight scale.
3. A blockchain-native team with insurance instincts (us).

We are option 3. The two co-founders together cover prediction-market mechanics, financial-primitives engineering, applied ML, and frontend distribution. There is no other team in the Solana or Stellar ecosystem currently building this exact stack.

---

## 4. Product (1/3) — Protocol architecture

The on-chain protocol is **5 contracts plus 4 off-chain keeper crons**, all denominated in USDC.

### The five smart contracts

We split the protocol into five contracts (vs one mega-contract) for two reasons: independent audit surface, and authority isolation — a compromised oracle key can never trigger a payout because the oracle and the money-moving programs sit in separate contracts.

| Contract | Role | Why separate |
|---|---|---|
| `governance` | Per-route terms (premium, payout, delay threshold), route whitelist, admin layer | Independent admin concern, rarely called |
| `vault` | Underwriter capital pool. Mints share tokens (RVS) on classic SPL. ERC-4626-style accounting with virtual-offset defence against inflation attacks. FIFO withdrawal queue. | Underwriters interact directly; independent upgrade cycle |
| `flight_pool` | Per-flight pool registry. Per-buyer records. Shared treasury for premiums and payouts. | Owns user-facing flight funds — isolated audit surface |
| `oracle_aggregator` | Flight-data feed. ETA + actual arrival per flight. Forward-only state machine. Three authority types (owner, rotatable authorized_oracle, one-shot consumer). | Authority isolation — oracle keypair compromise cannot trigger payouts |
| `controller` | Orchestrator. Owns user-facing instructions: `buy_insurance`, `classify_flights`, `execute_settlements`. CPIs into the other four. | Single place where multi-contract logic lives |

### The four off-chain keeper crons

Each keeper is a single idempotent TypeScript function. Together they keep the protocol ticking.

| Keeper | Cadence | Signer | Writes to |
|---|---|---|---|
| FlightDataFetcher | 2h | `authorized_oracle` | `oracle_aggregator` (ETA, landed, cancelled) |
| FlightClassifier | 1h | `authorized_keeper` | `controller.classify_flights` (→ `ToBeSettled*`) |
| SettlementExecutor | 5m | `authorized_keeper` | `controller.execute_settlements` (money movement) |
| RouteRepricer | 24h | governance owner | `governance.update_route_terms` / `disable_route` / `whitelist_route` |

The crons run as a `node-cron` daemon on Render today. They are being migrated to Acurast TEE (§5).

### Token model

- **Stable side: USDC** — Token-2022 on Solana, Stellar Asset Sandbox USDC on Soroban. The contracts use Solana's `token_interface` to handle USDC transparently. **The USDC mint is the only address that changes** when swapping between testnet and mainnet.
- **Share side: RVS** (Reserve Vault Share) — a Sentinel-native classic SPL mint, PDA-owned. ERC-4626-style accounting with virtual offset.

---

## 5. Product (2/3) — Decentralised oracle (DePIN)

This is one of three places the moat compounds.

### What runs where

The FlightDataFetcher and FlightClassifier are designed to run inside a hardware-attested **Trusted Execution Environment (TEE)** on the [Acurast DePIN network](https://acurast.com) — a network of real Android phones, each one an attested secure-element node.

The TypeScript code is deployed straight to the phone's secure chip. Both the FlightAware AeroAPI HTTP call **and** the signed transaction submission to Solana / Soroban happen from inside the TEE. The signing key never leaves the secure chip; even the phone's owner cannot extract it.

The blockchain verifies the attested signature on every oracle write, or rejects it. The code hash running inside the TEE is publishable — anyone can verify the oracle they trust is what's actually running.

### Why this is the moat (and not just nice)

Most parametric insurance products either:
- Trust a centralised oracle (defeats the whole point of being on-chain), or
- Rent SGX servers (~$2k/month, defeats the cost model at parametric premiums)

Acurast TEE on retired Android phones is the first option that is both **trustless** and **cheap enough to fit the unit economics**. The network pays per run, not per server. If one phone goes offline, another picks up the job.

We have already shipped a proof-of-concept: all four keepers ported as Acurast jobs (in the `acurast/` folder of the repo) demonstrating that Solana transactions can be signed inside the Acurast TEE via `_STD_.signers.ed25519.sign(...)` without the signing key ever leaving the secure chip.

### Cost scaling is the operational moat

A naive insurer polls every flight, every hour. We don't.

- Flights enter the oracle's `ActiveFlightList` only **when someone buys coverage**
- We only call the AeroAPI **after** the flight should have landed (ETA + 1h)
- The moment a flight settles, it drops off the list

Cost scales linearly with **active policies**, not with global flight volume. AeroAPI is approximately $0.001 per call. The marginal cost of one more policy is approximately one AeroAPI call. **Effectively zero.** This is the core reason an automated parametric protocol can underwrite at fees a traditional insurer can't.

---

## 6. Product (3/3) — AI pricing brain

The third place the moat compounds. Better pricing = better underwriter EV = deeper liquidity = bigger policies we can sell = more pricing data = better pricing. Classic data flywheel.

### Layer 1 — XGBoost on BTS data (the historical baseline)

We trained an XGBoost classifier on the [US Bureau of Transportation Statistics on-time-performance dataset](https://www.bts.gov/topics/airlines-and-airports/understanding-reporting-causes-flight-delays-and-cancellations). The model predicts `P(delay ≥ 15 min)` per `(carrier, origin, destination, departure_time, distance, day_of_week)`.

- **Validation ROC AUC: 0.7505** (notebook reproducibility: 0.7497; delta within ±0.005 gate)
- Premium formula: `clamp(1 + 4·p_delay, 1, 5)` USDC
- Served from a Python FastAPI service (`agent/`) at `sentinel-agent-solana.onrender.com`
- Returns both `premium_usdc: float` and `premium_base_units: int` (= `round(usdc * 1_000_000)`) for direct on-chain consumption

ROC AUC of 0.75 on flight-delay prediction is a strong baseline — well above the 0.65–0.70 typical of single-feature models, comfortably below the 0.85+ that would suggest overfitting on a noisy signal. The model is intentionally calibrated to be honest about uncertainty.

### Layer 2 — Grok with live web search (today's signal)

History doesn't know about today's hurricane, today's ATC strike, or today's war. So every day the RouteRepricer cron asks Grok (xAI Agent Tools API) — with the live `web_search` tool — what's happening on each whitelisted route.

Grok returns schema-constrained JSON: a multiplier on the base premium plus a kill-switch flag for unsafe conditions.

- **Storm coming?** Multiplier ×1.4 → premium $1.76 → $2.46
- **War zone?** `disable_route: true` → no new policies sold

### Layer 3 — Governance write (the on-chain output)

The RouteRepricer cron walks every whitelisted `RouteAccount`, calls both layers, applies the result via the `governance` program:

| Decision | Governance instruction |
|---|---|
| Premium changed beyond ~$0.10 drift threshold | `update_route_terms` |
| Grok flagged the route unsafe | `disable_route` |
| Conditions cleared on a route the cron previously disabled | `whitelist_route` (idempotent re-enable) |

**Idempotency rule:** the cron only re-enables routes it disabled itself. It never overrides a human admin's `disable_route` decision.

### Known limitations (deferred)

We are being explicit because investors will ask:
- The model's training target (`dep_delayed_15min`) is a proxy for Sentinel's actual payout trigger (`Delayed` or `Cancelled` per per-route threshold). The model will be retrained on real settlement data once we have a few thousand observations on mainnet.
- No probability calibration yet (Platt / isotonic). If predictions bunch in production we'll add it.
- The pricing agent is unauthenticated today (same trust boundary as the cron). Authentication is in the Q1 hardening list.

---

## 7. Why now

Three things just became true at the same time. Each existed in some form before, but the combination is new.

### 1. Prediction markets crossed the chasm

- **Polymarket** settled **over $1B in trades on the 2024 US presidential election** alone[^pmstats]
- **Kalshi** is **regulated and licensed by the CFTC** as a Designated Contract Market
- Both have normalised the consumer behaviour of betting on real-world outcomes on-chain (or on-exchange) and the regulatory frame around it
- This is **the** primitive Sentinel reuses

### 2. Stablecoin rails on Solana / Stellar are now mature

- USDC has native deployments on both chains
- A Solana `buy_insurance` transaction (6 CPIs across 5 programs) costs sub-cent
- The same flow on Ethereum mainnet in 2022 would have cost more than the premium itself
- The cost of on-chain settlement has dropped below the cost of claim adjudication — for the first time, the on-chain product is actually cheaper

### 3. DePIN unlocks trustless oracles without enterprise hardware

- Acurast went production-ready in 2025
- The cost of an attested signature dropped from "$2k/month SGX server" to "fraction of a cent per call"
- This is the first cost structure where a decentralised flight-delay oracle is actually viable

[^pmstats]: Polymarket 2024 election market volume — widely reported across [Bloomberg](https://www.bloomberg.com), [Reuters](https://www.reuters.com), [The Block](https://www.theblock.co); aggregated to >$1B in election-related trades.

---

## 8. Market

### TAM, SAM, SOM with sources

| Layer | Size | Source |
|---|---|---|
| **TAM** — Global travel insurance, 2024 | $23.8B | Allied Market Research[^amr] |
| **TAM** — Projected 2034 | $132.9B at 18.4% CAGR | Allied Market Research[^amr] |
| **SAM** — Parametric / flight-disruption sub-segment | ~$12B today (est.) | Internal estimate from parametric share of broader market |
| **SOM** (Year 1) — Crypto-native travelers + DeFi underwriters | $5–15M premium volume | Internal target, derived from Solana DeFi TVL benchmarks |
| **Adjacent** — Global parametric insurance | $19.4B (2025) → $34.6B (2032) | SNS Insider[^sns] |
| **Ceiling** — Cumulative uninsured climate losses (40 yrs) | $2.9T | Swiss Re[^swissre] |
| **Ceiling** — Annual nat-cat protection gap | $181B uninsured in 2024 | Swiss Re[^swissre] |

### Why the TAM number matters less than the ceiling

The Year-1 SOM is the number we will be measured on. The TAM matters because it tells you the ceiling isn't where we hit it. But the **real** ceiling is the climate protection gap.

**In 2024 alone**, global economic losses from natural catastrophes totalled $318B. Only $137B (43%) was insured. **$181B of climate damage was uninsured in a single year.**[^swissre] Cumulatively over the last 40 years, $2.9T of climate-related losses have been uninsured.

Parametric insurance is one of the only product structures that can credibly close that gap, because traditional adjudicated insurance does not scale to events where 100,000 simultaneous claims arrive on the same day (hurricane, wildfire, earthquake). The architecture Sentinel ships for flights is the architecture that closes that gap.

### Existing competition (deeper analysis)

| Competitor | Status | Why we win |
|---|---|---|
| **AXA Fizzy** (2017–19) | Discontinued | Centralised oracle and balance-sheet capital killed it; our oracle is decentralised and our capital is DeFi-native |
| **Etherisc Flight Delay**[^etherisc] | Live on Gnosis Chain | Static premium ($15 fixed); centralised oracle backend (Chainlink); no AI pricing layer. We out-price them on accuracy. |
| **Polymarket / Kalshi flight markets** | Theoretical | Their cost-per-market exceeds premium scale; their UX is speculation, not insurance |
| **Traditional insurers (AIG, Allianz)** | Massive scale | Their incentive is denial; ours is accuracy. Different game. |

[^sns]: SNS Insider via Yahoo Finance, ["Parametric Insurance Market Size to Surpass USD 34.62 Billion by 2032"](https://finance.yahoo.com/news/parametric-insurance-market-size-surpass-092500505.html). Alternative estimates from Global Market Insights ($63.8B by 2035 at 12.2% CAGR) and Research Nester ($46B by 2035) are in the same order of magnitude.

[^swissre]: Swiss Re Institute, [Closing the natural catastrophe protection gap](https://www.swissre.com/institute/research/topics-and-risk-dialogues/climate-and-natural-catastrophe-risk/Closing-the-natural-catastrophe-protection-gap.html); [Mitigating climate risk](https://www.swissre.com/risk-knowledge/mitigating-climate-risk.html). 2024 global nat-cat losses: $318B economic / $137B insured.

[^etherisc]: Etherisc Flight Delay product overview — [Etherisc Medium](https://medium.com/@etherisc/etherisc-launches-decentralized-flight-insurance-product-using-chainlink-data-feeds-a5e9ac5e0476), [Chainlink Today](https://chainlinktoday.com/etheriscs-flightdelay-transforms-flight-insurance-with-chainlink-oracles/). Live on Gnosis Chain (formerly xDai), purchasable with USDC, 45-minute delay threshold, $15 fixed premium.

---

## 9. Current development stage

Two live testnet deployments. Production-ready architecture. Mainnet is a deploy command after audit.

### Solana devnet

Deployed 2026-05-08; re-deployed in place 2026-05-11 during the Token-2022 migration. Program IDs unchanged across re-deploys.

- **5 Anchor programs** verified on-chain, identical IDs on every cluster:
  - `governance`: `6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT`
  - `vault`: `3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p`
  - `flight_pool`: `GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq`
  - `oracle_aggregator`: `EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`
  - `controller`: `G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot`
- **Hosted services on Render** running 24/7:
  - Frontend: <https://sentinel-frontend-solana.onrender.com>
  - Cron executor: <https://sentinel-executor-solana.onrender.com>
  - Pricing agent: <https://sentinel-agent-solana.onrender.com>
- Wallet Standard connect (Phantom on "Solana Devnet")
- Full PDA / address table in `deployments/devnet-latest.json` (in the repo)
- ~11.2 SOL spent on deploys + re-deploys; ample headroom for further iteration

### Stellar Soroban testnet

Mirror deployment on Stellar's smart-contract platform. The Soroban contract suite is the chain-portable parity layer for the Solana protocol.

- Contract APIs are isomorphic to the Solana deployment — same instruction shape, same authority model
- USDC handled via Stellar Asset Sandbox
- Vault math derives from the **OpenZeppelin Soroban Library SEP-56 (Soroban's ERC-4626)** standard — co-founder (JsMaxi) is a contributor to that library

### Why multi-chain from day one

This was not a Solana-first build with Stellar bolted on as an afterthought. It was designed multi-chain.

Three reasons:

1. **Different liquidity pools.** Solana DeFi and Stellar DeFi capital are largely disjoint. Two deployments give us access to both underwriter capital bases.
2. **Different distribution surfaces.** Phantom + Solflare on Solana; Freighter + Albedo on Stellar. Different user segments.
3. **Risk hedge for institutional underwriters.** A future institutional LP (foundation, family office) doing $5M+ tickets will not be comfortable single-chain. Multi-chain is a precondition for that capital.

The off-chain executor and pricing agent are chain-agnostic (they wrap typed clients). A single keeper invocation can write to both chains.

---

## 10. Traction

This is not a deck-and-vibes pitch. The protocol exists, runs, and is tested.

### Test coverage

| Surface | Count | Notes |
|---|---|---|
| LiteSVM unit tests (per Anchor program) | 88 | All 5 programs, including ERC-4626 inflation-attack defence on vault |
| LiteSVM cross-program integration | 9 | Full lifecycle: deploy → whitelist → deposit → buy → oracle → classify → settle → claim |
| Surfpool integration | 2 suites | Multi-actor full-flow against live local Surfnet |
| Surfpool E2E with real crons | 8 scenarios | Drives real `runFetcherOnce` / `runClassifierOnce` / `runSettlerOnce` against parameterised mock AeroAPI |
| Executor unit tests | 116 | AeroAPI client incl. 4xx envelope, Grok client + Agent Tools decoder, decision modules |
| Pricing agent (pytest) | 4 | Model loads; `/price` contract; `/healthz`; premium-clamp invariant |
| **Total passing** | **227+** | Runs in well under a minute on a fresh checkout |

### Production signals on devnet

- Three hosted services running 24/7 on Render (frontend, executor, pricing agent)
- Four keeper crons running on schedule (Fetcher 2h, Classifier 1h, Settler 5m, Repricer daily)
- 8 E2E scenarios validated against live Surfpool
- Operator dashboard at `/crons` exposes per-cron manual triggers, 10s-poll run history, live `ActiveFlightList`, mock/live API toggles

### Acurast TEE proof-of-concept

All four keepers ported as Acurast `acurast.json` job manifests with webpack bundles. Demonstrates that Solana transactions can be signed inside the Acurast TEE without the signing key ever leaving the secure chip. Standalone proof, not yet wired into the production keeper rotation (Q2 milestone).

### What we do not yet have

Calling this out explicitly because investors will:
- No mainnet deployment yet (gated on audit — included in the round)
- No paid users (we are pre-revenue; underwriter capital will seed at round close)
- No security audit yet (line-item in the use of funds)

---

## 11. Business model

The protocol earns at three points and we are leaning into the first two for the seed era.

### Revenue mechanics

1. **Protocol take rate on premium volume** — primary revenue line. Configurable per route by governance; 1–3% in V1. Set as a parameter; not a code change.
2. **Future RVS share-token AMM fees** — when we launch a secondary market for RVS shares (deferred to post-mainnet), the protocol takes a swap fee on every trade.
3. **Governance-controlled spread on volatile routes** — for routes where the AI model has low confidence or Grok returns a high uncertainty signal, governance can widen the price-to-payout ratio. The realised spread compounds into protocol-owned capital.

### Single-policy unit economics

```
TRAVELER buys insurance on AA123:
  Pays:      $3.00 USDC premium
  Receives:  Right to $10.00 USDC if delayed/cancelled

VAULT locks $10.00 of underwriter capital against this policy.
  Solvency check fires: vault has $X free capital ≥ $10? Sale allowed.

PROTOCOL FEE taken upfront: $0.06 (2% of premium).

OUTCOME 1 — Flight on time (80% historical base rate, US 2024):
  Underwriter receives:   $2.94 net of protocol fee
  Capital unlocked back to vault.

OUTCOME 2 — Flight delayed/cancelled (22% historical):
  Traveler receives:      $10.00 USDC
  Underwriter covers:     $7.00 net of premium
  Protocol fee was already taken upfront.
```

**Underwriter EV per policy:**
```
EV = (0.80 × $2.94) + (0.20 × -$7.00) = +$0.952
```

Underwriter EV is positive **as long as the realised delay rate for that route stays below 29.4%**. Our pricing engine (§6) keeps the realised rate below the priced rate.

### Why scaling improves the model

At $10M cumulative premium volume:
- Protocol gross revenue: $200k–$300k (1–3% of $10M)
- Concurrent locked liability handled by the vault: $30M+
- Marginal cost of one more policy: one AeroAPI call = $0.001 = effectively zero

Most insurance scales costs with claim volume (you need an adjuster headcount that scales with claim count). Sentinel scales costs with **oracle calls**, which are bounded by the number of policies, not the number of incidents. This is the structural cost advantage that lets a protocol underwrite at fees a traditional insurer cannot.

### Where the moats compound

Three places, in order of how fast they accrue:

1. **Pricing accuracy** (the fastest moat). Every settled flight = one row of training data. After 10k policies we have meaningful per-route signal traditional carriers don't have. After 100k policies the model is materially better than any static-pricing competitor. **Better pricing → better underwriter EV → deeper liquidity → larger policies → more data.** Classic flywheel.

2. **Oracle infrastructure** (the structural moat). Once Acurast TEE is in production, a competitor has to also stand up TEE-attested keepers to match. The capex is small but the engineering complexity is real, and we've shipped the POC.

3. **Distribution at booking moment** (the strategic moat). Ring 2 (the Chrome extension on OTA pages) is a position competitors have to **displace**, not match. Travelers don't shop for insurance separately; they accept the offer that's already on the booking page.

---

## 12. Go-to-market

Three concentric distribution rings. Each ring's economics fund the next. We deliberately do not boil the ocean.

### Ring 1 — Crypto-native (today through Q3 2026)

**Distribution:**
- Direct dapp at `sentinel-frontend-solana.onrender.com`
- Wallet Standard connect on Solana (Phantom, Solflare)
- Equivalent connect on Stellar (Freighter, Albedo) for Soroban deployment
- Two pages drive the loop:
  - `/earn` for underwriters — deposit USDC, see expected yield, manage withdrawals
  - `/buy` for travelers — pick whitelisted route, pay $1–$5 premium for $10 payout

**Channels:**
- **Underwriter side:** DeFi-yield-seeker channels — Crypto Twitter, Solana Discord ecosystem, yield aggregator newsletters. The pitch is **"uncorrelated yield from flight on-time rates — not crypto cycles."**
- **Traveler side:** crypto-Twitter frequent flyers, conference-circuit users.

**Why first:** crypto-native users tolerate the rough edges (Phantom wallet, "live on devnet") and care about yield. They fund the protocol while we build the consumer surface for Ring 2.

**Goal at month 18:** $10M cumulative premium volume.

### Ring 2 — Crossover via Chrome extension (Q4 2026)

**Distribution:** MV3 Chrome extension that injects "Add flight delay insurance — $3" at the booking moment on Expedia, Kayak, Google Flights, and direct airline pages.

The architecture is already built for this: the Codama-generated typed clients used by the dapp work unchanged inside an extension service worker. We are not building anything new; we are repackaging the existing client.

**Why second:** OTA booking pages are the **purchase-decision moment** — the user is already deciding to spend hundreds of dollars and is psychologically primed to buy insurance. The conversion math for inline-at-booking insurance is an order of magnitude better than insurance bought separately.

**Goal at month 18:** 5,000 monthly extension users.

### Ring 3 — Mainstream (2027+)

**Distribution:** Walletless onboarding via Privy embedded wallet + sponsored gas. Users pay with a credit card, receive payouts in USD, never see the wallet UX. For airline / OTA partnerships, we offer a revenue-share on policies sold through their surface — a friendlier deal than traditional insurance affiliate programs (which are zero-sum with the insurer's denial rate).

**Why last:** Walletless mainstream onboarding is the most expensive growth motion and the one with the highest CAC. We only burn capital on it after Ring 1 has proven the math and Ring 2 has proven the distribution surface.

### Capital efficiency by construction

None of the three rings requires us to buy users at venture scale. Ring 1 is organic (yield + crypto-Twitter). Ring 2 is distribution (extension on existing high-intent surfaces). Ring 3 is partnerships (airline / OTA rev-share). The capital we are raising is for **protocol**, not for **ads**.

---

## 13. Team

We are listing the team detail in §13 to mirror the deck order. Per Speedrun's note that "investors flip to the team page first," we re-emphasise: there is no marketing co-founder on this team. Both founders ship production code.

### Ender (Saurav Dhar) — co-founder, full-stack

- **Based in:** Berkeley, California
- **10+ years** as a software engineer across web2 and web3
- **Founding Engineer** at a Boost VC–backed startup that was acquired
- **2 years in blockchain** — Solidity smart contracts, Rust (Anchor and Pinocchio), applied zero-knowledge proofs
- Comfortable across the whole stack: programs, executor, frontend, ML serving
- Personally lived the motivating story for this product (Northern California wildfire claim that took months and ended in a denial)

### JsMaxi (Jonas) — co-founder, frontend lead

- **Based in:** Vilnius, Lithuania
- **8 years** as a software developer, most of it in a big-bank platform engineering team — i.e., shipped financial-primitives code in a regulated production environment before
- Frontend specialist: React, TypeScript, Angular
- **2 years in blockchain** across Solidity, Move, and Rust
- **Open-source contributor to the [OpenZeppelin Soroban Library](https://github.com/OpenZeppelin/stellar-contracts)**, specifically the SEP-56 vault contracts (Soroban's equivalent of ERC-4626) — the vault math in `vault_program` is informed by the same primitives

### Why this team for this problem

- Both founders have shipped financial-primitives code to production. One in TradFi, one in DeFi.
- One of us has lost a flight to weather, paid for traditional travel insurance, and waited six weeks for a denial. The motivation is personal, not theoretical.
- We can build the whole stack — programs (Anchor + Soroban), executor (TypeScript + Python ML), frontend (React + framework-kit), AI pricing (XGBoost + Grok integration), DePIN (Acurast TEE) — without external dependency.
- We have been building together remotely for six months.

### What's missing — and named hires

- **Hire 1 (Q1):** Senior backend / keepers engineer. Owns the production cron rotation, Acurast TEE migration, AeroAPI fallback redundancy.
- **Hire 2 (Q3):** Growth lead. Owns Ring 2 distribution — Chrome extension partnerships, OTA outreach, content marketing for both crypto and mainstream audiences.

Both hires sized into the round's $750k team budget.

---

## 14. Vision — 5-year horizon

### The wedge is flights. The destination is parametric climate insurance.

Flights are the cleanest possible first feed: binary outcomes, settled the same day, public data, decades of historical training data, low oracle cost per policy. If parametric on-chain insurance works anywhere, it works here first.

But the architecture is **feed-agnostic by design**. The `oracle_aggregator` program is a generic authority-gated forward-only state machine. The `flight_pool` program is a pool of per-event policies with a shared treasury. Swap "flight" for "wildfire perimeter," "hurricane category at landfall," "crop yield at harvest" — **nothing structural about the protocol changes.**

### Why climate matters now

Climate change has made parametric insurance one of the only viable ways to insure many real-world risks. Traditional reinsurance is pulling back from California wildfire, Florida hurricane, Caribbean storm. **Swiss Re reports that $2.9T in cumulative climate-related losses over the last 40 years went uninsured.[^swissre]** Most of that gap can only realistically be closed by parametric products with reliable oracle feeds — exactly the architecture Sentinel is shipping for flights.

### The five-year roadmap, by feed

| Year | Feed | Why this feed at this stage |
|---|---|---|
| 2026 | Flights | First feed; cleanest binary outcome; we're already there |
| 2027 | Wildfire (CalFire / NIFC perimeter data) | Co-founder's personal motivation; California insurance market in crisis |
| 2027–28 | Hurricane (NOAA landfall category) | Caribbean + US Gulf gap; insurers retreating |
| 2028–29 | Crop (USDA NASS yield reports) | Index-based ag insurance; clean public data |
| 2030+ | Multi-feed CAT-bond–style underwriter pool | Underwriter capital diversifies across feeds |

### What that looks like in 2030

- Sentinel runs as a **multi-feed parametric insurance protocol** with TEE-attested oracles for flight, wildfire, hurricane, and crop feeds.
- Underwriter capital sits in a single USDC vault that diversifies across all feeds — the same property that makes traditional reinsurance work, but on-chain and verifiable.
- Distribution split: 30% direct (dapp + extension), 40% partner-OTA / partner-airline, 30% B2B2C via aggregator partners (Polymarket-style risk markets, DeFi yield-as-a-service).
- The protocol is governed by a tokenised DAO of underwriters; the founding team has stepped back to a council role.

### The endgame positioning

**Sentinel becomes the default settlement rail for parametric insurance — the protocol climate-risk feeds plug into the way price feeds plug into Chainlink today.**

---

## 15. 12-month plan

The seed round funds 18 months of runway; here is what we will have shipped at month 12 (the checkpoint before the next raise window opens at month 14–16).

### Quarter 1 (months 0–3) — Audit & harden

- Sign **two independent Anchor audits** across the 5-program stack ($200–300k of the round)
- Sign one Soroban audit for the parity contracts ($100k)
- Address all critical and high findings
- Open the audit reports publicly on GitHub
- Set up a public bug bounty (modest, $25–50k pool)
- **Hire 1 (senior backend / keepers engineer) starts week 4**

### Quarter 2 (months 3–6) — Mainnet launch

- Deploy 5 programs to **Solana mainnet**
- Deploy parity suite to **Stellar Soroban mainnet** (where applicable)
- Seed vault with $750k round capital + matched underwriter LP contributions
- Whitelist top 100 US domestic routes (BTS-dense)
- **Migrate centralised Render cron executor → Acurast TEE production**
- Soft launch — invite-only; ~100 underwriters, ~500 travelers

### Quarter 3 (months 6–9) — Public launch + Chrome extension MVP

- Open `/buy` and `/earn` to the public
- Ship Chrome extension MVP on **Kayak** (one OTA surface to start)
- First marketing push:
  - DeFi yield channels (Ring 1)
  - Travel/productivity channels (Ring 2)
- **Hire 2 (growth lead) starts**
- **Target: $1M cumulative premium volume by end of Q3**

### Quarter 4 (months 9–12) — Expand & prove the wedge

- Chrome extension expansion: **Expedia, Google Flights**
- Add 200 international routes (subject to AeroAPI coverage + Grok geopolitical-risk audit)
- Begin prototype of **wildfire-feed parametric** (CalFire perimeter API → oracle proof-of-concept on devnet)
- **Target: $5M cumulative premium volume; 2,500 MAU on Chrome extension; 250 active underwriters**

### Capital allocation summary

| Bucket | $ | Notes |
|---|---|---|
| Audit + formal verification | 400k | Two Anchor firms + one Soroban firm, sequential not parallel |
| Initial vault seed | 750k | Underwriter capital to unblock policy capacity from day one |
| Team (2 hires × 18 mo) | 750k | Senior backend + growth lead, loaded cost |
| Legal + insurance regulatory | 250k | Parametric insurance review in US, EU, Singapore |
| Infrastructure (Acurast, RPC, monitoring) | 200k | Production Acurast TEE processors; Helius RPC; monitoring |
| Reserve | 150k | 18-month buffer |
| **Total** | **2.5M** | |

### Numerical milestones — month 18

- Mainnet live, audited, on Solana **and** Soroban
- $10M cumulative premium volume
- 5,000 monthly Chrome extension users
- 500 active underwriters
- Wildfire parametric prototype live on devnet (climate-feed wedge)
- Acurast TEE running in production

### Three named risks — and the mitigations

These three are the ones we can already articulate; the memo would be dishonest without them.

**1. Underwriter cold-start.** If vault capacity stays below ~$2M, policy payoffs cap out small and Ring 1 yield-seekers won't show up. **Mitigation:** $750k seed capital from the round; co-marketing with USDC-aligned vault partners; protocol-owned liquidity accruing from take-rate revenue from week one.

**2. AeroAPI single-source dependency.** FlightAware AeroAPI is our only flight-data source today. **Mitigation:** the oracle architecture is backend-agnostic. In Q3 we begin integrating a secondary source (FlightStats or OAG) so the keeper can cross-check both feeds before signing.

**3. Parametric insurance regulatory ambiguity.** Three jurisdictions (US, EU, Singapore) need a written legal opinion. **Mitigation:** the $250k legal line item exists for this. The dapp can geo-fence at the frontend if needed; the protocol itself does not pretend to be a regulated insurance product — it is a prediction market with rails (see §3).

---

## 16. The Ask

**Raising $2.5M seed. 18-month runway. Audited mainnet on Solana and Soroban, $10M cumulative premium volume, 5k MAU on Chrome extension.**

### Use of funds (mirrors §15 capital allocation)

| Bucket | $ | What it buys |
|---|---|---|
| Audit + formal review | 400k | Two Anchor firms + one Soroban firm. Sequential. Reports public. |
| Initial vault seed | 750k | Underwriter-side capital so day-one policies aren't capacity-gated |
| Team (2 hires × 18mo) | 750k | Senior backend engineer + growth lead, fully loaded |
| Legal + insurance regulatory | 250k | Written opinions in US, EU, Singapore |
| Infrastructure (Acurast, RPC, monitoring) | 200k | Production Acurast TEE; Helius RPC; Sentry-equivalent monitoring |
| Reserve | 150k | 18-month buffer |
| **Total** | **2.5M** | |

### Round structure

- **Lead status:** $1M anchor commitment from a strategic Solana-ecosystem fund (subject to confirmation at signing)
- **Looking for:** one co-lead at $750k–$1M; 2–3 angel checks of $50–150k each
- **Instrument:** SAFE, post-money valuation cap negotiable in the conversation
- **Pro-rata:** standard pro-rata rights for all participants in the next round

### Why we can defend every line

- **Audit budget** reflects two contract suites in two languages (Rust/Anchor + Rust/Soroban) — not one contract suite at $300k.
- **Vault seed** is the difference between "policies cap out at $1k" and "policies work for any business traveler" on day one.
- **The two hires** close two specific weaknesses we can name today.
- **The legal line** is real because parametric insurance is a regulated category in some jurisdictions and we want a written opinion before we accept paying travelers from those jurisdictions.

### What you get

- A protocol that runs today on two testnets
- A team that has shipped before, in TradFi and DeFi
- An architecture that extends from flights to climate without rewrites
- An 18-month plan with three named risks and named mitigations
- Pro-rata rights into the next round, where the climate-feed expansion begins

We are not asking you to fund vibes. The protocol exists. The thesis is testable in 18 months. The team is two operators, not a roadshow.

---

*Memo last updated: 2026-05-17. For the latest version, see `pitch/memo.md` in the [repository](https://github.com/enderNakamoto/sentinel_solana).*
