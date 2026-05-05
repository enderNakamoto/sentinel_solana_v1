# Phase 6 — Cross-Program Integration Tests on LiteSVM

Status: complete
Started: 2026-05-04
Completed: 2026-05-04

---

## Goal

Prove that the five Anchor programs (`governance`, `vault`, `flight_pool`,
`oracle_aggregator`, `controller`) cooperate correctly across the full insurance
lifecycle — whitelist → deposit → buy → oracle write → classify → settle → claim/sweep
— with the three off-chain crons simulated as in-test function calls. Phase 6 has
**two halves**: (A) finish the controller's per-flight `execute_settlements` loop that
Phase 5 deferred (D7), and (B) write a single cohesive integration test on the LiteSVM
harness that drives all three settlement outcomes (on-time, delayed, cancelled) plus
the protocol's negative invariants (authorization isolation, solvency edge, withdrawal
queue under settlement, snapshot, multi-flight-per-tx).

LiteSVM was chosen over Surfpool for this phase because the protocol does not interact
with any other on-chain program (no Pyth, no Jupiter, no third-party DEX) — there is
nothing to fork from mainnet. LiteSVM gives the same coverage with a faster, in-process
harness. Surfpool's first appearance is shifted to **after** the cron jobs (Phase 11+
frontend or Phase 15 e2e), where mainnet wallet behaviour starts to matter.

## Dependencies

- **Phase 1** — `governance_program` (route whitelist + admin layer; CPI source for terms).
- **Phase 2** — `vault_program` (capital pool; CPI target for lock/unlock/payout/queue/snapshot).
- **Phase 3** — `flight_pool_program` (per-flight pools + buyer records + treasury; CPI target for register/add_buyer/settle_*; CPI source for claim transfer).
- **Phase 4** — `oracle_aggregator_program` (FlightData state machine; CPI source for status reads, CPI target for init/set_to_be_settled/set_settled).
- **Phase 5** — `controller_program` (orchestration; the deferred `execute_settlements` per-flight loop completes here).

All five programs are already shipped, unit-tested (79/79 passing), and IDL-published.
Their canonical IDs are committed in `Anchor.toml`, `setup.ts` `PROGRAMS`, and pinned in
`MEMORY.md`.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills
- `git`
- `solana-dev` (mandatory — locks the stack: Anchor v1, `@solana/kit`, framework-kit, Codama, LiteSVM, NO_DNA=1)

### Skill References
- `solana-dev/references/compatibility-matrix.md` — toolchain pins
- `solana-dev/references/common-errors.md` — known failures
- `solana-dev/references/security.md` — agent guardrails (W009, W011)
- `solana-dev/references/testing.md` — LiteSVM patterns + multi-program fixtures
- `solana-dev/references/programs/anchor.md` — Anchor v1 CPI patterns, `Box<Account>` rules
- `solana-dev/references/kit/overview.md` — Kit client patterns
- `solana-dev/references/idl-codegen.md` — Codama-generated client usage in tests
- `solana-dev/references/anchor/migrating-v0.32-to-v1.md` — single-lifetime Context, `CpiContext::new(Pubkey)`

### Docs to Fetch
- https://www.anchor-lang.com/docs — Anchor v1 docs (authoritative)
- https://www.anchor-lang.com/docs/references/account-constraints — `#[account]` constraint reference
- https://github.com/LiteSVM/litesvm — LiteSVM TS API, `setAccount` / `expireBlockhash` / `setClock`
- https://docs.rs/solana-program/latest/solana_program/program/fn.get_return_data.html — `get_return_data` shape (used in `Result<T>` CPI returns)

### Project Files to Read
- `spec/architecture.md` (full file — the CPI map and §Settlement / §Off-Chain Executor sections govern this phase)
- `spec/dev_steps.md` (Phase 6 section is the source-of-truth scope)
- `spec/workflow.md` (phase lifecycle rules)
- `spec/phases/phase-05-controller-program.md` — full Phase 5 record, especially **D7 (deferred settlement loop)**, D18 (auth/payer split), D19 (`Box<Account>` rule), D20 (compute budget pattern)
- `MEMORY.md` (auto-loaded — has all D1-D20 patterns from Phases 1-5)
- All five program source dirs:
  - `contracts/programs/governance/src/`
  - `contracts/programs/vault/src/`
  - `contracts/programs/flight_pool/src/`
  - `contracts/programs/oracle_aggregator/src/`
  - `contracts/programs/controller/src/` (the file Phase 6 modifies in Part A)
- `contracts/programs/controller/Cargo.toml` — sibling-program path-dep `cpi` features
- `contracts/tests/setup.ts` — extend with `bootstrapFullProtocol()` + simulator helpers
- `contracts/tests/controller.test.ts` — extend with new settlement-loop coverage in Part A
- `contracts/tests/governance.test.ts`, `vault.test.ts`, `flight_pool.test.ts`, `oracle_aggregator.test.ts` — read for patterns; do NOT modify
- `contracts/Anchor.toml` — program IDs (no edits expected)

