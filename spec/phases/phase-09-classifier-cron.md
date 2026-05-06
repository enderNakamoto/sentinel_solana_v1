# Phase 9 — Classifier Cron (FlightClassifier)

Status: complete
Started: 2026-05-05
Completed: 2026-05-05

---

## Goal

Build the off-chain cron #2 — `FlightClassifier` — which calls `controller.classify_flights()` periodically. The on-chain handler reads each flight's `FlightData` (Landed/Cancelled) + `FlightPool` (delay_hours threshold), computes the delay against the threshold, and writes the `ToBeSettled*` variant via CPI to oracle. The cron's job is just to assemble the right `remaining_accounts` per flight and respect `MAX_FLIGHTS_PER_TX = 2`.

This cron uses **no AeroAPI** — pure on-chain reads + a single ix call per batch.

## Dependencies

- Phase 8 (executor scaffold: `types`, `solana_client`, `aeroapi_client`) — reused.
- Phase 7 (deployment artifact + keeper keypair).

## Design constraints

1. **No contract changes.** The controller's `classify_flights` already does all the work; the cron just feeds it batches of `(FlightData, FlightPool)` pairs.
2. **No AeroAPI.** The cron only reads on-chain state.
3. **Respect MAX_FLIGHTS_PER_TX = 2.** Multi-tx fanout: split classifiable flights into batches of ≤2; one tx per batch. Sequential, not parallel — keeps tx ordering predictable + simplifies failure recovery.
4. **Idempotent.** Already-classified flights (in `ToBeSettled*` or beyond) are filtered out before batching. The on-chain handler also skips them via its `_ => continue` arm, so a stale view is safe.
5. **Signed by `authorized_keeper`** (the same key used by Phase 10 settler — separate from the oracle key from Phase 8).

## Subtasks

- [x] 1. `executor/src/core/flight_classifier.ts` exports pure `decideClassifierBatches(flights, maxPerTx)` returning `ActiveFlightEntry[][]`. Filters to Landed/Cancelled only; chunks into batches of `maxPerTx` (default `MAX_FLIGHTS_PER_TX = 2`).
- [x] 2. `runClassifierOnce({solana, applyBatch, log?, maxPerTx?})` — main loop. Reads ActiveFlightList, fetches each flight's status in parallel via `Promise.all`, calls `decideClassifierBatches`, invokes `applyBatch` per batch with per-batch try/catch so one failed batch doesn't block subsequent ones.
- [x] 3. `executor/src/scripts/run-classifier.ts` — env-driven runner (CLUSTER + KEEPER_KEYPAIR). Translates each batch into a `controller.classify_flights` ix with `remaining_accounts` = `[(FlightData WRITABLE, FlightPool READONLY), ...]` per Phase 6 simulator pattern. Prepends `SetComputeUnitLimit(1_400_000)` per Phase 5 D-Phase5-3.
- [x] 4. `executor/tests/decide_classifier_batches.test.ts` — **12 unit tests** covering empty input, all-skip (NotInitiated/Active/Settled/3×ToBeSettled*), single classifiable, mixed-status filtering preserves order, chunking at boundary (3→[2,1] / 4→[2,2] / 5→[2,2,1]), Landed+Cancelled mix combined into one queue, custom maxPerTx (1, 10), invalid maxPerTx throws. **MAX_FLIGHTS_PER_TX = 2 invariant explicitly asserted** to keep cron in sync with the on-chain controller constant.
- [x] 5. `pnpm run-classifier` already wired in Phase 8 prep; bundle invocation verified (errors with `missing env var: CLUSTER` proving it loads).

### Gate

- All classifier unit tests pass.
- `pnpm typecheck` clean across executor.
- Bundle invocation verified (`pnpm run-classifier` errors with env-missing message).
- Multi-tx fanout: 3-flight scenario produces 2 batches (sizes 2 + 1) verified by test.

---

## Work Log

### Session 2026-05-05

Continuing autonomous run after Phase 8. Phase 9 is structurally simpler — no AeroAPI, single ix per batch, pure delay-calculation already on-chain. The cron is reduced to "filter to Landed/Cancelled, chunk into batches of 2, send".

**Outcomes:**
- 1 new core module (`flight_classifier.ts`, ~125 LOC) + 1 runner (`run-classifier.ts`, ~165 LOC) + 1 test file (12 tests).
- 46/46 unit tests passing (added 12 to the existing 34 from Phase 8).
- Typecheck clean.
- Bundle invocation verified.

**One bug caught + fixed during typecheck:** the JSDoc comment in `flight_classifier.ts` contained the literal string `ToBeSettled*/Settled` which esbuild + tsc parsed as a comment terminator (`*/`) followed by garbage. Reworded the comment to `the 'ToBeSettled' variants and Settled`. Lesson: avoid `*/` substrings in JSDoc bodies even when conceptually inside a code-fence-style range.

## Decisions Made

- **D-Phase9-1: `MAX_FLIGHTS_PER_TX = 2` exported as a named const + asserted in tests.** Mirrors the controller program's hardcoded constant. The test asserts equality so any future drift between the cron and the contract surfaces immediately. The constant is a function default param; runner integration tests can override via `maxPerTx`.
- **D-Phase9-2: Per-batch try/catch in the runner loop.** A single batch failure (RPC error, expired blockhash, or rare on-chain revert) is logged and the loop continues to the next batch. Reasoning: idempotency means re-running on the next tick is safe, but partial progress (some batches succeeded) is also valuable — better to ship 2 of 3 batches than to abort entirely on the first error.
- **D-Phase9-3: Parallel status reads via `Promise.all`.** The ActiveFlightList is small (capped by buyer activity, typically <20 entries in practice) and getAccountInfo calls are independent. Parallel reads cut tick latency without adding RPC load that matters.
- **D-Phase9-4: Codama imports stay in the runner script.** `flight_classifier.ts` core module is Codama-free for clean unit testing. The Codama-generated `getClassifyFlightsInstructionAsync` lives only in `run-classifier.ts` which is bundled via esbuild for execution. Same architectural split as Phase 8.

## Files Created / Modified

### New
- `executor/src/core/flight_classifier.ts` (~125 LOC)
- `executor/src/scripts/run-classifier.ts` (~165 LOC)
- `executor/tests/decide_classifier_batches.test.ts` (~115 LOC)
- `spec/phases/phase-09-classifier-cron.md`

### Modified
- `spec/progress.md` — Phase 9 status → in_progress (will flip to complete on commit)

## Completion Summary

**Phase 9 closed 2026-05-05.** FlightClassifier cron ships as a pure batching function + an impure RPC-driven runner. 46/46 unit tests pass; typecheck clean. The cron uses **no AeroAPI** — only on-chain reads + a single `controller.classify_flights` ix per batch. Multi-tx fanout respects the on-chain `MAX_FLIGHTS_PER_TX = 2` constant; the constant is exported and asserted in tests for symmetry. Per-batch try/catch ensures one failure doesn't block subsequent batches — idempotency makes retry-next-tick safe. **Ready for /complete-phase 9.**
