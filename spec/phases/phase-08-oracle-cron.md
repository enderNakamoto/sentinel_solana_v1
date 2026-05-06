# Phase 8 — Oracle Cron (FlightDataFetcher)

Status: complete
Started: 2026-05-05
Completed: 2026-05-05

---

## Goal

Build the off-chain cron #1 — `FlightDataFetcher` — which pulls flight data from FlightAware AeroAPI and writes it to `FlightData` accounts on `oracle_aggregator_program`. This cron is signed by the `authorized_oracle` keypair and runs every 2 hours in production. This phase also stands up the `executor/` core scaffolding (`types`, `aeroapi_client`, `solana_client`) that Phases 9 and 10 reuse.

## Dependencies

- Phase 7 (Devnet Deployment, complete) — provides `deployments/<cluster>-latest.json` with program IDs + PDAs that the cron reads.

## Design constraints (locked)

1. **No contract changes.** The existing oracle state machine (`NotInitiated → Active → Landed/Cancelled`) handles all cases when the cron orders ixs correctly.
2. **Boolean-only AeroAPI checks.** Use `cancelled` (boolean) and `actual_in !== null` (null-check). Never branch on the human-readable `status` string.
3. **Two-ix-in-one-tx for cancel/land-before-ETA.** If AeroAPI returns `cancelled === true` (or `actual_in !== null`) on the first cron tick — before any `set_estimated_arrival` has run — the FlightData is still `NotInitiated`. The cron bundles `[set_estimated_arrival(scheduled_in), set_cancelled]` (or `set_landed`) in a single tx so the state machine traverses `NotInitiated → Active → Cancelled` (or `Landed`) atomically.
4. **ETA source is `scheduled_in`, not `estimated_in`.** The original published schedule is the contract the policy was sold against; airline-updated estimates drift during delays and would under-report passenger-experience delay.
5. **Authority isolation maintained.** The cron's keypair (`keys/<cluster>-oracle.json` from Phase 7) is the `authorized_oracle` only — it cannot trigger payouts even if compromised.

## Subtasks

### A. Executor core scaffold (reused by Phases 9 + 10)
- [x] 1. `executor/src/core/types.ts` — `FlightStatus` enum mirror, AeroAPI response types (`AeroFlight`, `AeroFlightsResponse`, `AeroAirport`), `FetcherAction` discriminated union, `DeploymentArtifact` shape, `isoToUnixSec` helper.
- [x] 2. `executor/src/core/aeroapi_client.ts` — `createAeroApiClient({apiKey, fetchImpl?, baseUrl?})` returns `{fetchFlightsForDay(ident, dateIso)}`. Swallows all HTTP errors → null; rejects malformed dateIso. `pickLatestFlight` helper.
- [x] 3. `executor/src/core/solana_client.ts` — `createSolanaClient({keypairPath, repoRoot, cluster, rpcUrl?})` builds a `SolanaClient` with `readActiveFlightList`, `readFlightDataStatus`, `readFlightDataState`, `sendIxs` (build → sign → send → confirm via `getBase64EncodedWireTransaction`). `loadDeployment`, `loadKeypairSigner` helpers. **Hand-rolled Anchor account decoders** (no Codama imports) so the module loads cleanly under vitest.
- [x] 4. (combined into solana_client.ts) `readActiveFlightList` returns `{flightId: string, date: bigint}[]`.
- [x] 5. (combined into solana_client.ts) `readFlightDataState` returns `{status, estimatedArrivalTime, actualArrivalTime}` decoded from raw bytes.

### B. Fetcher logic
- [x] 6. `executor/src/core/flight_data_fetcher.ts` exports **pure** `decideFetcherActions(flight, currentStatus)` returning a `FetcherAction`. **Boolean-only logic** — branches on `flight.cancelled` and `flight.actual_in !== null` ONLY; the `status` string is never read. **Six action variants**: skip, set_estimated_arrival, set_landed, set_cancelled, set_estimated_arrival_then_cancelled (atomic), set_estimated_arrival_then_landed (atomic).
- [x] 7. `runFetcherOnce({solana, aero, applyAction, log?})` — main loop. Reads ActiveFlightList, fetches each flight from AeroAPI, picks latest entry, reads on-chain FlightData status, calls `decideFetcherActions`, hands the action to the runner-supplied `applyAction` callback. Logs per-flight + summary.