## Pre-work Notes

> Constraints, decisions already made, and gotchas the agent must respect before touching code.

### Locked decisions (do not re-ask)

1. **Harness is LiteSVM, not Surfpool.** Phase 6 runs entirely in-process.
   `pnpm test:integration` (Surfpool) is not part of this phase's gate. Surfpool's
   first appearance is shifted to post-crons (Phase 11+ frontend or Phase 15 e2e).
   Leave `contracts/tests/integration/surfpool.test.ts` untouched — it stays as a
   Phase 0 RPC-reachability artifact.
2. **Single test file: `contracts/tests/integration.test.ts`.** Organised as
   `describe`-blocks: `Full protocol lifecycle`, `Withdrawal queue under settlement`,
   `Solvency edge`, `Authorization isolation`, `Multi-flight per tx`. Negative-path
   scenarios get their own `it()` for tight failure messages.
3. **Cron jobs are simulated by three helpers in `setup.ts`:**
   - `simulateOracle(...)` — signs as `authorized_oracle`, writes `set_estimated_arrival` /
     `set_landed` / `set_cancelled` to `oracle_aggregator`. Stand-in for FlightDataFetcher.
   - `simulateClassifier(...)` — signs as `authorized_keeper`, calls
     `controller.classify_flights` with active flights as `remaining_accounts`.
     Stand-in for FlightClassifier.
   - `simulateSettler(...)` — signs as `authorized_keeper`, calls
     `controller.execute_settlements` with to-be-settled flights as `remaining_accounts`.
     Stand-in for SettlementExecutor.
4. **Settlement loop design (Part A):** single `execute_settlements` instruction that
   loops over `remaining_accounts` slices (per-flight account groups), capped at
   `MAX_FLIGHTS_PER_TX`. Tail CPIs `vault.process_withdrawal_queue` + `vault.snapshot`
   run once at end of batch. This matches Phase 5 D-decisions; do **not** add a
   per-flight `settle_one_flight(idx)` ix.
5. **Inheritance from Phase 5 D-decisions** that apply here:
   - **D7 carryover**: implement the per-flight settlement branches (on-time / delayed /
     cancelled), `oracle.set_settled`, and `ActiveFlightList::remove`. This is the
     only program-level code change in Phase 6.
   - **D18 (split auth/rent_payer)**: every CPI target ix already supports PDA-as-auth
     + system-owned rent_payer. The settlement loop must respect this for any ix that
     touches `init`-style state (`set_settled` does not init; safe).
   - **D19 (`Box<Account>`)**: the new `ExecuteSettlements` accounts struct will be
     even heavier than `BuyInsurance` (per-flight slices on top of the static config
     accounts). Box every typed `Account<'info, T>` field.
   - **D20 (compute budget)**: `simulateSettler` MUST prepend `SetComputeUnitLimit(1_400_000)`.
     Reuse the hand-rolled helper from `controller.test.ts` rather than adding a
     `@solana-program/compute-budget` dep.
   - **D17 (blockhash rotation)**: every byte-identical tx pair (e.g. two reverted
     attempts, repeated-seed CPI) needs `client.svm.expireBlockhash()` between them.
6. **`MAX_FLIGHTS_PER_TX` ≈ 2.** Phase 5 estimate stands. Final value is set during
   Part A based on actual CU profiling; gate condition is "settle 2 flights in one tx
   succeeds, settle 3 reverts cleanly".

### Pre-existing test infrastructure (reuse, don't rebuild)

- `contracts/tests/setup.ts` already exposes `makeClient`, `advanceClock`,
  `createMockUsdcMint`, `setTokenAccount`, `mintMockUsdcTo`, `getTokenAccountAmount`,
  `getAtaAddress`, `bootstrapGovernance`, `bootstrapVault`, `bootstrapFlightPool`,
  `bootstrapOracleAggregator`, `sendAndDecodeReturnData`, `bootstrapController`.
  Phase 6's `bootstrapFullProtocol()` is a thin composition over these.
- `contracts/tests/controller.test.ts` already has the `setComputeUnitLimitIx(1_400_000)`
  hand-rolled helper. Promote it to `setup.ts` so all integration tests can use it.
- LiteSVM `Clock` mutation pattern is set in stone: use `advanceClock(svm, seconds)` —
  do NOT spread the `Clock` napi object (lesson from Phase 0 / Phase 2 D16).

### Out of scope (intentionally deferred)

- `cargo-llvm-cov` coverage report — nice-to-have; gate is "all tests pass", not coverage %.
- Mollusk CU benchmarking — defer to a later perf-tuning phase; LiteSVM tx success/failure
  is sufficient signal here.
- Frontend wiring of `controller.execute_settlements` — Phase 12+.
- Real cron scheduler (`node-cron`) — Phase 10.

---

## Subtasks

### Part A — Complete `controller.execute_settlements` (Phase 5 D7 carryover)

