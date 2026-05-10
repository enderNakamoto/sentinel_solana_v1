# Phase 23 — Route Repricer Cron (TS + Grok)

Status: in_progress
Started: 2026-05-10
Completed: —

---

## Goal

Add a 4th cron — `RouteRepricer` — that iterates every whitelisted
`RouteAccount` on devnet, calls the Phase 22 agent for a baseline premium,
asks Grok (xAI Live Search) whether geopolitical news justifies a multiplier
or full disable, and submits the resulting `update_route_terms` /
`disable_route` (or idempotent `whitelist_route` re-enable) tx signed by the
deployer. Surfaces on `/crons` as a 4th card with the same trigger / mutex /
activity-feed posture as the existing three crons.

The cron is **trigger-on-demand only** in this phase (matches Phase 17/18
posture). Daily auto-cadence is deferred — the deploy box has no scheduler
today and adding `node-cron` is a separate concern.

## Dependencies

- **Phase 22** (`agent/` FastAPI service) — the cron HTTP-calls
  `POST ${AGENT_BASE_URL}/price` per route. The Phase 22 endpoint contract
  (`PriceRequest`/`PriceResponse`) is the API boundary.
- **Phase 1** (`governance_program`) — already provides `whitelist_route`
  (idempotent re-activate), `update_route_terms` (tri-state `U64Update::Set`
  for premium), `disable_route` (flips `approved=false`). No on-chain
  changes needed; verified in the planning conversation.
- **Phase 7** (devnet deployment) — the deployer keypair
  `keys/devnet-deployer.json` already holds owner authority on
  `GovernanceConfig`, so it can sign every governance ix this cron emits.
- **Phase 17** (cron control panel) — JSONL persistence
  (`frontend/src/lib/cron-runs.ts`), per-cron mutex pattern, captured-
  console sink, cluster-aware keypair loader
  (`frontend/src/lib/cron-keypair.ts`). Phase 23 is a strict additive
  extension — same patterns, new `'repricer'` bucket.
- **Phase 18** (fetcher cron) — the closest template. Mock-mode env-flag
  pattern, config endpoint (`GET /api/cron/fetcher/config`), per-request
  mode override (`?mode=mock|live`) all mirrored exactly.
- Codama-generated `governance` clients in
  `executor/src/clients/governance/` and `frontend/src/clients/governance/`
  (verify before relying on `getUpdateRouteTermsInstructionAsync`,
  `getDisableRouteInstructionAsync`, `getWhitelistRouteInstructionAsync`,
  `RouteAccount` Borsh decoder, `findRoutePda` exports).

## Context Manifest

### Skills
- `solana-dev`
- `git`

### Skill References
- `references/compatibility-matrix.md`
- `references/common-errors.md`
- `references/security.md`
- `references/frontend-framework-kit.md`
- `references/kit/overview.md`
- `references/kit/plugins.md`
- `references/idl-codegen.md`
- `references/programs/anchor.md`

### Docs to Fetch
- https://docs.x.ai/docs/api-reference#chat-completions — xAI Chat
  Completions API surface (the only Grok integration this phase needs).
- https://docs.x.ai/docs/guides/live-search — Live Search parameters
  (`search_parameters: { mode: "on", sources: [{ type: "news" }] }`).
- https://docs.x.ai/docs/guides/structured-outputs —
  `response_format: { type: "json_schema", ... }` for the structured Grok
  verdict.
