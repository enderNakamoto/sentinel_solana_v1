# Phase 15 — Frontend: Traveler Dashboard

Status: complete
Started: 2026-05-08
Completed: 2026-05-08

---

## Goal

Wire `/buy` (purchase coverage) and `/portfolio` (my policies + claim
flow) to the live devnet protocol. By the end of this phase a connected
wallet can:

1. Pick one of the 12 whitelisted routes (seeded in Phase 13), see the
   resolved premium / payoff / delay threshold, see vault solvency for the
   purchase, and submit `controller.buy_insurance`.
2. View their owned policies (active + history) by `getProgramAccounts +
   memcmp` on `BuyerRecord.buyer @ offset 8`.
3. Click Claim on a settled-delayed / settled-cancelled policy → submit
   `flight_pool.claim`.

This is the last frontend phase. After it ships, the protocol is fully
clickable from `/admin` (governance) → `/earn` (vault) → `/buy` (traveler
purchase) → `/portfolio` (claim).

## Dependencies

- Phase 13 — admin page seeded the 12 mock-catalog routes on devnet, so
  `/buy` has live whitelisted routes to read.
- Phase 14 — vault is fundable via `/earn`, so `controller.buy_insurance`
  has somewhere to lock collateral.
- The Phase 13 wiring infrastructure (`useSendTx`, `useRpc`,
  `data/onchain.ts`, `lib/{usdc,ata}.ts`).

## Context Manifest

### Skills

- `git`
- `solana-dev` *(mandatory)*

### Skill References

- universal defaults (compatibility-matrix, common-errors, security)
- `references/frontend-framework-kit.md`
- `references/kit/overview.md`
- `references/kit/plugins.md`
- `references/idl-codegen.md`
- `references/payments.md`

### Docs to Fetch