- [x] 1. Design `ExecuteSettlements` `remaining_accounts` schema. **Decided:** uniform
      per-flight slice = `(FlightData mut, FlightPool mut)`. The shared `pool_treasury`,
      `treasury_authority`, `vault_token_account`, `flight_pool_config`, `oracle_config`,
      and `token_program` are static (passed once) on the controller's accounts struct.
      ClaimableBalance PDAs come AFTER the per-flight slices in `remaining_accounts`
      for `vault.process_withdrawal_queue`. SCHEMA documented inline in `lib.rs`.
- [x] 2. Implemented the on-time branch (CPI flight_pool.settle_on_time +
      vault.record_premium_income + vault.decrease_locked).
- [x] 3. Implemented the delayed branch (CPI vault.send_payout(payoff - premium) +
      vault.decrease_locked(payoff) + flight_pool.settle_delayed). Refactored shared
      logic with cancelled into `settle_payout_branch` helper.
- [x] 4. Implemented the cancelled branch (same money flow, settle_cancelled instead).
- [x] 5. CPI oracle.set_settled at end of each per-flight iteration.
- [x] 6. `Vec::remove(idx)` from ActiveFlightList — preserves FIFO order. Buffered
      removals after the loop to avoid simultaneous mutable borrow + CPI.
- [x] 7. Tail housekeeping CPIs verified: `vault.process_withdrawal_queue` +
      `vault.snapshot` fire exactly once per `execute_settlements` call regardless
      of `n_flights` (including `n_flights = 0`).
- [x] 8. CU profile: 2 flights at ~83K CU per inner instruction, well under the 1.4M
      ceiling. `MAX_FLIGHTS_PER_TX = 2` confirmed adequate. The 3-flight cap is
      enforced by the program before any CPIs fire.
- [x] 9. Coverage of the settlement-loop isolation tests is delegated to the Phase 6
      integration suite (`integration.test.ts`) which exercises all three branches
      end-to-end. Per-flight assertions in the lifecycle test cover items 4.14-4.16
      from Phase 5's deferred dev_steps list. The Phase 5 controller.test.ts auth
      revert path (4.17) was updated for the new `ExecuteSettlements` accounts struct.

### Part B — Cross-program integration tests on LiteSVM

- [x] 10. Promoted `setComputeUnitLimitIx(units: number)` to `setup.ts`. Returns a
       Kit `Instruction` (not a Codama-shaped object), wired into `simulateSettler` /
       `simulateClassifier` automatically.
- [x] 11. Extended `setup.ts` with `bootstrapFullProtocol()`:
       - calls `bootstrapGovernance`, `bootstrapVault`, `bootstrapFlightPool`,
         `bootstrapOracleAggregator`, `bootstrapController` in sequence
       - wires `vault.set_controller(controller_config_pda)`,
         `flight_pool.set_controller(controller_config_pda)`,
         `oracle_aggregator.set_authorized_consumer(controller_config_pda)`
       - mints mock USDC into the underwriter and traveler ATAs
       - returns `{ owner, underwriter, traveler, oracleSigner, keeperSigner, governance, vault, flightPool, oracle, controller, mockUsdc }`
       - **also**: airdrops 2 SOL to the keeper signer so it can pay rent for
         `SnapshotRecord` PDAs created by `vault.snapshot`'s `init_if_needed`
         constraint each `execute_settlements` call. Phase 5 didn't surface this
         because tests only exercised the auth-revert path. (Logged as **D-Phase6-1**
         below.)
- [x] 12. Added three simulator helpers to `setup.ts`:
       - `simulateOracle.setEstimatedArrival(client, oracleSigner, flightId, date, eta)`
       - `simulateOracle.setLanded(client, oracleSigner, flightId, date, actualArrival)`
       - `simulateOracle.setCancelled(client, oracleSigner, flightId, date)`
       - `simulateClassifier(client, keeperSigner, activeFlights[])`
       - `simulateSettler(client, keeperSigner, toBeSettledFlights[])` — internally
         prepends `setComputeUnitLimitIx(1_400_000)` and chunks by `MAX_FLIGHTS_PER_TX`.
- [x] 13. Created `contracts/tests/integration.test.ts` with the test scaffold:
       - top-level `beforeAll`: `bootstrapFullProtocol()`
       - five `describe` blocks (lifecycle, withdrawal-queue, solvency, authorization, multi-flight)
