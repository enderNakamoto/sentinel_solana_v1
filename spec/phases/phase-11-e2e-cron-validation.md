# Phase 11 — End-to-End Cron Validation (Surfpool, no frontend)

Status: complete
Started: 2026-05-06
Completed: 2026-05-06

---

## Goal

Validate the full on-chain + cron loop on a live Surfpool deployment by driving multiple
parameterized scenarios through the **real cron core functions** (`runFetcherOnce` /
`runClassifierOnce` / `runSettlerOnce`) with a mocked AeroAPI returning scripted flight
states. Asserts that money moves correctly across the full stack — vault, flight_pool,
oracle_aggregator, controller — using the actual runner code paths, not LiteSVM
simulators. The last sanity gate before frontend work begins. **No contract changes.**

## Dependencies

- Phase 7 — devnet/surfpool deploy script + `deployments/surfpool-latest.json` artifact.
- Phase 8 — `runFetcherOnce` + AeroAPI client (we extend the latter with 4xx envelope decode).
- Phase 9 — `runClassifierOnce`.
- Phase 10 — `runSettlerOnce`.

No new on-chain code. No new programs. Reuses everything Phases 1–10 produced.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills

- `git`
- `solana-dev`
- `aero-api` (the mock client must satisfy the same contract as the real client)

### Skill References

- `solana-dev/references/compatibility-matrix.md`
- `solana-dev/references/common-errors.md`
- `solana-dev/references/security.md`
- `solana-dev/references/testing.md`
- `solana-dev/references/surfpool/overview.md`
- `solana-dev/references/surfpool/cheatcodes.md`
- `solana-dev/references/kit/overview.md`
- `solana-dev/references/kit/advanced.md`
- `solana-dev/references/idl-codegen.md`

### Docs to Fetch

- https://docs.surfpool.run/ — Surfpool integration / time-travel cheatcodes (in case we need them for the queued-withdrawal scenario)
- https://github.com/anza-xyz/kit — Kit advanced patterns (for any RPC quirks the test may hit)

### Project Files to Read

- `spec/architecture.md` (full file, including §Off-Chain Executor Layer at L758+)
- `spec/dev_steps.md` (Phase 11 section)
- `spec/workflow.md`
- `MEMORY.md`
- `executor/src/core/aeroapi_client.ts` — extend for 4xx envelope decode
- `executor/src/core/types.ts` — `AeroFlight`, `AeroFlightsResponse`, `FlightStatus`
- `executor/src/core/flight_data_fetcher.ts` — pure decision + `runFetcherOnce`
- `executor/src/core/flight_classifier.ts` — `runClassifierOnce`
- `executor/src/core/settlement_executor.ts` — `runSettlerOnce`
- `executor/src/core/solana_client.ts` — `readActiveFlightList`, `readFlightDataState`, etc.
- `executor/src/scripts/run-fetcher.ts` — `actionToIxs` (export for test use)
- `executor/src/scripts/run-classifier.ts` — `buildClassifyBatchIx`
- `executor/src/scripts/run-settler.ts` — `buildSettleBatchIxs`, `currentDay`
- `executor/src/backends/cron/index.ts` — wiring pattern (test mirrors per-tick flow)
- `executor/tests/` — existing unit-test layout (vitest config, helpers)
- `contracts/tests/integration/full-flow-deployed.test.ts` — skip pattern + deployment-artifact loader
- `scripts/deploy.ts`, `scripts/bootstrap-test-actors.ts` — actor key bootstrap
- `keys/test-actors/` — pre-bootstrapped actor keypairs (investor-a/b, buyer-a/b/c)

## Pre-work Notes

> Constraints, decisions already made, and patterns to follow. Edit before `/start-phase`.

### Hard constraints

- **No contract changes.** This phase is a test-suite + AeroAPI-client extension only.
  If a scenario surfaces an on-chain bug, file it as a follow-up, do not patch contracts here.
- **No changes to the cron core functions.** `runFetcherOnce` / `runClassifierOnce` /
  `runSettlerOnce` must work as-is against the mock; if they don't, the test is wrong.
