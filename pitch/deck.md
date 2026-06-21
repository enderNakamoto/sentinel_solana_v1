# Sentinel Protocol — Pitch Deck

16 slides. Structured on the a16z 10-slide spine plus four explicit slides the team wants (Product split into 3, plus Current Dev Stage, plus Vision, plus 12-Month Plan).

The companion document `memo.md` mirrors this deck slide-for-slide with source citations.

Each slide block contains:
- **Headline** — the line largest on the slide
- **On slide** — bullets, numbers, visuals
- **Talk track** — what the presenter says (not on the slide)

---

## Slide 1 — Title

**Headline:** A niche prediction market for flight delays.

**Subtext:** It works as **parametric insurance**. Settled automatically on-chain. Paid out in **stablecoins**. Prediction markets, pointed at something useful.

**Talk track:** Underneath, we are a focused two-sided prediction market — flight delayed yes / no. On top, we wrap that with the rails that turn it into something a traveler recognises: parametric flight insurance. Same primitive Polymarket uses for politics, pointed at something useful, and built blockchain-native from day one.

---

## Slide 2 — Problem

**Headline:** Both sides are *broken.*

**Subtext:** Travelers don't trust the payouts. Underwriters can't find real yield.

**Two columns:**

*Left — For travelers:*
- Headline: **Travel insurance is *adversarial.***
- Whoever decides if you get paid is the same party that profits when you don't. Forms, adjusters, weeks of waiting — all downstream of that one misalignment. The result is an *opaque and slow* system.
- **33%** claims denied · **4–6 wks** to resolve · **$23.8B** market size

*Right — For DeFi yield:*
- Headline: **Real yield is *scarce.***
- Returns are paid in vaporware governance tokens and rise and fall with the crypto cycle — not with anything that exists off-chain.
- **Vaporware emissions** — farm tokens, not cash flow
- **Crypto-correlated** — TVL moves with BTC and ETH
- **No off-chain premium** — nothing real to underwrite

**Talk track:** This is not a UX problem on either side. On the traveler side it's an incentive problem — the party that decides if you get paid profits when you don't. On the DeFi side it's a yield problem — emissions priced in farm tokens, correlated with crypto, with no off-chain cash flow anywhere in the stack. Sentinel solves both at once: the parametric oracle replaces the human adjuster, and the premiums travelers pay become the yield underwriters earn — denominated in USDC, uncorrelated with crypto.

---

## Slide 3 — The Solution

**Headline:** Parametric insurance, built on *prediction-market* rails.

**Subtext:** Travelers hedge against delays. Underwriters get paid when flights land on time. The contract settles automatically.

**Four cards:**

1. **Settled automatically** — Flight delayed? Payout in minutes. No forms, no adjusters.
2. **Contract is the policy** — Every rule lives on-chain — fully transparent. No fine print, no hidden clauses.
3. **100% backed** — Every policy pre-funded. Solvency is enforced by the smart contract.
4. **ML-priced yield** — An AI agent trained on 5 years of BTS data prices each route — minimizing risk for underwriters.

**Talk track:** Underneath, this is a prediction market — "will AA123 land on time?" with a YES side (underwriters) and a NO side (travelers). On top, the rails turn it into something a traveler recognises: parametric flight insurance. Same primitive Polymarket uses for politics, pointed at flights — and the four properties on the slide are what make it work as insurance, not just a bet: automatic settlement, on-chain transparency, full collateralisation, and a pricing model trained on five years of historical flight data so the underwriter side actually earns yield.

---

## Slide 4 — Architecture

**On slide:** one diagram, no headline.