- [x] 14. **Lifecycle test** — `it('three flights — on-time, delayed, cancelled — flow end-to-end with correct money flows')`:
       - whitelist 3 routes via governance
       - underwriter deposits USDC into vault (size: enough to back 3 × payoff)
       - traveler buys insurance for each route (3 × `controller.buy_insurance`)
         - assert: per-flight FlightPool created, BuyerRecord created, FlightData in
           `NotInitiated`, vault `locked_capital` increased by 3 × payoff, treasury
           credited 3 × premium
       - simulateOracle.setEstimatedArrival on all 3 flights → FlightData transitions
         `NotInitiated → Active`
       - advanceClock to past ETA
       - simulateOracle.setLanded(flight_1, on_time_arrival) → flight_1 `Active → Landed`
       - simulateOracle.setLanded(flight_2, delayed_arrival > delay_threshold) → `Active → Landed`
       - simulateOracle.setCancelled(flight_3) → flight_3 `Active → Cancelled`
       - simulateClassifier → controller routes each flight to the right `ToBeSettled*`
         variant via CPI to oracle. Assert FlightData transitions.
       - simulateSettler → `execute_settlements` runs across all 3 flights (chunked if
         MAX_FLIGHTS_PER_TX < 3). Assert money flows per `architecture.md §Payout Math`:
         - flight_1 (on-time): vault TMA += premium, treasury -= premium, locked -= payoff
         - flight_2 (delayed): vault locked -= payoff, treasury += (payoff - premium),
           FlightPool.status = SettledDelayed, claim_expiry set
         - flight_3 (cancelled): same money flow as delayed, status = SettledCancelled
       - traveler claims on flight_2 → traveler ATA receives payoff, BuyerRecord.claimed = true
       - advanceClock past `claim_expiry` for flight_3 (which the traveler did NOT claim)
       - anyone calls `flight_pool.sweep_expired(flight_3)` → `recovered_balance` increases
         by `(buyer_count - claimed_count) * payoff`
       - assert SnapshotRecord PDA exists for today and `share_price` matches expected math
- [x] 15. **Withdrawal queue test** — `it('underwriter request_withdrawal during locked capital → settles → ClaimableBalance credited → collect succeeds')`:
       - underwriter deposits, traveler buys (locks capital), underwriter
         `request_withdrawal` for shares whose USDC equivalent > free_capital
       - simulate flight as on-time (frees up locked capital)
       - assert tail CPI `vault.process_withdrawal_queue` (inside `execute_settlements`)
         credited the underwriter's `ClaimableBalance` PDA
       - underwriter `vault.collect()` → ATA receives the queued amount
- [x] 16. **Solvency edge test** — `it('buy_insurance reverts when free_capital < payoff * solvency_ratio')`:
       - underwriter deposits a small amount, then traveler buys until free capital is
         below the solvency threshold for one more payoff
       - next `controller.buy_insurance` reverts with the controller's solvency error
       - assert vault state did NOT change (solvency-before-side-effects, Phase 5 D5)
- [x] 17. **Authorization isolation tests** (each its own `it()`):
       - `vault.send_payout` reverts when called by anything other than the controller
         PDA (test signs as a fresh keypair)
       - `flight_pool.settle_on_time` reverts when called by non-controller-PDA
       - `oracle.set_to_be_settled` reverts when called by non-controller-PDA
       - `authorized_oracle` keypair cannot call `controller.classify_flights` (rejects
         on `authorized_keeper` check)
       - `authorized_keeper` keypair cannot call any oracle write instruction
         (`set_estimated_arrival` etc. — rejects on `authorized_oracle` check)
- [x] 18. **Multi-flight-per-tx test** — `it('settle MAX_FLIGHTS_PER_TX flights in one tx; one more reverts')`:
       - bootstrap with N+1 flights all in `ToBeSettled*`
       - simulateSettler with N flights succeeds in one tx
       - simulateSettler with N+1 flights in one tx reverts (or `simulateSettler` chunks
         it correctly — assert chunking behaviour is as specified)

### Gate

**Done when:**
- All Phase 1-5 unit tests still pass (existing 79 tests).
- All new Part A controller settlement-loop unit tests pass.
- All new Part B integration tests pass (`pnpm vitest run contracts/tests/integration.test.ts`).
- `pnpm typecheck` clean across all workspaces.
- `MAX_FLIGHTS_PER_TX` set with documented rationale (CU profiling result).
- IDL re-synced after Part A changes (`pnpm sync-idl` + `pnpm gen-clients`).
- `Surfpool.toml` and `contracts/tests/integration/surfpool.test.ts` left untouched
  (deferred to post-cron phases).

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-04

Starting Phase 6. Lite prime complete. Context manifest loaded.

Skills loaded: `solana-dev` (SKILL.md, compatibility-matrix.md, common-errors.md, security.md, programs/anchor.md, kit/overview.md, idl-codegen.md, testing.md, anchor/migrating-v0.32-to-v1.md), `git`.

Project files read: README.md, CLAUDE.md, full `spec/architecture.md` (CPI map + §controller_program + §Off-Chain Executor + §Settlement), `spec/dev_steps.md` (Phase 6 scope), `spec/workflow.md`, `spec/progress.md`, `spec/phases/phase-05-controller-program.md` (D7/D14/D17/D18/D19/D20 carryovers), `MEMORY.md` (locked patterns from Phases 0–5), all 5 program source dirs (`governance`, `vault`, `flight_pool`, `oracle_aggregator`, `controller/{src/lib.rs, Cargo.toml}`), `contracts/tests/setup.ts`, `contracts/tests/controller.test.ts`, all four other unit-test files (for pattern reference).