- **No changes to the runner scripts** (`run-fetcher.ts` / `run-classifier.ts` / `run-settler.ts`)
  except to *export* helpers (`actionToIxs`, `buildClassifyBatchIx`, `buildSettleBatchIxs`,
  `currentDay`) that the test imports. They're already exported per the existing daemon
  wiring at `executor/src/backends/cron/index.ts` — verify before extending.

### Confirmed design decisions

- **Test isolation: append-to-existing-deployment** (option a). Each scenario uses a
  timestamp-suffixed flight ident — `E2E-{runIdHex}-{scenarioIndex}` — so FlightPool PDAs
  don't collide across runs. Vault/governance/route state is durable and reused. The deploy
  artifact at `deployments/surfpool-latest.json` is the source of truth; test skips if absent.
- **8 scenarios** (the original 7 from `dev_steps.md` + scenario 8 below for live envelope
  validation). Cross-day snapshot validation deferred to Phase 16.
- **Mock AeroAPI**: parameterized state map + tick-by-tick mutation. The mock implements the
  same `AeroApiClient` shape (`fetchFlightsForDay(ident, dateIso): Promise<AeroFlight[] | null>`).
  Returning `null` simulates HTTP error / not-found. The mock also supports a "seed error
  envelope" mode for scenario 8 — when an ident is in error mode, the mock logs the envelope
  via the same path as the real client (so we exercise the new structured logging end-to-end).
- **AeroAPI 4xx envelope shape:**
  ```json
  { "title": "string", "reason": "string", "detail": "string", "status": 0 }
  ```
  Real client: parse envelope → log structured fields → return null. Mock: same logging path,
  no real fetch. Unit tests cover parse robustness; integration scenario 8 covers wiring.
- **AeroAPI flight response shape** (subset we care about — full schema in user's reference):
  ```ts
  type AeroFlight = {
    ident: string;
    cancelled: boolean;
    actual_in: string | null;       // ISO timestamp; null until landed
    scheduled_in: string;           // ISO timestamp; ETA seed
    estimated_in: string | null;
    // ... we ignore `status` (string), `diverted` (out of scope)
  };
  ```
- **Boolean-only branching invariant.** Per Phase 8 D-Phase8-3: never branch on the human
  `status` string. Scenario 7 defends this — flight returns `status: "Cancelled"` but
  `cancelled: false` and `actual_in: null`. Cron must treat as in-flight.

### Test runner & layout

- **Vitest** (matches existing executor + `contracts/tests/integration/` pattern).
- Test file: `contracts/tests/integration/e2e-with-crons-deployed.test.ts`
- Mock fixture: `executor/src/test/mock_aero_api.ts` (importable from both workspaces).
- Envelope unit tests: `executor/tests/aeroapi_error_envelope.test.ts`
- New pnpm script: `pnpm test:e2e:crons` → `vitest run contracts/tests/integration/e2e-with-crons-deployed.test.ts`
- The integration test must skip with a clear warning when (1) Surfpool isn't running,
  or (2) `deployments/surfpool-latest.json` is missing or stale. Do NOT auto-deploy.

### Funding

- Investors and buyers come from `keys/test-actors/` (already bootstrapped via
  `pnpm bootstrap-test-actors`).
- SOL: `pnpm fund-sol --cluster surfpool --recipient <pk> --amount 5` per actor.
- USDC: `pnpm fund-usdc --cluster surfpool --recipient <pk> --amount 50000` per actor.
- Inline these as helper calls inside the test's `beforeAll` rather than spawning subshells —
  the funding scripts already export their core logic as importable functions.

### Open questions for the agent

- Does Surfpool 1.2.0 honor `slot` advancement enough that `currentDay()` returns the right
  PDA across the test's ~5-min runtime? (Phase 10 D-Phase10-5 already documented the
  `getBlockTime(getSlot)` fallback. If surfpool's clock drifts inside a test run, scenario 6
  may need to manually warp via `surfnet_setTime` cheatcode. Decide at implementation time.)

---

## Subtasks

### A. AeroAPI client — 4xx envelope decode

- [x] 1. Extend `executor/src/core/aeroapi_client.ts`: parse the 4xx error envelope
      `{title, reason, detail, status}` from `res.json()` on non-2xx responses; log a
      structured one-liner (`[aero] 4xx: status=N title="..." reason="..." detail="..."`)
      then return null. 5xx + network + JSON-parse failures keep the existing
      generic `[aero] HTTP ${status}` log path.