- https://nextjs.org/docs/app/api-reference/file-conventions/route —
  Next.js Route Handler reference (the new repricer route's shape).
- https://github.com/anza-xyz/kit — Kit `getProgramAccounts` + memcmp
  filter patterns.

### Project Files to Read
- `spec/architecture.md` — full file (off-chain executor §; will be edited
  in this phase).
- `spec/dev_steps.md` — Phase 23 entry (this phase's deliverables +
  done-when).
- `spec/workflow.md` — phase lifecycle.
- `MEMORY.md` — locked decisions (esp. governance idempotent re-activate,
  the Phase 17/18 cron pattern).
- `spec/phases/phase-17-cron-control-panel.md` — original template (mutex,
  JSONL, captured-console, route-handler shape).
- `spec/phases/phase-18-fetcher-oracle-centralized.md` — the closest
  sibling phase (mock-mode, config endpoint, mode override).
- `spec/phases/phase-22-premium-pricing-agent.md` — Phase 22's endpoint
  contract (the boundary this cron HTTP-calls).
- `contracts/programs/governance/src/lib.rs` — `whitelist_route`
  (idempotent), `update_route_terms` (tri-state), `disable_route`
  (`approved=false`), `RouteAccount` layout.
- `frontend/app/api/cron/[id]/trigger/route.ts` — Phase 17/18's combined
  route handler; reference shape only (Phase 23 ships a sibling at
  `frontend/app/api/cron/repricer/trigger/route.ts`).
- `frontend/app/api/cron/runs/route.ts` — runs list endpoint; add
  `repricer` to the valid `?cron=` filter.
- `frontend/src/lib/cron-runs.ts` — `CronId` type union to extend
  (`+ 'repricer'`); rotation cap (100) per-cron applies.
- `frontend/src/lib/cron-keypair.ts` — already loads the deployer; reused
  as-is.
- `frontend/app/crons/page.tsx` — UI; new repricer card matches fetcher's
  layout 1:1.
- `executor/src/clients/governance/src/generated/` — Codama-generated
  governance instructions + decoders.
- `executor/src/core/solana_client.ts` — `createSolanaClient` factory the
  new core reuses.
- `deployments/devnet-latest.json` — canonical addresses; `governance`
  program ID + `GovernanceConfig` PDA.
- `package.json` — root scripts table.

## Pre-work Notes

> Locked decisions from the planning conversation. Treat as hard
> requirements during implementation.

- **Sibling route, not extension.** Add
  `frontend/app/api/cron/repricer/trigger/route.ts` as a new file rather
  than extending `[id]/trigger/route.ts`. Three reasons: (a) the
  repricer's per-route iteration shape is materially different from the
  per-flight fetcher/classifier/settler shape; (b) the deps (agent HTTP
  + Grok HTTP) are unique to this cron; (c) it's easier to feature-flag
  and roll back. The runs-list endpoint stays shared.
- **Premium formula and clamp live in the cron, not the agent.** The
  agent returns `p_delay` + a baseline `premium_usdc` ∈ [$1, $5]; the
  cron is responsible for applying the Grok multiplier and re-clamping.
  This keeps the agent stateless and the policy in TS where the on-chain
  ix builders live.
- **Drift threshold:** skip an `update_route_terms` tx if
  `|new_premium_base_units − current_premium_base_units| < 100_000`
  (10¢). Saves SOL and JSONL noise. Decision is made in
  `decideRouteAction`, not in the route handler.
- **Re-enable gate (D23-1).** Grok flipping `disabled → ok` only
  re-enables routes whose `RouteAccount.approved == false` AND that were
  disabled by **this cron**. Tracking: each JSONL record with action
  `disable` writes the route PDA into a `disabledByRepricer: string[]`
  field; the next run reads recent JSONL records to decide eligibility.
  Manual `/admin` re-enable remains the alternate path.
- **Action shape (closed set):**
  ```
  noop                     — within drift threshold OR Grok says ok and current matches baseline
  update_premium(new_bps)  — Grok multiplier × baseline, re-clamped to [$1, $5]
  disable                  — Grok action == "disable"
  reenable_with_terms(...) — Grok action == "ok" AND route currently disabled AND in disabledByRepricer
  ```
- **Grok schema is fixed:**
  ```json
  {
    "action": "ok" | "raise" | "disable",
    "multiplier": number,        // 1.0–3.0, only when action == "raise"
    "reason": string             // ≤200 chars, shown in the activity feed
  }
  ```
  Defaults: `{ action: "ok", multiplier: 1.0, reason: "grok unavailable; baseline only" }`
  if Grok 5xx's, times out, or returns invalid JSON. Failure NEVER blocks
  the cron — Phase 18's fetcher posture.
- **Mock-mode env flags** (parity with Phase 18):
  ```
  GROK_MOCK=1                              — bypass xAI; use scenario fixture
  GROK_MOCK_VERDICT=ok|raise:1.5|disable   — pinned response
  AGENT_MOCK=1                             — bypass Phase 22; use fixed premium
  AGENT_MOCK_PREMIUM_USDC=2.5              — fixture for every route
  ```
  Default scenario when `GROK_MOCK=1` and no verdict is set: `ok`
  (multiplier 1.0, reason "mock baseline").
- **Per-request mode override** at
  `POST /api/cron/repricer/trigger?mode=mock|live` mirrors the fetcher's
  pattern. Live mode requires `XAI_API_KEY` and a reachable
  `AGENT_BASE_URL`; route returns 400 if neither env path is satisfied
  (and `mode` doesn't override).
- **Agent reachability is pre-flighted.** A `GET ${AGENT_BASE_URL}/healthz`
  runs before the per-route loop; if it fails, return a clean 503 with a
  helpful message rather than per-route timeouts.
- **Public-unauth trigger surface — same posture as Phases 17 + 18.**
  Document the `X-CRON-TOKEN` shared-secret hardening as the mainnet
  follow-up.
- **Per-cron mutex extends to repricer.** Concurrent button-mash returns
  409. JSONL log file unchanged — same rotation cap (100), now applied
  per-cron across all four buckets (`classifier`, `settler`, `fetcher`,
  `repricer`).
- **`REPRICER_DRY_RUN=1`** returns the planned actions in the response
  without sending any tx. Useful for the demo so we can show the verdict
  without committing it. Records a green run with `dryRun: true` in the
  JSONL line; activity feed shows a 💭 indicator.
- **No new program changes.** Every action routes through existing
  governance ixs verified in the planning conversation:
  - `update_premium(new_bps)` →
    `update_route_terms(premium=Set(new_bps), payoff=Keep, delay_hours=Keep)`
  - `disable` → `disable_route(flight_id, origin, destination)`
  - `reenable_with_terms(new_bps)` →
    `whitelist_route(flight_id, origin, destination,
    premium=Some(new_bps), payoff=None, delay_hours=None)` (idempotent
    re-activate per phase-01 D4).
- **Devnet only.** Surfpool repricer support is a follow-up (the local
  mock-USDC + governance state isn't initialised consistently with
  devnet, and Grok Live Search needs real internet anyway).
- **Carrier inference.** `RouteAccount.flight_id` is e.g. `AA100`,
  `UA1532`. Parse with regex `^([A-Z0-9]{2})(\d+)$` to extract carrier
  code; pass it to the agent. If the regex fails, log a warning and skip
  the route (do not synthesise).
- **Daily auto-cadence intentionally deferred.** Trigger-on-demand from
  `/crons` is sufficient for the demo. A node-cron schedule is a
  follow-up; do NOT add it this phase.

---

## Subtasks

### A. Executor core

- [x] A1. `executor/src/core/agent_client.ts` shipped — `createAgentClient`
      (live) + `createMockAgentClient` (fixture). 5s `AbortController`
      timeout, no retries, fail-up on non-2xx. `healthz()` probe used
      by the route handler's pre-flight check returns `{ok, modelVersion, error?}`.
- [x] A2. `executor/src/core/grok_client.ts` shipped — `createGrokClient`
      (xAI Chat Completions w/ Live Search + `response_format:
      json_schema`), `createMockGrokClient` (env-fixture), `coerceVerdict`
      schema validator, `parseMockVerdict` for `ok|raise:<m>|disable`
      env spec. Failure path is bulletproof — every error returns
      `GROK_SAFE_DEFAULT` so the cron never blocks.
- [x] A3. `executor/src/core/decide_route_actions.ts` shipped — pure
      module, no I/O. 4-action closed set with drift threshold
      (`100_000` base units = 10¢) and the re-enable gate D23-1.
      `clampPremiumBaseUnits` helper handles the $1–$5 clamp + rounding.
- [x] A4. `executor/src/core/route_repricer.ts` shipped — `runRepricerOnce`
      orchestrator. Hand-rolled base58 encoder for the discriminator
      memcmp filter (avoids importing `@solana/kit`'s codec chain into
      this hot-path). Hand-rolled `decodeRouteAccount` Borsh decoder
      keeps the module Codama-import-free for test hygiene.
      `parseCarrierFromFlightId` regex `^([A-Z0-9]{2})(\d+)$` extracts
      the carrier; mismatches log + skip. `buildAgentRequest` derives
      month/day_of_month/day_of_week from `now: Date` (UTC), with
      hardcoded `dep_time_hhmm=1200` + `distance_mi=1000` fallbacks per
      Pre-work Notes (per-route distance is a follow-up).
- [x] A5. `executor/tests/decide_route_actions.test.ts` — **17 unit
      tests** covering all 4 action variants, drift-threshold edge,
      re-enable gate (only routes disabled by THIS cron), the
      $5 ceiling clamp, the $1 floor clamp, rounding determinism, and
      the constants invariants for documentation.
- [x] A6. `executor/tests/grok_client.test.ts` — **20 unit tests**
      covering `parseMockVerdict` (default → ok, raise:N variants,
      disable, unknown spec), `createMockGrokClient` (deterministic per
      route), `coerceVerdict` (rejects non-objects, unknown actions,
      clamps multiplier to [1.0, 3.0], forces multiplier=1.0 for non-
      raise actions, truncates reason to 200 chars), and `createGrokClient`
      live-mode (well-formed response, 5xx → safe default, non-JSON
      content → safe default, fetch throws → safe default).

### B. Frontend route + config endpoint

- [x] B1. `frontend/src/lib/cron-runs.ts` extended — `CronId` union now
      includes `'repricer'`; `keptByCron` covers all 4 buckets;
      merged-and-sorted rewrite includes the new bucket. New optional
      fields on `CronRunRecord`: `decisions: RepricerDecision[]?`,
      `histogram?`, `newlyDisabledPdas?`, `dryRun?`. New helper
      `readDisabledByRepricer(maxRecords=50)` walks recent JSONL entries
      and returns the union of all `newlyDisabledPdas` for the
      re-enable gate.
- [x] B2. `frontend/app/api/cron/runs/route.ts` accepts `?cron=repricer`.
- [x] B3. `frontend/app/api/cron/repricer/config/route.ts` shipped —
      `GET` returns `{ liveAvailable, agentReachable, agentBaseUrl,
      defaultMode, defaultGrokVerdict, grokMockVerdicts }`. The agent
      reachability probe uses `fetch + AbortController` with a 1s
      timeout; never throws. Default mode picks `mock` when either env
      mock-flag is on, `live` when both `XAI_API_KEY` and
      `AGENT_BASE_URL` are set, `mock` otherwise.
- [x] B4. `frontend/app/api/cron/repricer/trigger/route.ts` shipped —
      sibling route to `[id]/trigger`. Mirrors Phase 17/18 patterns:
       - Parses `?mode` (mock|live) + `?dryRun` (also reads
         `REPRICER_DRY_RUN` env).
       - Pre-flight 400 if neither live nor mock path resolves;
         per-config (Grok and Agent) so misconfig messages are precise.
       - Pre-flight 503 in live agent mode if `AGENT_BASE_URL/healthz`
         is unreachable.
       - Per-cron mutex (`RUNNING.repricer`); 409 on concurrent
         button-mash.
       - Inline `routeActionToIxs` translator follows Phase 17/18's
         precedent. Passes `adminRecord = GOVERNANCE_PROGRAM_ADDRESS`
         (the absent sentinel from Phase 1 D-Phase1) since the deployer
         is governance owner — owner-check passes first, admin-record
         is skipped.
       - JSONL record carries `decisions`, `histogram`,
         `newlyDisabledPdas`, `dryRun`, plus the standard
         `summary/signatures/logs`. Activity feed uses these directly.
- [x] B5. `RUNNING.repricer` initialised to `false` in the new file.
      Also added to `[id]/trigger/route.ts`'s `RUNNING` map (typed
      `Record<CronId, boolean>` requires the new variant) — the slot is
      unused by the [id] handler but satisfies the type.

### C. Frontend UI

- [x] C1. `frontend/app/crons/page.tsx` extended — 4th `CronCard`
      ("Route Repricer", on-demand cadence, signer = `governance_owner`
      = deployer) matching fetcher's layout 1:1. Description includes
      the agent + Grok dependency call-out so operators know what's
      under the hood.
- [x] C2. New `RepricerControls` component shipped alongside
      `FetcherControls` — Live/Mock toggle, mock-verdict dropdown
      (`ok | raise:1.5 | raise:2.0 | disable`), 💭 dry-run checkbox.
      Live button disabled when `liveAvailable=false` (no XAI_API_KEY).
      "Agent down" indicator when XAI key is set but agent is
      unreachable. Toggle/dryRun state reflected in trigger URL
      `?mode=mock|live&dryRun=1`.
- [x] C3. `RunRow` extended — when `record.cron === 'repricer'` and
      `record.decisions.length > 0`, the expanded view renders a
      colour-coded per-route decision list (red=disable / cyan=update
      / green=reenable / muted=noop). Each row shows
      `flightId · origin→dest · baseline $X.XX · grok action · on-chain
      action · tx-link?` with the Grok reason on a second line.
      Summary line gets a 💭 prefix when `record.dryRun === true`.
      Histogram is already in `record.summary` text from the route
      handler — no separate UI needed.
- [x] C4. `runsByCron` + `failedCount` cover all 4 crons via the
      `as const` tuple `['classifier', 'settler', 'fetcher',
      'repricer']`.

### D. Documentation + workflow

- [x] D1. README §"Cron control panel (Phases 17 + 18 + 23)" rewritten
      — 4-cron list, 5-row API routes table including the new
      `repricer/trigger` and `repricer/config` routes, RouteRepricer
      env-var table (`AGENT_BASE_URL`, `XAI_API_KEY`, `GROK_MOCK`,
      `GROK_MOCK_VERDICT`, `AGENT_MOCK`, `AGENT_MOCK_PREMIUM_USDC`,
      `REPRICER_DRY_RUN`), per-request override curl examples, agent
      reachability + Grok safe-default semantics called out.
- [x] D2. `spec/architecture.md` updated in two places: the System
      Overview cron-summary table (3→4 rows; new RouteRepricer row
      with `governance_owner` authorization) and the §Off-Chain
      Executor Layer table + a new "Cron #4 trust assumption" callout
      explaining the Phase 22 + xAI dependency and the re-enable gate.
- [x] D3. `spec/dev_steps.md` — Phase 23 row flipped from `planned` to
      `in_progress` (lite prime, this session).
- [x] D4. `spec/progress.md` — row 23 → `in_progress`; Active phase
      pointer updated.

### Gate

- `pnpm -r typecheck` passes across all 3 TS workspaces (executor /
  frontend / contracts).
- All `decide_route_actions.test.ts` + `grok_client.test.ts` unit tests
  pass.
- Trigger from `/crons` repricer card on devnet **in mock mode** (both
  `GROK_MOCK=1` and `AGENT_MOCK=1`) walks at least 3 whitelisted routes,
  emits per-route decision logs, applies the resulting txs, and reports
  green.
- Trigger with `XAI_API_KEY` set and `AGENT_BASE_URL` reachable hits real
  Grok + real agent for at least 1 route, surfaces a non-empty `reason`
  field in the record.
- One route exercised through each of the three actions (`update_premium`,
  `disable`, `reenable_with_terms`) — verifiable in `/admin` after the
  run.
- `REPRICER_DRY_RUN=1` returns the planned actions without sending any
  tx; activity feed shows the 💭 indicator.
- Concurrent button-mash returns 409.
- The repricer run record persists across a page reload (proves JSONL
  rotation includes the new bucket).

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-10

Starting phase. Lite prime complete. Context manifest loaded.

- **Skills loaded:** `solana-dev` (SKILL.md, references/security.md from Phase 22 cache — fresh same-session). `git`. Other refs (compatibility-matrix, common-errors, framework-kit, kit/overview/plugins, idl-codegen, programs/anchor) skipped on the same rationale as Phase 22 — TS+Kit stack is in-vocab; will load on demand.
- **Project files read:** spec/phases/phase-23 (full), frontend/src/lib/cron-runs.ts (CronId union to extend), frontend/src/lib/cron-keypair.ts (deployer loader, reused as-is), frontend/app/api/cron/[id]/trigger/route.ts (template — captureConsole, conciseError, RUNNING mutex, action→ix translator pattern), frontend/app/api/cron/runs/route.ts (filter expansion target), frontend/app/api/cron/fetcher/config/route.ts (config endpoint pattern), executor/src/core/solana_client.ts (createSolanaClient + sendIxs interface), executor/src/clients/governance/src/generated/instructions/{updateRouteTerms,disableRoute}.ts (signatures + optional adminRecord PDA derivation), executor/src/clients/governance/src/generated/types/u64Update.ts (`{__kind: "Set", fields: [bigint]}` shape), executor/src/clients/governance/src/generated/accounts/routeAccount.ts (8-byte discriminator + Borsh decoder), package.json + agent/.env (XAI_API_KEY + AGENT_BASE_URL already wired).
- **Docs to fetch (skipped):** xAI chat-completions / live-search / structured-outputs, Next.js Route Handler, Kit getProgramAccounts. Skipped — same posture as Phase 22; will fetch live-search docs if the structured-output payload diverges from openai-style during implementation.
- **Pre-condition check:** RouteAccount discriminator confirmed at `[135, 89, 73, 184, 33, 21, 243, 86]`. Governance program ID stable from MEMORY: `6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT`. Deployer keypair already used by Phase 17/18 cron triggers and is also the governance owner — same key signs every action this cron emits.
- Phase status flipped: `planned` → `in_progress`. Started 2026-05-10.

Beginning Bucket A.

**Bucket A — Executor core (DONE).**
- 4 new modules under `executor/src/core/`: `agent_client.ts`,
  `grok_client.ts`, `decide_route_actions.ts`, `route_repricer.ts`.
- 2 new test files: `decide_route_actions.test.ts` (17 cases),
  `grok_client.test.ts` (20 cases). All pass.
- Hand-rolled base58 encoder + Borsh decoder for the RouteAccount
  blob keep this module Codama-import-free for clean test
  boundaries.
- Re-export `RouteAction` from `route_repricer.ts` for the route
  handler's import.
- One TS error fixed during integration: Kit's `getProgramAccounts`
  return type can be `{context, value}` or unwrapped array — cast
  to the unwrapped form (the runtime shape when `withContext` is
  omitted).
- **All executor tests: 114/114 pass** (was 77 before this phase;
  37 new repricer-related cases added).

**Bucket B — Frontend route + config endpoint (DONE).**
- `frontend/src/lib/cron-runs.ts` extended with `'repricer'` in
  `CronId`, repricer-specific optional fields on `CronRunRecord`,
  4-bucket rotation logic, new `readDisabledByRepricer` helper for
  the re-enable gate.
- New `frontend/app/api/cron/repricer/config/route.ts` — GET,
  agent reachability probe with 1s timeout.
- New `frontend/app/api/cron/repricer/trigger/route.ts` — POST,
  full mutex + env validation + console capture + JSONL append.
  Inline `routeActionToIxs` translator with the
  `adminRecord = GOVERNANCE_PROGRAM_ADDRESS` absent-sentinel pattern.
- `frontend/app/api/cron/[id]/trigger/route.ts` `RUNNING` map
  extended to satisfy the typed `Record<CronId, boolean>`.
- 3 TS errors fixed during integration: missing `repricer`
  property in RUNNING (added with comment), missing `RouteAction`
  re-export (re-exported from route_repricer), exhaustive switch
  not narrowing (added trailing `return []`).

**Bucket C — Frontend UI (DONE).**
- `frontend/app/crons/page.tsx` mods (~ 250 lines added):
  - `CronId` extended; `CronRunRecord` gets repricer fields.
  - 4th entry in `CRON_META`.
  - 4 new state hooks (`repricerCfg`, `repricerMode`,
    `repricerVerdict`, `repricerDryRun`).
  - New useEffect fetches `/api/cron/repricer/config` on mount.
  - `runsByCron` + `failedCount` cover 4 crons.
  - `trigger` builds the right URL + query params for each cron
    (sibling `/api/cron/repricer/trigger` for repricer, `[id]/trigger`
    for the others).
  - `CardProps` gains 7 repricer-specific fields; `CronCard` body
    renders `RepricerControls` for repricer cards.
  - New `RepricerControls` component (~ 180 lines) — Live/Mock
    toggle, verdict dropdown, dry-run checkbox, agent reachability
    indicator.
  - `RunRow` renders per-route decisions list for repricer rows
    when expanded (color-coded by action kind, Grok reason on
    second line, tx signature link). 💭 prefix on summary line
    when `dryRun === true`.

**Bucket D — Documentation (DONE).**
- README §Cron control panel rewritten for 4 crons + RouteRepricer
  env-var table + curl examples.
- `spec/architecture.md` System Overview + Off-Chain Executor
  Layer tables both updated to 4 crons; new "Cron #4 trust
  assumption" callout.
- `spec/dev_steps.md` + `spec/progress.md` row 23 → `in_progress`
  (done at lite prime).

**Final verification:**
- `pnpm -r typecheck` clean across all 3 TS workspaces (contracts /
  executor / frontend).
- `pnpm test` (executor): 7 test files, **114 tests pass** in 408ms.

**Awaiting user validation (gate):**
1. Start the agent: `make serve` (in another terminal). Should
   serve on `http://localhost:8000`.
2. Start the frontend: `pnpm dev:frontend`. Should serve on
   `http://localhost:3000`.
3. Open `/crons` — verify the 4th "Route Repricer" card appears
   with a Live/Mock toggle (Live should be enabled because
   `XAI_API_KEY` is set in `frontend/.env.local`).
4. Click *Trigger now* with default settings (Mock mode, dry-run
   off). Activity feed should show a green run with the histogram
   `N noop · M update · ...`.
5. Toggle to **Live** mode (XAI quota burn — ~1 query per route).
   Trigger again. Activity feed should show non-empty Grok reasons
   in "View log".
6. With Mock mode + verdict `disable`, trigger to disable some
   routes. Then with verdict `ok` + dry-run off, trigger to
   re-enable (only routes this cron disabled re-enable; others
   noop with "not by this cron" reason).
7. Optional: live-mode end-to-end with the user's $XAI_API_KEY +
   running agent.

All subtasks complete. Gate condition met. Ready for
`/complete-phase 23`.

---

## Decisions Made

> Append-only.