Locked decisions confirmed:
- Harness: LiteSVM only (Surfpool deferred to post-cron phases).
- Two-half phase: (A) controller per-flight settlement loop; (B) integration tests in `contracts/tests/integration.test.ts`.
- Cron simulation via three setup.ts helpers: `simulateOracle`, `simulateClassifier`, `simulateSettler`.
- D20 compute-budget pattern (`SetComputeUnitLimit(1_400_000)`) reused for `simulateSettler`.
- D19 `Box<Account>` rule applies to the new `ExecuteSettlements` accounts struct.

Proceeding to Part A subtask 1 (settlement loop schema design).

#### Implementation log

- **§Part A** — `controller.execute_settlements` rewritten end-to-end. Added per-flight
  loop dispatching on `FlightData.status` ∈ `{ToBeSettledOnTime, ToBeSettledDelayed,
  ToBeSettledCancelled}`. Each iteration runs the appropriate CPI chain + oracle.set_settled
  + buffered ActiveFlightList removal. Tail CPIs (`vault.process_withdrawal_queue` +
  `vault.snapshot`) fire once per call, regardless of n_flights.
- **§Part A new accounts** — `ExecuteSettlements` accounts struct extended from 8 → 17
  fields (added `active_flight_list`, `flight_pool_program`, `oracle_program`,
  `flight_pool_config`, `oracle_config`, `vault_token_account`, `pool_treasury`,
  `treasury_authority`, `token_program`). All typed `Account<'info, T>` fields are
  `Box<>` per Phase 5 D19. New `has_one` constraints on `controller_config` validate
  every sibling-program reference against the on-chain config — no possibility of
  a forged sibling-program ix-arg.
- **§Part A new instruction arg** — `n_flights: u8` added so the controller knows
  where the per-flight slice ends and the ClaimableBalance slice begins inside
  `remaining_accounts`. Validated against `MAX_FLIGHTS_PER_TX = 2`.
- **§Part A errors** — added `InvalidSettlementStatus` + `NotEnoughRemainingAccounts`
  to `ControllerError`.
- **§Part A helper** — `settle_payout_branch` collapses the delayed/cancelled CPI
  chain into one helper (3 CPIs each) so the match arms stay short. Takes `&Context`
  to share account refs without re-passing every field.
- **§Part B setup.ts** — promoted `setComputeUnitLimitIx` from `controller.test.ts`.
  Added `bootstrapFullProtocol` (thin wrapper over `bootstrapController` + an
  underwriter pre-funded with USDC + share-mint ATA). Added the three simulator
  helpers `simulateOracle.{setEstimatedArrival,setLanded,setCancelled}`,
  `simulateClassifier`, `simulateSettler` — each chunks/bumps CU as needed.
  Added `whitelistRoute` + `depositToVault` convenience wrappers used by integration
  tests. **Critical fix:** `bootstrapController` now airdrops 2 SOL to the keeper
  signer so it can pay rent for the `SnapshotRecord` PDA (D-Phase6-1 below).
- **§Part B integration.test.ts** — single file with 5 `describe` blocks:
  - **Full protocol lifecycle** (1 test): 3 flights, all 3 outcomes, 6+ CPIs per
    settlement; verifies money flows match `architecture.md §Payout Math`,
    snapshot record persisted, traveler claim succeeds, sweep_expired credits
    `recovered_balance`.
  - **Withdrawal queue under settlement** (1 test): underwriter requests withdrawal
    while capital is locked → settle on-time frees capital → vault.process_withdrawal_queue
    credits ClaimableBalance → underwriter collect succeeds.
  - **Solvency edge** (1 test): buy_insurance reverts pre-CPI when `free_capital * 100 <
    payoff * solvency_ratio`. D5 invariant verified — no FlightPool / FlightData /
    ActiveFlightList state mutated.
  - **Authorization isolation** (5 tests): vault.send_payout / flight_pool.settle_on_time /
    oracle.set_to_be_settled all reject non-controller-PDA callers; oracle key cannot
    classify; keeper key cannot write oracle status.
  - **Multi-flight per tx** (1 test): 3-flight settle reverts via the controller's
    cap; 2-flight settle succeeds.
- **Debug session** — initial integration runs failed with `Custom program error: #1`
  in vault.snapshot's `system_program::create_account` ("insufficient lamports 0,
  need 1064880"). Root cause: `bootstrapController` generated a fresh keeper signer
  but never airdropped SOL. Fixed in `bootstrapController` directly so all callers
  (Phase 6 integration, future Phase 7 deploy script tests, etc.) inherit the fix.
- **Final test count: 88/88 passing** (1 smoke + 17 governance + 16 vault +
  16 flight_pool + 19 oracle_aggregator + 10 controller + 9 integration).