- [x] 2. Export an `AeroApiError` type (the parsed envelope shape) so tests can assert it.
- [x] 3. `executor/tests/aeroapi_error_envelope.test.ts` — unit tests:
      well-formed 400 envelope → parsed + logged + null returned;
      malformed body (missing fields) → fallthrough to generic log + null;
      non-JSON body → fallthrough;
      5xx → generic log path (no envelope decode attempted);
      network exception → null with no envelope log.
      ≥ 6 tests.

### B. Mock AeroAPI client (test fixture)

- [x] 4. `executor/src/test/mock_aero_api.ts` — `createMockAeroApi()` factory returning
      a `AeroApiClient` shape:
      ```ts
      export interface MockAeroApi extends AeroApiClient {
        seed(ident: string, dateIso: string, flight: AeroFlight): void;
        mutate(ident: string, dateIso: string, partial: Partial<AeroFlight>): void;
        seedError(ident: string, dateIso: string, envelope: AeroApiError): void;
        clear(): void;
      }
      ```
      Internal state: `Map<"{ident}|{dateIso}", AeroFlight | { __error: AeroApiError }>`.
      `fetchFlightsForDay`: returns `[flight]` for happy path, returns null for missing
      keys (matches real client's not-found behavior), and for error-seeded keys logs the
      envelope via the **same `console.error` path the real client uses** then returns null.
- [x] 5. Re-export `AeroFlight` and `AeroApiError` from `mock_aero_api.ts` so tests have
      one import.

### C. E2E test harness

- [x] 6. `contracts/tests/integration/e2e-with-crons-deployed.test.ts`:
      - Skip-if-not-ready pattern (mirror `full-flow-deployed.test.ts:281–340`).
      - Load `deployments/surfpool-latest.json` via `loadDeployment()`; skip with warning
        if missing.
      - Build `runId = randomBytes(4).toString('hex')` once for the suite; flight idents
        are `E2E-${runId}-${i}`.
      - Build two `SolanaClient`s (oracle key, keeper key) from `keys/executor.json` —
        same key serves both authorities on surfpool per Phase 7.
      - Mint USDC + airdrop SOL to test actors in `beforeAll` via imported funding helpers.
- [x] 7. Define a `Scenario` type:
      ```ts
      type Scenario = {
        name: string;
        flightId: string;       // 'E2E-{runId}-{i}'
        date: string;           // ISO YYYY-MM-DD
        buyers: TestActor[];    // 1–3 actors from keys/test-actors/
        timeline: Tick[];       // ordered mutations + tick triggers
        assertOutcome: (ctx) => Promise<void>;
      };
      type Tick =
        | { kind: 'mutate'; aero: Partial<AeroFlight> }
        | { kind: 'fetcher' }
        | { kind: 'classifier' }
        | { kind: 'settler' }
        | { kind: 'queue-withdrawal'; investor: TestActor; shares: bigint };
      ```
      and a `runScenario(scenario)` driver that executes the timeline against the live
      cluster, calling the actual `runFetcherOnce` / `runClassifierOnce` / `runSettlerOnce`
      functions with the mock aero injected for fetcher.
- [x] 8. Bootstrap helper inside the test: `bootstrapInsuranceFlow(scenario)` —
      registers the route via governance (idempotent), buys insurance from each buyer via
      `controller.buy_insurance` (which auto-registers the FlightPool + InitFlightData on
      first buy per Phase 5 design).

### D. Scenarios (8 total)

- [x] 9. **Scenario 1 — on-time landing.** Mutate to `actual_in ≈ scheduled_in`.
      Fetcher → set_landed; classifier → ToBeSettledOnTime; settler → Settled.
      Assert: vault TMA ↑ premium × buyers, locked ↓ payoff × buyers, no buyer ATA credit.
- [x] 10. **Scenario 2 — delayed beyond threshold.** Mutate to
       `actual_in - scheduled_in > delay_hours`. Fetcher → set_landed;
       classifier → ToBeSettledDelayed; settler → Settled.
       Assert: pool treasury holds payoff × buyers, locked ↓, claim() succeeds → buyer
       USDC ↑ payoff.
- [x] 11. **Scenario 3 — cancelled before ETA-seed.** Buy insurance; mutate to
       `cancelled: true` BEFORE first fetcher tick. Fetcher: NotInitiated +
       cancelled=true → atomic 2-ix-in-1-tx (set_estimated_arrival → set_cancelled).
       Classifier → ToBeSettledCancelled; settler → Settled. Buyer claims. Assert atomic
       transition (status jumps NotInitiated → Cancelled in one tx).
- [x] 12. **Scenario 4 — cancelled after ETA-seed.** Tick 1 fetcher seeds ETA
       (NotInitiated → Active). Tick 2 mutates to `cancelled: true`. Tick 2 fetcher fires
       single-ix `set_cancelled`. Settles + claim path same as Scenario 3.
- [x] 13. **Scenario 5 — multi-flight in single settler tick.** Three flights
       (`E2E-{runId}-5a`, `5b`, `5c`), all driven to ToBeSettled* simultaneously by a
       single classifier batch. Settler chunks at MAX_FLIGHTS_PER_TX = 2 → two txs in
       sequence ([2, 1] split). Assert both txs land + ActiveFlightList drains fully.
- [x] 14. **Scenario 6 — withdrawal queued during active flight.**
       Investor deposits 10k USDC at tick 0. Buyer purchases. Investor queues redemption
       (request_withdrawal) at tick 1 — vault locked > free, so it goes to queue. Mutate
       flight to delayed; fetcher → classifier → settler. After settler tick, queue is
       drained; investor's `ClaimableBalance` PDA shows the queued amount; investor
       `collect()`s. Asserts Model B value-at-request-time semantics under live RPC.
- [x] 15. **Scenario 7 — status-string-ignored invariant.** Mutate to
       `status: "Cancelled"`, `cancelled: false`, `actual_in: null`. Fetcher must ignore
       the string and treat as in-flight (no on-chain state change).
       Assert: FlightData status unchanged across the tick.
- [x] 16. **Scenario 8 — AeroAPI 4xx envelope path.** `mock.seedError(ident, date,
       {title, reason, detail, status})` for tick 1; cron fetcher logs the envelope and
       skips (no on-chain state change). Capture `console.error` output, assert the
       envelope's `title` + `reason` appear in the log line. Tick 2: `mock.seed(...)`
       valid landed flight; fetcher resumes normal processing on the next tick.

### E. Docs + scripts

- [x] 17. Add `pnpm test:e2e:crons` script to root `package.json`.
- [x] 18. README "Running the e2e cron suite" section: prereqs (`pnpm dev:surfpool`,
       `pnpm run deploy --cluster surfpool --owner ...`, `pnpm bootstrap-test-actors`),
       command, what each scenario validates, expected runtime.

### Gate

- All 8 scenarios pass against a live Surfpool deployment via `pnpm test:e2e:crons`.
- AeroAPI 4xx envelope unit tests pass (≥ 6 new tests).
- All Phase 8/9/10 unit tests still pass standalone (`pnpm --filter @sentinel/executor test`).
- Total executor unit tests rise from 58 → 64+.
- No contract changes (verify via `git diff --name-only main contracts/programs/`).
- README has the "Running the e2e cron suite" section.
- Test runtime under 5 min on Surfpool (Surfpool startup + deploy not counted; assumed pre-flight).

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-06

Starting phase. Lite prime + manifest loaded.

**Skills loaded:** git, solana-dev, aero-api (read directly via Read tool, not Skill tool).
**Skill references read:** compatibility-matrix.md, common-errors.md, security.md, testing.md, surfpool/{overview,cheatcodes}.md, kit/{overview,advanced}.md, idl-codegen.md.
**Project files read:** spec/architecture.md (full), spec/dev_steps.md, spec/workflow.md, MEMORY.md (auto), executor/src/core/{aeroapi_client,types,flight_data_fetcher,flight_classifier,settlement_executor,solana_client}.ts, executor/src/scripts/{run-fetcher,run-classifier,run-settler}.ts, executor/src/backends/cron/index.ts, executor/tests/aeroapi_client.test.ts (style match), contracts/tests/integration/full-flow-deployed.test.ts (skip + bootstrap pattern), scripts/{deploy,fund-sol,bootstrap-test-actors}.ts, package.jsons.
**Docs:** surfpool / anza-xyz-kit fetched on demand only when needed during implementation (not eagerly).

Verified the exports the test will need are already in place (per Phase 10 D-Phase10-8 export decisions):
- `actionToIxs`, `decideFetcherActions`, `runFetcherOnce` from run-fetcher.ts ✓
- `buildClassifyBatchIx`, `runClassifierOnce` from run-classifier.ts ✓
- `buildSettleBatchIxs`, `currentDay`, `runSettlerOnce` from run-settler.ts ✓

No runner-script edits needed.

**Subtask A — AeroAPI 4xx envelope decode (DONE).**
Extended `executor/src/core/aeroapi_client.ts` to parse the `{title, reason,
detail, status}` envelope on 4xx responses and emit a structured `[aero] 4xx
envelope: ...` log. 5xx + network + JSON-parse failures retain the generic
`[aero] HTTP N` log. Added a `logger` injection point so tests capture logs
without monkey-patching console. New `parseAeroApiError(raw)` shape-check
helper exported. `AeroApiError` type added to `types.ts` and re-exported from
`aeroapi_client.ts` + the mock fixture. **19 new unit tests** in
`executor/tests/aeroapi_error_envelope.test.ts` covering: well-formed envelope
on 400/401/403/404/429, malformed bodies (partial fields, wrong-type status,
non-JSON, null), 5xx skip-decode, network exception, 2xx JSON parse failure,
2xx missing `flights` field, plus 5 helper-isolation tests.
**Total executor unit tests: 58 → 77.**

**Subtask B — Mock AeroAPI fixture (DONE).**
`executor/src/test/mock_aero_api.ts` — `createMockAeroApi(opts?)` returns a
`MockAeroApi` (extends `AeroApiClient`) with state-mutation API: `seed`,
`mutate`, `seedError`, `clear`, `peek`. Internal `Map<"{ident}|{dateIso}",
Entry>`. On `seedError`-marked keys, the mock emits the SAME structured log
shape as the real client (`[aero] 4xx envelope: status=N title="..." ...`) so
scenario 8 can assert wiring end-to-end.

**Subtask C + D — Test harness + 8 scenarios (DONE).**
`contracts/tests/integration/e2e-with-crons-deployed.test.ts` (~1130 LOC).
Skip-if-not-ready pattern (mirrors `full-flow-deployed.test.ts`); loads
`deployments/surfpool-latest.json`; per-suite `runId = randomBytes(3).hex` so
flight idents are `E{runId}{i}` and don't collide across runs. Two
`SolanaClient`s — oracle (signs fetcher ixs) and keeper (signs classifier +
settler) — built from `deployment.keypairPaths.{oracle,keeper}`. Funding +
mint + ATA setup in `beforeAll`; investor A pre-deposits 1k USDC so all
buys have backing capital. Each scenario is its own `it()` block; helpers
`fetcherTick / classifierTick / settlerTick` wrap the real cron core
functions.

**Diagnostic logging on tx failure** — `sendIxs` runs `simulateTransaction`
on send failure and dumps program logs. Kept for future maintainers; only
fires on the unhappy path.

**Subtask E — Docs + scripts (DONE).**
Added `pnpm test:e2e:crons` to root + contracts `package.json`. README
"Running the e2e cron suite (Phase 11)" section with prereqs, the 8-scenario
table, and ordering notes.

### Final test run (2026-05-06, fresh Surfpool deploy)

```
✓ S1: on-time landing                                3.07s
✓ S2: delayed beyond threshold                       4.01s
✓ S3: cancelled before ETA-seed (atomic 2-ix path)   3.18s
✓ S4: cancelled after ETA-seed (single-ix path)      3.00s
✓ S6: queued withdrawal drains during settlement     5.70s
✓ S7: misleading status="Cancelled" ignored          1.55s
✓ S8: 4xx envelope path                              1.62s
✓ S5: 3 flights settle in 2 settler-tick batches     9.23s

Test Files  1 passed (1)
     Tests  8 passed (8)
   Duration 38.75s
```

Plus executor unit tests: 77/77 passing standalone (`pnpm --filter
@sentinel/executor test`, ~320ms). Workspace typecheck clean across all 3
packages. **Gate met. Ready for `/complete-phase 11`.**

---

## Files Created / Modified

> Populated by the agent during work.

### New
- `executor/src/test/mock_aero_api.ts` (~140 LOC) — parameterized mock AeroAPI fixture (seed / mutate / seedError / clear / peek)
- `executor/tests/aeroapi_error_envelope.test.ts` (~225 LOC) — 19 unit tests for the envelope decode + helper
- `contracts/tests/integration/e2e-with-crons-deployed.test.ts` (~1130 LOC) — 8 scenarios driving real cron functions on live Surfpool

### Modified
- `executor/src/core/aeroapi_client.ts` — added 4xx envelope decode, structured logging, `logger` injection point, `parseAeroApiError` helper
- `executor/src/core/types.ts` — added `AeroApiError` interface
- `package.json` (root) — added `test:e2e:crons` script
- `contracts/package.json` — added `test:e2e:crons` script
- `README.md` — added "Running the e2e cron suite (Phase 11)" section
- `spec/progress.md` — Phase 11 row flips to `in_progress`

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

- **D-Phase11-1: Logger injection over console monkey-patching.** The real
  AeroAPI client + the mock both accept an optional `logger: (msg: string)
  => void` parameter that defaults to `console.error`. Tests build a
  `captureLogs()` helper that returns `{logs: string[], fn: ...}` and pass
  `fn` as the logger. Cleanest test surface — no global side effects, no
  vitest-spy machinery, line shape is asserted via plain string matching.
- **D-Phase11-2: Mock and real client share the envelope log shape verbatim.**
  When `seedError`-marked, the mock emits the EXACT same `[aero] 4xx
  envelope: status=N title="..." reason="..." detail="..."` string as the
  real client. Scenario 8 greps for this string after one mock + one real-
  client iteration; if either drifts, the assertion catches it. The shape
  is a single template literal in both files — keep them in sync if the
  format evolves.
- **D-Phase11-3: Two SolanaClients in the test (oracle + keeper).**
  `deployment.keypairPaths` has separate `oracle` and `keeper` entries per
  Phase 7 — single key serving both roles is NOT the surfpool default. The
  test mirrors the daemon's authority isolation (Phase 4 D2): fetcher signs
  with the oracle client, classifier + settler with the keeper client.
- **D-Phase11-4: Scenario ordering — S5 (multi-flight) runs LAST.** The
  controller's `BuyInsurance` reallocs `ActiveFlightList` to
  `space_for(flights.len() + 1)` on every buy. Anchor v1 realloc fails
  with `Sum of account balances before and after instruction do not
  match` (runtime error 4615011) when target_size < current_alloc — the
  shrink path. After S5 settles 3 flights, `len` drops to 0 but the
  underlying account allocation stays at `space_for(3)`; the next single-
  flight buy would target `space_for(1)` and fail. **Workaround per the
  no-contract-changes constraint:** declare S5 as the last `it()` block
  so all preceding scenarios stay at constant peak (alloc never has to
  shrink). Phase 6 D-Phase6-2 already flagged this for a future
  compaction ix; the contract fix is out of scope here.
- **D-Phase11-5: Diagnostic simulate-on-failure in `sendIxs`.** When a
  `sendTransaction` rejects, `sendIxs` runs `simulateTransaction` on the
  same wire bytes and dumps program logs to stderr before re-throwing.
  Adds zero overhead on the happy path; saved hours during scenarios 6/7/8
  debugging when the runtime error code (4615011) was opaque without the
  inner CPI logs. Kept in the test for future maintainers.
- **D-Phase11-6: Append-to-existing-deployment isolation (locked in
  Pre-work Notes).** Each suite run uses `runId = randomBytes(3).hex`, so
  flight idents are unique across runs. Vault, governance, and route
  state persist between runs but never collide because every
  `(flightId, date)` pair is fresh. Empirically robust across 3+
  re-runs on the same deployment artifact.
- **D-Phase11-7: 19 unit tests for envelope decode (≥ 6 required).** The
  spec asked for ≥ 6; we ship 19 because `it.each([401,403,404,429])` is
  a one-line cost and the guarantee is more valuable than the surface
  reduction. Total executor unit count: 58 → 77 (cleared the 64+ gate).

---

## Completion Summary

**Phase 11 closed 2026-05-06.** End-to-end cron validation against a live
Surfpool ships as a single integration test file driving 8 parameterized
scenarios through the **real cron core functions** (`runFetcherOnce` /
`runClassifierOnce` / `runSettlerOnce`) with a parameterized mock AeroAPI.
Money flow asserted across vault, flight_pool, oracle_aggregator,
controller — the highest-fidelity test in the project short of a browser
e2e.

**What was built**
- AeroAPI client now decodes the 4xx error envelope `{title, reason, detail,
  status}` and emits a structured `[aero] 4xx envelope: ...` log; falls
  through to `[aero] HTTP N` for 5xx + non-JSON + malformed bodies. New
  `logger` injection point on the client + a shape-checking helper
  `parseAeroApiError(raw)`.
- `executor/src/test/mock_aero_api.ts` — `createMockAeroApi()` with
  `seed / mutate / seedError / clear / peek` API. Lives under `src/test/`
  so both workspaces can import it.
- `contracts/tests/integration/e2e-with-crons-deployed.test.ts` — 8
  scenarios + skip-if-not-ready pattern + diagnostic simulate-on-failure
  in `sendIxs`. Two `SolanaClient`s (oracle + keeper) mirror the daemon's
  authority isolation.
- 19 new envelope-decode unit tests + the integration suite.

**Key decisions** (full text in §Decisions Made)
- D-Phase11-1: logger injection over console monkey-patching.
- D-Phase11-2: mock + real client share envelope log shape verbatim.
- D-Phase11-3: two SolanaClients (oracle + keeper) per Phase 4 D2 isolation.
- D-Phase11-4: scenario S5 declared LAST to dodge Anchor v1's
  shrinking-realloc bug on `ActiveFlightList`. Phase 6 D-Phase6-2 already
  flagged this for a future compaction ix; we work around it by ordering
  rather than changing contracts.
- D-Phase11-5: simulate-on-failure diagnostic in `sendIxs` — kept for
  future maintainers; zero overhead on the happy path.
- D-Phase11-7: 19 tests where the spec asked for ≥6 — one-line
  `it.each([401,403,404,429])` was a free win.

**Final test run** (fresh Surfpool deploy, 2026-05-06)
```
✓ 8/8 e2e scenarios in 38.75s
✓ 77/77 executor unit tests in 320ms (was 58 — added 19 envelope tests)
✓ Workspace typecheck clean across contracts/executor/frontend
```

**Files**: see §Files Created / Modified.

**Next phase awareness — for Phase 12 (Frontend Bootstrap)**
- The deployed surfpool artifact at `deployments/surfpool-latest.json` is
  the source of truth for program IDs + PDAs that the frontend will
  consume.
- `executor/src/test/mock_aero_api.ts` can be repurposed as a mock for
  any future frontend test that needs a deterministic flight-data feed.
- The cron daemon (`pnpm cron-daemon`) is still the way to drive flight
  data for browser-driven testing — start it alongside `pnpm dev:frontend`
  for live UX validation.

**Known limitations / deferred items**
- **No surfnet time-travel.** Cross-day snapshot validation (multiple
  `SnapshotRecord` PDAs across consecutive days) is deferred to Phase 16
  browser e2e where `surfnet_setTime` cheatcode use is more natural.
- **No `ActiveFlightList` compaction ix.** Phase 6 D-Phase6-2 already
  flagged; Phase 11 work-around is "run multi-flight scenarios last".
  Production deployments will need a periodic compaction call once any
  long-tail backlog accumulates — file as a follow-up on the next
  on-chain phase.
- **Surfpool startup + deploy not part of the CI loop.** Phase 11 is
  operator-driven (skip-if-not-ready). Phase 16 will own the orchestration
  for nightly CI runs.

### Session 2026-05-06 — Completed
Phase validated by user. All gate conditions met. 18/18 subtasks complete.