```
                ┌────────────────────┐
                │      AeroAPI       │   off-chain
                └──────────┬─────────┘
                           │ flight data
   ════════════════════════│════════════════════════ ON-CHAIN ═══
                           ▼
                     ┌──────────┐
                     │  Oracle  │
                     └────┬─────┘
                          │ on-time / delayed
                          ▼
   ┌──────────┐  premium  ┌──────────────┐  yield   ┌──────────────┐
   │ Travelers│ ───────►  │  Controller  │ ───────► │ Underwriters │
   │          │ ◄───────  │              │ ◄─────── │              │
   └──────────┘  payout   └──────┬───────┘ capital  └──────────────┘
                                 ▲
   ══════════════════════════════│══════════════════════════════════
                                 │ premium per route
                          ┌──────┴───────┐
                          │   AI Agent   │   off-chain
                          └──────────────┘
```

**Talk track:** One diagram. Two off-chain inputs — AeroAPI feeds the oracle with flight data; an AI agent feeds the Controller with per-route premiums. Everything in between is on-chain. The Controller moves money: premiums in from travelers, payouts back when flights are delayed, capital in from underwriters, yield back when they're not. Authority isolation: a compromised oracle key can read but never trigger a payout — only the Controller can move USDC.

---

## Slide 5 — Product (2/3): Decentralised oracle (DePIN)

**Headline:** The oracle runs inside a *TEE.*

**Subtext:** For a trust-minimized setup, the Oracle code that calls the APIs runs inside a **Trusted Execution Environment**. We use **Acurast** — a distributed TEE network powered by old phones.

**Left visual:** `acurast-cluster.jpg` — photo of an Acurast Processor cluster (real Android phones running attested TEEs). Caption: *"Acurast Processor cluster · each phone ⓚ a trusted compute node."*

**Four cards (right of photo):**
1. **Tamper-proof oracle code** — Without a TEE, an oracle is only as honest as the server running it. Inside a TEE, the hardware itself attests the code is unmodified — nobody can forge a result.
2. **Signing key never leaves the chip** — The Oracle's signing key is generated and stored inside the secure enclave. Not even the node operator can extract it.
3. **Acurast — distributed TEE on old phones** — Retired Android phones with secure chips become trusted compute nodes. No data center, no single operator — redundant by default.
4. **Publicly verifiable code hash** — We publish the hash of the Oracle code running inside the TEE. Anyone can verify what's actually executing matches what we claim.

**Talk track:** Most parametric insurance products either trust a centralised oracle (defeats the point) or rent SGX servers (defeats the cost model). The right answer is to put the oracle code inside a Trusted Execution Environment — the hardware itself attests the code is unmodified, and the signing key is generated and held inside the secure chip. We use Acurast, which provides this as a distributed network running on retired Android phones, so we get tamper-proof execution without paying for a data center.

---

## Slide 6 — Product (3/3): AI pricing brain

**Headline:** Classifier looks *backward.* Agent looks *forward.*

**On slide:**

**Layer 1 — Classifier trained on BTS data (historical)**
- Trained on 5 years of US flight on-time data (Bureau of Transportation Statistics)
- Predicts delay probability per route
- *Delta JFK→LAX, 9am Tue* → 19% delay probability