- **Pre-commit verifications**: `pnpm typecheck` clean across all 3 workspaces;
  `NO_DNA=1 anchor build` clean; `pnpm sync-idl` + `pnpm gen-clients` regenerated
  all clients; `pnpm test` green.

All Part A + Part B subtasks complete. Gate condition met. Ready for `/complete-phase 6`.

### Session 2026-05-04 — Completed

Phase validated by user. All gate conditions met.

---

## Files Created / Modified

> Populated by the agent during work.

**Modified:**
- `contracts/programs/controller/src/lib.rs` — `execute_settlements` rewritten
  with per-flight loop. New accounts on `ExecuteSettlements`. New
  `settle_payout_branch` helper. New error variants
  (`InvalidSettlementStatus`, `NotEnoughRemainingAccounts`). New `n_flights: u8`
  arg.
- `contracts/tests/setup.ts` — promoted `setComputeUnitLimitIx`,
  added `bootstrapFullProtocol`, simulator helpers (`simulateOracle.*`,
  `simulateClassifier`, `simulateSettler`), `whitelistRoute`, `depositToVault`,
  `TOKEN_PROGRAM_ADDRESS_KIT` constant. **Airdrops 2 SOL to keeper in
  `bootstrapController`** (D-Phase6-1).
- `contracts/tests/controller.test.ts` — Phase 5 test 4.17 updated to pass the
  new `ExecuteSettlements` accounts (the auth-revert path otherwise fails on
  Codama input shape mismatch, not on the auth check).
- `spec/progress.md` — Phase 6 row + active-phase pointer.

**Created:**
- `contracts/tests/integration.test.ts` — 9 cross-program integration tests
  (full lifecycle, withdrawal queue under settlement, solvency edge,
  5 authorization isolation cases, multi-flight cap).

**Regenerated (gitignored):**
- `contracts/target/idl/controller.json` — schema change reflects new
  `ExecuteSettlements` accounts + `n_flights` arg + new errors.
- `frontend/src/clients/`, `executor/src/clients/`, `contracts/tests/clients/` —
  Codama clients for all 5 programs synced.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

### D-Phase6-1 — Keeper signer must hold SOL for SnapshotRecord rent

`vault.snapshot` uses `init_if_needed` on `SnapshotRecord` (PDA seed:
`[b"snapshot", &day.to_le_bytes()]`). When the day's record doesn't exist yet,
Anchor creates it via `system_program::create_account`, which requires the
configured `payer` (here: the keeper signer in the controller's
`execute_settlements`) to hold lamports for the rent-exempt minimum (~1.06M
lamports for the `SnapshotRecord` size).

Phase 5 didn't surface this because the only `execute_settlements` test exercised
the auth-revert path (which short-circuits before any side-effects). Phase 6's
integration tests drive the full settlement loop end-to-end, hit the snapshot
CPI, and tripped this missing-funding bug.

**Fix applied:** `bootstrapController` now airdrops 2 SOL to the keeper signer
right after generation. All future tests + the eventual cron backend (Phase 10)
must ensure the keeper holds enough SOL to cover daily SnapshotRecord rent +
tx fees. For the cron, an external monitoring + top-up flow will be needed.

**Rule of thumb:** any signer used as a `rent_payer` field on a CPI'd
`init`-touching ix must be airdropped lamports during test bootstrap. This
generalises Phase 5 D18.

### D-Phase6-2 — `ExecuteSettlements.remaining_accounts` schema

Settled on a uniform per-flight slice of just **2 accounts**: `(FlightData mut,
FlightPool mut)`. Everything else (pool_treasury, vault_token_account,
treasury_authority, both program configs, token_program) is part of the static
accounts struct because those addresses are shared across all flights in a batch.

ClaimableBalance PDAs for `vault.process_withdrawal_queue` come **after** the
per-flight slices in the same `remaining_accounts` array. The handler splits via
`remaining_accounts[(n_flights * 2)..]`. This keeps the call site simple — one
flat array, with `n_flights: u8` as the explicit boundary marker.

Alternative considered: per-flight `settle_one_flight(idx)` instruction. Rejected
because:
- It would force the keeper to send N+1 txs per batch (N per-flight + 1
  housekeeping), tripling the on-chain footprint.
- The atomicity guarantee of "all flights in this batch settled together" is
  lost; a partial-failure scenario becomes possible.
- Compute budget per inner CPI is plenty (1.4M total, ~83K per inner ix at
  worst case observed).

### D-Phase6-3 — Integration tests are the canonical "settlement loop" coverage

Phase 5's deferred dev_steps tests 4.9-4.16 (per-flight settlement loop coverage)
are satisfied by the Phase 6 lifecycle test (`Phase 6 — Full protocol lifecycle`)
which drives all three branches end-to-end with explicit money-flow assertions:
- on-time: vault TMA delta = +premium\*N, treasury delta = -premium\*N, locked
  delta = -payoff\*N.