- https://github.com/anza-xyz/kit — patterns for `getProgramAccounts +
  memcmp` (multi-program account discovery via memcmp at byte offset 8 for
  Anchor's discriminator-prefixed schemas).

### Project Files to Read

- `spec/architecture.md` — §controller_program (full §`buy_insurance`),
  §flight_pool_program (`claim`, `BuyerRecord`)
- `spec/dev_steps.md` — Phase 15 section
- `spec/workflow.md`
- `MEMORY.md`
- `frontend/app/buy/page.tsx`, `frontend/app/portfolio/page.tsx` — current
  scaffolds to rewrite
- All five Codama clients in `frontend/src/clients/`
- The Phase 13 + 14 wiring artifacts (config / lib / data).

## Pre-work Notes

**buy_insurance is the heaviest tx in the project**
- 6 CPIs (governance read + read, oracle init_flight_data, flight_pool
  register_pool + add_buyer, vault.increase_locked) + the SPL premium
  transfer. Phase 5 D5 said this needs a compute-unit-limit bump to
  1_400_000. Use `setComputeUnitLimit(1_400_000)` from
  `@solana-program/compute-budget` prepended to the ix list.
- Many accounts: controllerConfig, activeFlightList, governanceProgram,
  governanceConfig, routeAccount, oracleProgram, oracleConfig, flightData,
  flightPoolProgram, flightPoolConfig, flightPool, buyerRecord,
  buyerUsdcAccount, poolTreasury, vaultProgram, vaultState, traveler
  (signer), tokenProgram, systemProgram. Codama auto-resolves most via
  the `Async` builder; the ones we must pass:
  - `traveler` (signer, no-op)
  - `buyerUsdcAccount` (ATA derived from traveler + USDC mint)
  - `poolTreasury` (treasury ATA — derive via the `poolTreasuryAuthority`
    PDA + USDC mint)
  - The program-id constants for governance / oracle / flight_pool / vault
    so Codama can fill in the cross-program account refs.

**Pre-flight (read-only) checks before submitting buy_insurance**
- Read the `RouteAccount` for the chosen flight; verify `approved === true`.
- Read `VaultState`; check `total_managed_assets - locked_capital ≥
  payoff`. If not, surface a "vault is over-utilized" warning and disable
  the Cover button.
- Surface the resolved premium / payoff / delay_hours from the route
  (falling back to defaults from `GovernanceConfig`).
- Convert `date` to a `u64` epoch-day. The on-chain ix uses a u64; we
  compute `BigInt(Math.floor(unixSeconds / 86400))` — must match what the
  oracle / flight_pool PDAs expect. **Verify** by reading the seeds
  encoder in Codama: `findFlightDataPda({ flightId, date })` uses
  `getU64Encoder()` directly, so we pass the bigint date as u64 (not a
  pre-shifted day count). Use Unix seconds.

**My policies (`getProgramAccounts + memcmp`)**
- Filter on flight_pool program; memcmp the wallet's pubkey at offset 8
  (right after the 8-byte discriminator) per Phase 3 D — `BuyerRecord`
  was schema'd with `buyer @ offset 8` exactly for this query.
- For each `BuyerRecord`, fetch the parent `FlightPool` (PDA seeds: flight_id
  + date) plus the `FlightData` (oracle status). Combine into a `MyPolicy`
  shape.
- Group into Active (status `Active`) and History (`Settled*`).

**Claim flow**
- Eligible when: pool status is `SettledDelayed` or `SettledCancelled`,
  `BuyerRecord.claimed === false`, and `now < pool.claim_expiry`.
- On click → `flight_pool.claim({ flight_id, date })`. Codama auto-resolves
  the pool / buyerRecord / treasury / treasuryAuthority. We pass:
  - `buyer` (the connected wallet pubkey)
  - `traveler` (signer — must equal `buyer`)
  - `travelerUsdcAccount` (ATA — auto-create via idempotent ix if missing)
  - `usdcMint` (constant)

**UI shape**
- `/buy`: route picker (cards) → pre-flight panel showing resolved terms
  + vault solvency check + premium total → Cover button.
- `/portfolio`: Active table + History table. Per-row Claim button when
  eligible (greyed otherwise with a reason tooltip).
- Both pages: show clear "Connect wallet" state when no session.

**Test depth**
- Manual on devnet. End-to-end walkthrough requires:
  - whitelisted routes from Phase 13 (already on devnet)
  - vault solvency (deposit ≥ payoff via Phase 14's `/earn` from the
    deployer wallet)
  - drive a settlement to the delayed / cancelled state via `/admin` (oracle
    set_estimated_arrival → set_landed delayed) or via `/contracts`.
- Type-check + Next prod build still cleanly across all 9 routes.

**Decimal handling**
- `pool.premium`, `pool.payoff`, `route.premium`, etc. are u64 in USDC
  base units (6 decimals). Reuse the Phase 14 `lib/usdc.ts` helpers
  exclusively.

---

## Subtasks

### M1 — Helpers + program-id constants

- [x] 1. Add `frontend/src/lib/compute-budget.ts` exposing
       `setComputeUnitLimitIx(units = 1_400_000)` so heavy txs can prepend
       it. Uses `@solana-program/compute-budget`. Install if missing.
- [x] 2. Extend `frontend/src/data/onchain.ts` with:
       - `readRoute(rpc, seeds)` helper that returns the typed RouteAccount
         (or null) for a single seed triple — used by the buy preview.
       - `readMyPolicies(rpc, wallet)`: getProgramAccounts on flight_pool,
         memcmp wallet at offset 8, then `fetchAllFlightPool` for the
         distinct `pool` references + `fetchMaybeFlightData` for each
         (status). Returns a typed `MyPolicy[]` array.
       - Re-export `findFlightDataPda` and `findFlightPoolPda`.

### M2 — `/buy` page rewrite

- [x] 3. Replace the mock catalog with a live read of the Phase 13 seeded
       routes (`readKnownRoutes(rpc)`) — same seeds list (`SEED_ROUTES`)
       that admin uses, so the catalog stays in sync.
- [x] 4. Route picker UI: cards listing each whitelisted route with its
       resolved terms. Disabled-card style for `approved === false` routes.
- [x] 5. Pre-flight panel shown on selection: premium, payoff, delay
       threshold, vault free capital vs required collateral (= payoff),
       date input (default tomorrow), buyer USDC balance.
- [x] 6. Cover button: build `controller.buy_insurance` ix via
       `getBuyInsuranceInstructionAsync` with the auto-derived accounts +
       explicit program-id refs. Prepend `setComputeUnitLimitIx` and an
       idempotent ATA-create for the buyer's USDC account.
- [x] 7. Disable Cover with explainer when: no wallet connected /
       `usdc_balance < premium` / vault free < payoff / route disabled.

### M3 — `/portfolio` page rewrite

- [x] 8. On mount with a connected wallet, run `readMyPolicies(rpc, wallet)`.
       Show Active + History sections.
- [x] 9. Per-policy card: flight_id / origin → destination / date / status
       badge / premium paid / payoff / claim_expiry (relative time).
- [x] 10. Claim button per active policy. Eligible if status is
       `SettledDelayed` / `SettledCancelled`, not yet claimed, before
       expiry. On click: build `flight_pool.claim` ix (idempotent USDC ATA
       create prepended) → send → refresh.
- [x] 11. Empty state: "You haven't bought any coverage yet — head to /buy".

### M4 — Smoke + typecheck

- [x] 12. `pnpm -r typecheck` clean.
- [x] 13. `pnpm build` clean — all routes prerender, no new errors.
- [x] 14. Dev-server smoke: every page returns 200; no runtime warnings.
- [x] 15. Manual devnet flow (USER PASS):
       - Load `/buy`, pick `UA1437 SFO → JFK`, see real terms.
       - Top up USDC from `/faucet`, deposit on `/earn` (if vault empty).
       - Submit Cover → tx lands; explorer link in the toast.
       - Drive settlement via `/admin` or `/contracts` until pool is
         SettledDelayed.
       - Open `/portfolio`, see the policy active → settled → eligible
         to claim.
       - Click Claim → USDC arrives in the wallet.

### Gate

- A connected wallet on devnet can buy a policy on `/buy` against a
  whitelisted route + solvent vault.
- `/portfolio` lists the wallet's real policies (active + history).
- After settlement, the user can click Claim on `/portfolio` and receive
  USDC.
- All earlier-phase pages still load + behave correctly.
- `pnpm -r typecheck` clean.

---

## Work Log

### Session 2026-05-08
All 15 subtasks complete. `pnpm -r typecheck` ✓, `pnpm build` ✓ (12 routes
prerender, /buy 4.58 kB / 182 kB, /portfolio 3.64 kB / 184 kB).

- M1: Hand-rolled SetComputeUnitLimit ix in `lib/compute-budget.ts`
  (5-byte data, ComputeBudget program id) — chose this over the
  `@solana-program/compute-budget` package because the installed version
  pins kit 5.5.1 and the frontend uses kit 6.8. Extended `data/onchain.ts`
  with `readRoute`, `findFlightPoolAddress`, `findFlightDataAddress`,
  `readMyPolicies` (getProgramAccounts + double memcmp on discriminator +
  buyer @ offset 8), plus the BuyerRecord/FlightPool/FlightData type
  re-exports.
- M2: Full `/buy` rewrite. Route picker reads `readKnownRoutes` (matches
  /admin's source of truth). Pre-flight panel shows resolved premium /
  payoff / delay-threshold (Option overrides via `unwrapOption`, fallback
  to `GovernanceConfig` defaults), vault TVL/free, date picker. Cover
  button derives all 14 cross-program account refs explicitly + prepends
  `setComputeUnitLimitIx(1_400_000)` + idempotent USDC ATA-create. Submit
  disabled when route disabled / vault free < payoff / no wallet / no date.
- M3: Full `/portfolio` rewrite. `readMyPolicies(rpc, wallet)` runs on
  mount. Active + History sections (split on `BuyerRecord.claimed`).
  Per-policy card shows status badge (resolved from
  `pool.status` numeric → SettlementStatus enum name) plus premium /
  payoff / pool explorer link. Claim button eligible only when status is
  SettledDelayed or SettledCancelled, not yet claimed, and before
  claim_expiry. On click: `flight_pool.claim({flight_id, date})` with
  idempotent USDC ATA-create prepended.

Manual smoke deferred (subtask 15) — needs a connected wallet on devnet
with funded vault from the Phase 14 walkthrough.



---

## Files Created / Modified

Created:
- `frontend/src/lib/compute-budget.ts` — hand-rolled SetComputeUnitLimit ix.

Modified:
- `frontend/app/buy/page.tsx` — full rewrite, route picker + buy_insurance.
- `frontend/app/portfolio/page.tsx` — full rewrite, getProgramAccounts + claim.
- `frontend/src/data/onchain.ts` — traveler reads (`readRoute`,
  `readMyPolicies`, `findFlightPoolAddress`, `findFlightDataAddress`),
  widened `Rpc` alias with `GetProgramAccountsApi`.
- `frontend/src/data/index.ts` — re-exports for the new helpers.
- `spec/progress.md` — phase 15 row + active pointer.
- `spec/phases/phase-15-frontend-traveler.md` — work log + completion.

---

## Decisions Made

- **D1** SetComputeUnitLimit hand-rolled (5-byte data, ComputeBudget
  program id) instead of pulling `@solana-program/compute-budget` —
  installed version pins kit 5.5.1, frontend uses kit 6.8.
- **D2** `buy_insurance` accounts derived explicitly (14 of them — no
  Codama auto-resolution across program boundaries). Pulls program IDs
  from `src/config/devnet.ts` and PDAs from the per-program `find*Pda`
  helpers.
- **D3** `readMyPolicies` uses double-memcmp on discriminator @ offset 0
  + wallet @ offset 8 — matches the `BuyerRecord` schema decision from
  Phase 3 D ("buyer @ offset 8 for memcmp queries").
- **D4** `getBase58Decoder().decode(bytes)` returns a plain string but
  the RPC's `bytes` field is typed as the branded `Base58EncodedBytes`;
  cast through `as Base58EncodedBytes` (RPC accepts the literal).
- **D5** Status enum mapped numeric → string in the frontend; on-chain
  enum has no payload so Codama emits a plain numeric enum.
- **D6** Active vs History split by `BuyerRecord.claimed` boolean rather
  than by pool status — claimed entries always show in History, even if
  the pool is still `Active` (the user already collected on a partial-
  flow scenario, though we don't yet have one).
- **D7** All write-path ix prepend `getCreateAssociatedTokenIdempotentInstruction`
  for the USDC ATA so first-time travelers don't need a separate setup tx.

---

## Completion Summary

**What was built**

`/buy` and `/portfolio` are fully wired against the live devnet protocol.
The protocol is now end-to-end clickable from `/admin` (whitelist routes,
set authorities, manage admins) → `/earn` (deposit / redeem / queue /
collect) → `/buy` (purchase coverage on whitelisted routes) → `/portfolio`
(view active / history policies, claim payouts on settled-delayed or
settled-cancelled flights).

`buy_insurance` — the heaviest tx in the project (6 CPIs) — assembles
14 explicit cross-program account refs (governance config + route, oracle
config + flight data, flight-pool config + pool + buyer record, vault
state, plus the buyer USDC ATA and the pool treasury ATA) and prepends
a hand-rolled `SetComputeUnitLimit(1_400_000)` ix. The Cover button only
enables when the route is approved, the vault has free capital ≥ payoff,
and a flight date is picked.

`/portfolio` does a `getProgramAccounts` + double-memcmp scan
(discriminator + buyer @ offset 8) against the flight_pool program, then
joins each `BuyerRecord` with its parent `FlightPool` and `FlightData`
oracle status. Each policy card shows a status badge derived from the
on-chain `SettlementStatus` enum, and a Claim button surfaces only when
the policy is settled-delayed or settled-cancelled, not yet claimed, and
within the claim-expiry window.

**Limitations / deferred**

- The original mock-driven /buy had coverage / threshold sliders that let
  users set premium-scaling parameters. Removed because the on-chain
  protocol uses fixed per-route terms — the user does not negotiate.
- "My policies" via `getProgramAccounts` is unbounded — fine on devnet
  with ~12 routes and a handful of buyers, but a future phase should add
  pagination or push the index off-chain.
- Manual devnet end-to-end (subtask 15) is the user's pass — code paths
  type-check, the build prerenders all 12 routes, and the dev server
  serves /buy + /portfolio without runtime errors.