**Layer 2 — Live-search agent (today's signal)**
- Daily web-search for storms, ATC strikes, war zones per route
- Returns a multiplier on premium + safety kill-switch
- *Storm forecast?* → ×1.4 premium
- *War zone?* → disable route

**Layer 3 — Governance write**
- RouteRepricer cron walks every whitelisted route daily
- Calls `governance.update_route_terms` / `disable_route` / `whitelist_route`
- Idempotent: only re-enables routes it disabled itself

**Talk track:** Every basis point of pricing accuracy is underwriter margin. Better margin = deeper liquidity = bigger policies we can sell. The pricing engine is the moat, not the contracts.

---

## Slide 7 — Why now

**Headline:** All three landed at *once.*

**Three cards:**
1. **Prediction markets went mainstream** — Polymarket and Kalshi normalized real-world on-chain settlement, both for consumers and regulators.
2. **Stablecoins became real money** — Sub-second settlement. Near-zero fees. Money you can finally move.
3. **Trust-minimized AI is shippable** — Fast chains and mature TEEs let AI agents run on-chain — decentralized, autonomous, no human in the loop.

**Talk track:** Each of these existed directionally a few years ago, but the combination only just became viable. You couldn't have run per-flight on-chain settlement on Ethereum L1 in 2022 — the gas alone exceeded the premium. You couldn't have had a trust-minimized oracle without renting SGX servers. And users hadn't yet seen Polymarket pay billions on US election outcomes. All three crossed the line at once — that's why Sentinel ships now, not in 2022.

---

## Slide 8 — Addressable Market

**Headline:** Flights are the *wedge.*

**Subtext:** The cleanest possible first feed. The same architecture serves every parametric insurance market that can be automated on-chain.

**Three tier cards:**

| # | Label | Name | Size | Note |
|---|---|---|---|---|
| 01 | The wedge | Flight delay insurance | starts here | Binary outcome, same-day settled, public data, decades of training history. |
| 02 | Near-term TAM | All parametric insurance | $19B → $35B | Weather, crop, shipping, event cancellation. Same protocol — different data feed. |
| 03 | Long-term ceiling | Uninsured climate risk | $2.9T | Cumulative uninsured catastrophe losses over the last 40 years (Swiss Re). |

**Talk track:** Flights are the wedge, not the destination. They're the cleanest possible first feed: binary outcome, same-day settled, public data, decades of training history. Once the protocol works on flights, the same architecture serves weather, crop, shipping, climate — every parametric risk that can be automated on-chain. The $19B → $35B figure is the published parametric-insurance market projection; the $2.9T figure is the cumulative uninsured catastrophe loss from Swiss Re over the last 40 years. The point of the slide is the wedge logic — same code, different data feed.

---

## Slide 9 — Current state

**Headline:** More than decks and *vibes.*

**Subtext:** v3 of the protocol, live on four testnets. Built across multiple hackathons and the Stellar Foundation grant since February. Mainnet beta on Soroban in June.

**Three status cards:**

| # | Label | Big | Name | Note |
|---|---|---|---|---|
| 01 | Iterated | **v3** | Third iteration of architecture | Tested multiple TEEs and architectures across hackathons. Funded the latest rewrite with a Stellar Foundation grant. |
| 02 | Multi-chain | **4** | Testnet deployments | Solana · Stellar Soroban · Base · Hedera. Same protocol, four runtimes. |
| 03 | Next | **June** | Mainnet beta on Soroban (Stellar) | Whitelisted accounts, funded by the Stellar Foundation grant. Production-ready architecture, audit-ready contracts. |

**Talk track:** This is not a paper pitch. We are on the third full rewrite of the protocol, with live testnet deployments on Solana, Stellar Soroban, Base, and Hedera — same architecture, four runtimes. The first two versions came out of hackathons; the current rewrite is funded by a four-month Stellar Foundation grant. We've tested multiple TEE backends and multiple architectures along the way; what's live now is the version we're keeping. Next milestone is a whitelisted Soroban mainnet beta in June, also funded by the grant. Production-ready architecture, audit-ready contracts. Mainnet for everyone else is a deploy command after audit.

---

## Slide 10 — Business model

**Headline:** Two ways the protocol *earns.*

**Two cards:**

| # | Label | Big | Name | Note |
|---|---|---|---|---|
| 01 | Take rate | **5%** | Of every premium bought | Protocol takes 5% of all premium volume. Scales linearly with traveler activity. |
| 02 | LP yield | **Vault** | Our capital on the underwriter side | We deploy our own capital as an underwriter on the protocol and earn yield from every insurance sold. |

**Talk track:** Two revenue lines. First, a flat 5% take rate on every premium bought through the protocol — scales linearly with traveler volume. Second, we deploy our own capital on the underwriter side, so we earn the same yield from on-time flights that any other LP earns. The protocol is the rail; we're also one of the underwriters running on top of it.

---

## Slide 11 — Go-to-market

**Headline:** Three *concentric rings.*

**Three ring cards:**

**Ring 1 — Crypto-native (now → Q4 2026)**
- Direct dapp + Wallet Standard connect
- Conference partnerships: **EthDenver**, **EthCC**, **Permissionless** and others — cover flights for conference-goers

**Ring 2 — Crossover (Q1 2027)**
- Chrome extension on Expedia, Kayak, Google Flights
- "Add delay insurance" injected at the booking moment

**Ring 3 — Mainstream (after volume)**
- Direct partnerships with the big travel sites and OTAs
- Available once we have the volume and pricing to compete as the embedded delay-insurance provider

**Talk track:** Three concentric rings, each one earned before we attack the next. Ring 1 is crypto-native today — direct dapp for travelers and underwriters, plus conference partnerships (EthDenver, EthCC, Permissionless and similar) where Sentinel covers flight insurance for attendees. Ring 2 is the Chrome extension that inserts "add delay insurance" at the booking moment on the major OTAs. Ring 3 is the direct travel-platform partnerships we'll have leverage for once we have volume and competitive prices.

---

## Slide 12 — Team

**Headline:** Two senior engineers. Each can build *every layer.*

**Saurav Dhar** — Founder · Chico, California
- 11 years of software engineering.
- 2 years of blockchain development across Solidity, Rust, and applied ZK.
- Founding engineer at a Boost VC startup that exited successfully; built the software from scratch.
- BS in Electrical Engineering, UT Dallas.
- MS in Electrical Engineering, Virginia Tech.
- Master's thesis on scientific-instrumentation calibration for CubeSats and nanosatellites.

**Jonas** — Founding engineer · Vilnius, Lithuania
- 8 years of software engineering, ex–big-bank platform engineer.
- 2 years of blockchain development across Solidity, Rust, and Move.
- BS in Computer Science.
- Open-source contributor to OpenZeppelin's Rust Contracts library for Soroban.
- Helped standardize SEP-56, the vault primitive used across the Soroban ecosystem.

**Talk track:** Two senior engineers who can each ship across the whole stack. Saurav has eleven years of software engineering, was the founding engineer at a Boost VC–backed startup that exited successfully — built the software from scratch — and holds a Masters in Electrical Engineering from Virginia Tech with a thesis on scientific-instrumentation calibration for CubeSats and nanosatellites. Jonas has eight years of SWE coming out of a big-bank platform team in Vilnius, and is the OpenZeppelin contributor who helped standardize SEP-56, the vault contract primitive used across the Soroban ecosystem — the exact primitive our vault is built on.

---

## Slide 13 — The Ask

**Headline:** Raising *$1.5M* seed.

**Subtext:** 24 months of runway — from audit and mainnet to first traction.

**Four funds cards:**

| # | Label | Amount | Name | Note |
|---|---|---|---|---|
| 01 | Team | **$650k** | Engineer + Growth Lead | Two new hires on top of the current team, fully loaded across 24 months. |
| 02 | Underwriter fund | **$500k** | Vault seed capital | Protocol-owned underwriter capital so day-one policies aren't capacity-gated. |
| 03 | Legal & regulatory | **$200k** | Insurance opinions | Parametric-insurance opinions and entity setup across US, EU, and Singapore. |
| 04 | Buffer | **$150k** | Operating runway | 24-month operating buffer for unforeseen costs and runway flexibility. |

**Closing line:** *"We're not asking you to fund vibes. The protocol exists. The thesis is testable in 24 months."*

**Talk track:** We're raising $1.5M for 24 months of runway. The money goes into four buckets. $650k for two new hires on top of the current team — a senior engineer and a growth lead — fully loaded across the runway. $500k into the underwriter vault so day-one policies aren't capped on capacity. $200k for legal and regulatory work — parametric-insurance opinions and entity setup across US, EU, and Singapore. $150k as an operating buffer for unforeseen costs. The protocol already exists — three iterations, four testnets, a Stellar Foundation grant, mainnet beta on Soroban in June. This round is the bridge from "live on testnets" to "live on mainnet with real volume."