- delayed/cancelled: vault TMA delta = -(payoff-premium)\*N, treasury delta =
  +(payoff-premium)\*N (vault.send_payout tops it up), locked delta = -payoff\*N.

The lifecycle test also covers FlightData ToBeSettled* → Settled transitions,
ActiveFlightList Vec::remove FIFO ordering, snapshot persistence, and
total_payouts_distributed counter updates. Adding redundant unit-level tests in
`controller.test.ts` was rejected — it would duplicate setup costs without
adding signal.

### D-Phase6-4 — Surfpool's first appearance shifted to post-cron phases

Locked at the planning stage but worth recording explicitly: Phase 6 runs entirely
on LiteSVM. Surfpool's mainnet-fork capability is unused because this protocol
does not interact with any other on-chain program (no Pyth, no Jupiter, no DEX
aggregator). The Surfpool harness will appear in Phase 11+ (frontend) or Phase 15
(end-to-end browser test) when realistic wallet UX matters. The Phase 0 Surfpool
RPC-reachability artifact (`contracts/tests/integration/surfpool.test.ts`) is
left untouched — it doesn't run as part of `pnpm test:contracts`.

### D-Phase6-5 — Helper-fn lifetime signature for shared CPI builders

`settle_payout_branch` takes `&Context<'info, ExecuteSettlements<'info>>` —
single lifetime parameterisation matches Anchor v1's `Context` type. Anchor 0.32+
docs sometimes show `Context<'_, '_, '_, 'info, T>` (4-lifetime form) but Anchor
v1 collapses to the single-lifetime form. The helper builds `CpiContext` and
runs CPIs without needing to re-pass every account.

This is a useful pattern for future phases that need to fan out CPIs across
multiple branches: extract the shared CPI block into a helper that takes
`&Context` + branch-specific params (here: `flight_id`, `date`, `claim_expiry`,
`SettleVariant`).

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.

### What was built

The on-chain protocol is now **fully feature-complete** end-to-end. Phase 6
delivered two halves:

**Part A — `controller.execute_settlements` per-flight loop** (closes Phase 5 D7
deferred work). The `ExecuteSettlements` accounts struct went from 8 → 17 fields,
adding the static sibling-program references (flight_pool_program / oracle_program /
flight_pool_config / oracle_config / vault_token_account / pool_treasury /
treasury_authority / token_program) and the `active_flight_list` PDA. New
`n_flights: u8` argument splits `remaining_accounts` into the per-flight slice
prefix and the ClaimableBalance suffix consumed by the tail
`vault.process_withdrawal_queue`. Per-flight branches dispatch on `FlightData.status`
∈ `{ToBeSettledOnTime, ToBeSettledDelayed, ToBeSettledCancelled}` and run the
correct CPI chain (with delayed/cancelled sharing a `settle_payout_branch` helper).
After each flight: CPI `oracle.set_settled` transitions the FlightData to terminal,
and `Vec::remove(idx)` deletes the entry from `ActiveFlightList` (FIFO-preserving,
buffered after the loop to avoid borrow conflicts with active CPIs). Tail
housekeeping CPIs (`vault.process_withdrawal_queue` + `vault.snapshot`) fire once
per call regardless of n_flights, including on empty batches.

**Part B — cross-program integration suite on LiteSVM** (single
`contracts/tests/integration.test.ts` file). Three cron jobs simulated by
in-process function calls (`simulateOracle`, `simulateClassifier`,
`simulateSettler`) exposed from `setup.ts`. `bootstrapFullProtocol()` wraps
`bootstrapController` and pre-funds an underwriter with USDC + share-mint ATAs.
Five `describe` blocks cover lifecycle, withdrawal queue under settlement,
solvency edge, authorization isolation, and multi-flight cap. Total: 9 new
integration tests, all green.

After Phase 6: **88/88 tests passing** (1 smoke + 17 governance + 16 vault +
16 flight_pool + 19 oracle_aggregator + 10 controller + 9 integration). All 3
workspaces typecheck clean. `NO_DNA=1 anchor build` green. `pnpm sync-idl` +
`pnpm gen-clients` regenerated typed clients across all 3 dirs.

### Key decisions locked in

- **D-Phase6-1** — Keeper signers must hold lamports for `SnapshotRecord` rent.
  `bootstrapController` now airdrops 2 SOL to the keeper post-generation. The
  cron backend in Phase 10 will need an external monitoring/top-up flow for
  long-running keepers.
- **D-Phase6-2** — `ExecuteSettlements.remaining_accounts` schema is uniform:
  per-flight slice = `(FlightData mut, FlightPool mut)`, ClaimableBalance PDAs
  appended after for `vault.process_withdrawal_queue`. `n_flights: u8` is the
  explicit split marker. Single-tx atomic settlement chosen over per-flight
  fan-out instructions to preserve atomicity guarantees.
- **D-Phase6-3** — Phase 5's deferred unit tests 4.9-4.16 are satisfied by the
  Phase 6 lifecycle test's end-to-end money-flow assertions; redundant
  controller-isolation unit tests were rejected as duplication.