### C. One-shot runner
- [x] 8. `executor/src/scripts/run-fetcher.ts` — env-driven (CLUSTER, ORACLE_KEYPAIR, AEROAPI_KEY, optional SOLANA_RPC_URL, AEROAPI_BASE_URL). Translates `FetcherAction` → Codama-generated ixs (`getSetEstimatedArrivalInstructionAsync`, `getSetLandedInstructionAsync`, `getSetCancelledInstructionAsync`) and submits via `solana.sendIxs([...])`. Two-ix actions go in one tx.
- [x] 9. `scripts/run.sh` extended to also resolve `executor/src/scripts/<name>.ts` (in addition to root `scripts/<name>.ts`). Bundles to `executor/src/scripts/dist/<name>.mjs`. `pnpm run-fetcher` wired in root `package.json` (also `run-classifier` and `run-settler` for Phase 9/10).

### D. Tests
- [x] 10. `vitest@^2.1.0` added to `executor/package.json` devDependencies; `node-cron` + `@solana/spl-token` + `@solana/web3.js` added as runtime deps.
- [x] 11. `executor/tests/decide_fetcher_actions.test.ts` — **19 pure-function tests** covering every branch: cancelled-from-Active, cancelled-from-NotInitiated (atomic two-ix), cancelled-from-NotInitiated-no-eta (skip), landed-from-Active, landed-from-NotInitiated (atomic two-ix), landed-from-NotInitiated-no-eta (skip), in-flight ETA seed, in-flight Active skip, all 6 terminal states (Landed/Cancelled/Settled/3×ToBeSettled*) → skip, **status-string-ignore invariant** (5 string variants don't change cancelled-from-Active outcome), invalid ISO date → skip. **Cancelled flag dominance** confirmed (cancelled+actual_in conflict resolves to cancelled).
- [x] 12. `executor/tests/aeroapi_client.test.ts` — **15 mocked-fetch tests** covering URL/header shape, dateIso validation, error swallowing for 6 HTTP statuses (401/403/404/429/500/502), network exception, JSON parse error, empty-flights-array (returns []), missing-flights-field (returns null), `pickLatestFlight` empty/non-empty, constructor validation.
- [x] 13. `executor/vitest.config.ts` — picks up `tests/**/*.test.ts`.

### E. Docs + env
- [x] 14. `executor/.env.example` documents all env vars across Phase 8/9/10.
- [x] 15. (deferred — README cron-runbook section can land in Phase 10 alongside the node-cron backend; Phase 8 scope is fetcher only.)

### Gate

- All 9+ unit tests pass under `pnpm --filter @sentinel/executor test`.
- `pnpm typecheck` passes across the executor workspace.
- Code review: `decideFetcherActions` is pure (no RPC, no I/O); the runner module composes it with RPC calls; logic clearly maps `cancelled`/`actual_in!==null` booleans to ix decisions.
- Integration with the broader system: when surfpool is running and a deployment exists, the fetcher correctly transitions a NotInitiated flight to Active given a mocked AeroAPI scheduled_in; this step is operator-driven, not in CI.

---

## Work Log

### Session 2026-05-05

Phase 7 closed; moving to autonomous Phase 8 implementation. Per the user's "use your best judgment, no contract changes, boolean values only" directive, this phase ships only the off-chain cron + tests. No oracle program edits.

Implementation order: types → aeroapi_client (with mocked fetch tests) → solana_client → fetcher decision function (pure) → fetcher runner (RPC-driven) → bundle-then-run wrapper → root package.json scripts.

**Outcomes:**
- 5 new core modules (`types`, `aeroapi_client`, `solana_client`, `flight_data_fetcher`, plus the runner script in `scripts/`).
- 34 unit tests passing (19 decision-function + 15 AeroAPI-client). Pure tests run in 8ms; the whole suite runs under 300ms.
- Typecheck clean across the executor workspace.
- `pnpm run-fetcher` wires through `scripts/run.sh` (extended to also resolve `executor/src/scripts/<name>.ts`); the bundle invocation correctly errors with `missing env var: CLUSTER` when run without env, proving the bundle loads cleanly.

**No contract changes** per the user directive. The two-ix-in-one-tx pattern handles the cancel/land-before-ETA edge case using only the existing oracle ixs.

**Status-string-ignore invariant verified by tests** — five variants of the AeroAPI `status` field (`"Landed"`, `"Cancelled"`, `"En Route"`, `""`, `"Diverted"`) all produce the same `set_cancelled` decision when `cancelled === true`. The string is structurally present in `AeroFlight` but never branched on.

## Decisions Made

- **D-Phase8-1: Pure decision function + impure runner split.** `decideFetcherActions(flight, currentStatus)` is a pure data-in/data-out function that returns a `FetcherAction` discriminated union. The runner (`run-fetcher.ts`) translates that abstract action to Codama-generated ixs and sends them. This split keeps the unit tests trivial (no RPC mocks, no Codama imports) and makes the cron's logic auditable as a state machine.
- **D-Phase8-2: Hand-rolled Anchor account decoders in `solana_client.ts`.** The module reads `ActiveFlightList` and `FlightData` accounts via `getAccountInfo` and decodes the bytes directly. **No Codama imports** here so vitest can load the module cleanly without hitting the directory-import quirk. The Codama-generated ix builders are imported only from the runner (which uses esbuild bundling).
- **D-Phase8-3: Boolean-only AeroAPI logic.** The cron branches on `flight.cancelled` (boolean) and `flight.actual_in !== null` (null-check) — never on the human-readable `status` string. The `AeroFlight` type accepts the string field for compatibility but it's never read by `decideFetcherActions`. Tests assert this invariant by varying the `status` value across 5 misleading strings and confirming the decision is unchanged.
- **D-Phase8-4: ETA source = `scheduled_in`, not `estimated_in`.** The cron writes `scheduled_in` (original published gate-arrival) as the on-chain `estimated_arrival_time`. This anchors the classifier's later `delay = actual - estimated` computation against the **original promise to the passenger**, not the airline's drifting running estimate. Insurance industry convention.
- **D-Phase8-5: Two-ix-in-one-tx for cancel/land-before-ETA.** When AeroAPI returns `cancelled === true` (or `actual_in !== null`) on the first cron tick, the FlightData is still `NotInitiated` and a direct `set_cancelled` would revert. The cron bundles `[set_estimated_arrival(scheduled_in), set_cancelled]` (or `set_landed`) atomically — the state machine traverses cleanly within one tx. Both ixs are tiny state writes (no SPL CPIs); fits well under default 200K CU. **No contract change required.**
- **D-Phase8-6: Cancelled flag dominance over actual_in.** If AeroAPI returns both `cancelled === true` and a non-null `actual_in` (a contradictory edge case), the cron picks `set_cancelled`. Reasoning: the airline's official cancellation verdict supersedes a possibly-stale arrival timestamp. Tested explicitly.
- **D-Phase8-7: AeroAPI failures swallowed → null.** All HTTP errors (401/403/404/429/5xx, network exceptions, JSON parse failures) return `null` from the AeroAPI client. The cron treats `null` as "skip and retry next tick". Reasoning: the on-chain forward-only state machine is the safety net — a missed tick never causes incorrect state, just delayed. Per the `aero-api` skill's W009-style guidance.
- **D-Phase8-8: `scripts/run.sh` resolves both root `scripts/` and `executor/src/scripts/`.** Single bundle-then-run wrapper for all repo runners. Avoids needing two parallel runner harnesses. Each cron's `pnpm run-<name>` script invokes `bash scripts/run.sh <name>` which finds the source in either location.

## Files Created / Modified

### New
- `executor/src/core/types.ts` (~150 LOC)
- `executor/src/core/aeroapi_client.ts` (~110 LOC)
- `executor/src/core/solana_client.ts` (~220 LOC)
- `executor/src/core/flight_data_fetcher.ts` (~190 LOC)
- `executor/src/scripts/run-fetcher.ts` (~200 LOC)
- `executor/tests/decide_fetcher_actions.test.ts` (~150 LOC)
- `executor/tests/aeroapi_client.test.ts` (~130 LOC)
- `executor/vitest.config.ts`
- `executor/.env.example`
- `spec/phases/phase-08-oracle-cron.md`

### Modified
- `executor/package.json` — added `vitest`, `node-cron`, `@solana/spl-token`, `@solana/web3.js` deps + `test` script
- `package.json` — added `run-fetcher`, `run-classifier`, `run-settler` script entries
- `scripts/run.sh` — extended to resolve `executor/src/scripts/<name>.ts`
- `spec/progress.md` — Phase 8 status → in_progress (will flip to complete on commit)

## Completion Summary

**Phase 8 closed 2026-05-05.** FlightDataFetcher cron ships as a pure decision function + an impure RPC-driven runner. 34/34 unit tests pass; typecheck clean. The cron uses **only** boolean fields (`cancelled`, `actual_in !== null`) from AeroAPI per the locked design — the `status` string is never branched on (verified by test). The cancel/land-before-ETA edge case is handled by atomic two-ix-in-one-tx without any contract change. The executor scaffold (`types`, `aeroapi_client`, `solana_client`) is now reusable by Phases 9 and 10. **Ready for /complete-phase 8.**