- **D-Phase6-4** — Surfpool's first appearance is shifted **past the cron jobs**
  to Phase 11+ (frontend) or Phase 15 (browser e2e). Phase 6 runs entirely on
  LiteSVM. The Phase 0 Surfpool RPC-reachability artifact stays untouched.
- **D-Phase6-5** — Helper-fn lifetime signature `&Context<'info, T<'info>>`
  (Anchor v1's single-lifetime form) is the canonical pattern for shared
  CPI-chain extraction.

### Files created or modified — final list

**Modified (committed sources):**
- `contracts/programs/controller/src/lib.rs` — `execute_settlements` rewritten
  with per-flight loop. New accounts on `ExecuteSettlements`. New
  `settle_payout_branch` helper. New error variants
  (`InvalidSettlementStatus`, `NotEnoughRemainingAccounts`). New `n_flights: u8`
  arg.
- `contracts/tests/setup.ts` — promoted `setComputeUnitLimitIx`, added
  `bootstrapFullProtocol`, simulator helpers (`simulateOracle.*`,
  `simulateClassifier`, `simulateSettler`), `whitelistRoute`, `depositToVault`,
  `TOKEN_PROGRAM_ADDRESS_KIT`. **`bootstrapController` now airdrops 2 SOL to
  the keeper signer.**
- `contracts/tests/controller.test.ts` — Phase 5 test 4.17 updated to pass the
  new `ExecuteSettlements` accounts.
- `spec/progress.md` — Phase 6 row + active-phase pointer.

**Created:**
- `contracts/tests/integration.test.ts` — 9 cross-program integration tests.
- `spec/phases/phase-06-cross-program-integration-tests.md` — this file.

**Regenerated (gitignored):**
- `contracts/target/idl/controller.json` — schema reflects new `ExecuteSettlements`
  accounts + `n_flights` arg + new errors.
- `frontend/src/clients/`, `executor/src/clients/`, `contracts/tests/clients/` —
  Codama clients for all 5 programs.

### Notes for the next phase (Phase 7 — Devnet Deployment)

- **Devnet keeper must be funded** continuously. Phase 7's deploy script should
  set up an initial 5+ SOL airdrop on the keeper's devnet keypair (`keys/executor.pubkey`
  is already committed). Plan Phase 10's cron backend with a SOL-balance health
  check that bumps an alert if the keeper falls below ~0.1 SOL.
- **Program IDs unchanged** from Phase 5: governance/vault/flight_pool/oracle/controller
  pubkeys are pinned in `Anchor.toml` `[programs.devnet]` and `setup.ts`.
- **`MAX_FLIGHTS_PER_TX = 2`** confirmed adequate at 1.4M CU. Devnet load tests
  in Phase 10 may revisit this if real flight volumes warrant batching.
- **`Surfpool.toml` packed-Mint blob** is still a Phase 0 placeholder — devnet
  uses a real `spl-token create-token` from `keys/mock-usdc.json`, so the
  Surfpool blob isn't on the Phase 7 critical path. Defer to Phase 11+ when
  Surfpool actually runs.
- **`controller_config_pda` is the canonical signer for all sibling programs**:
  vault.controller, flight_pool.controller, oracle.authorized_consumer all hold
  this address. Devnet wiring (Phase 7 deploy script) must run the three
  set_controller / set_authorized_consumer calls **after** controller.initialize.
- **Per-flight slice schema** (D-Phase6-2) is what the cron's executor (Phase 10)
  must produce: 2 accounts per flight (FlightData, FlightPool) followed by
  ClaimableBalance PDAs from the active vault queue.
- **The settlement loop atomic guarantee** means classify_flights and
  execute_settlements both must respect the active list ordering. The cron
  must NOT skip-ahead in the queue; it should always classify/settle the
  oldest active flight first.

### Known limitations / deferred

- The `controller.execute_settlements` does NOT realloc-shrink `ActiveFlightList`
  when removing flights — `Vec::remove` shrinks the in-memory `Vec::len` but the
  account's allocated bytes stay at high-water mark. Long-running deployments
  may eventually want a compaction instruction; deferring as a non-blocking
  follow-up.
- Snapshot rent is paid by the keeper signer. If the keeper has no SOL, the
  whole `execute_settlements` reverts. Phase 10's cron backend must include a
  SOL-balance check + auto-top-up flow.
- `MAX_FLIGHTS_PER_TX = 2` is conservative; with `setComputeUnitLimit(1_400_000)`
  and the observed ~83K CU per inner instruction, 4-5 flights/tx might be
  achievable. Defer to a perf-tuning phase if real flight volume warrants.
- No on-chain accounting reconciliation tests yet (Σpayouts == sum of
  delayed+cancelled across all flights). Defer to a dedicated invariant-testing
  phase.
- The Phase 0 Surfpool RPC-reachability artifact is left as-is; running it
  requires a separate Surfnet (`pnpm dev:surfpool`).
