# Phase 4 — oracle_aggregator_program

Status: complete
Started: 2026-05-04
Completed: 2026-05-04

---

## Goal

Replace the Phase 0 no-op `oracle_aggregator` skeleton with the real flight-data feed:
the only program the `authorized_oracle` keypair can sign for, holding zero funds, and
the canonical owner of `FlightData` accounts. Three authority types govern access —
`owner` (initialize, rotate oracle, set consumer), `authorized_oracle` (FlightDataFetcher
cron — sets estimated/actual arrival, cancellation), and `authorized_consumer` (= the
controller_program's `ControllerConfig` PDA, set once via `set_authorized_consumer`)
which transitions data into the settlement pipeline (`init_flight_data`,
`set_to_be_settled`, `set_settled`). The forward-only state machine
`NotInitiated → Active → {Landed, Cancelled} → ToBeSettled* → Settled` is enforced on
every transition. After this phase, the oracle is a self-contained data feed
unit-tested in isolation; cross-program integration with the controller lands in
Phases 5–6.

## Dependencies

- **Phase 0** — workspace, IDL/Codama pipeline, LiteSVM harness.
- **Phase 1** — `MAX_FLIGHT_ID_LEN = 16` constant, length-validation helper pattern.
- **Phase 3** — Codama payload-less-enum mapping (D16) — `FlightStatus` will follow the
  same shape; tests assert `flightData.status === FlightStatus.Active`. The
  `set_authorized_consumer` once-only flag pattern is the direct analogue of Phase 2/3
  `set_controller`.

No on-chain dependency on `governance`, `vault`, or `flight_pool`. The oracle reads
nothing from them — the controller (Phase 5) is the only program that CPIs into the
oracle.

## Context Manifest

> These are the skills, docs, and files `/start-phase` will load automatically.
> Edit this section if you want the agent to consult additional resources.

### Skills

- `git`
- `solana-dev` (mandatory; auto-loaded by `/start-phase` regardless of manifest)

### Skill References

- `references/compatibility-matrix.md` — toolchain version pinning (universal default)
- `references/common-errors.md` — known error fixes (universal default)
- `references/security.md` — agent guardrails W009/W011, audit checklist (universal default)
- `references/programs/anchor.md` — Anchor v1 patterns: `init` strict-mode for `FlightData`, `has_one` for the three authorities, no `Option<Account>` here so D11 sentinel doesn't apply, no SPL CPIs so no `anchor-spl`
- `references/idl-codegen.md` — Anchor IDL → Codama → Kit-client pipeline
- `references/testing.md` — LiteSVM unit-test patterns, `advanceClock` for any time-based test (none expected here — oracle has no time-driven invariants)
- `references/kit/overview.md` — `@solana/kit` Address / Transaction / signer patterns
- `references/anchor/migrating-v0.32-to-v1.md` — Anchor v1 idioms (single-lifetime `Context`, `let _ = (...)` for `#[instruction(...)]`-bound args)

### Docs to Fetch

- https://www.anchor-lang.com/docs — Anchor v1 program structure
- https://www.anchor-lang.com/docs/references/account-constraints — `#[account(...)]` reference (init, has_one, seeds, bump)
- https://www.anchor-lang.com/docs/references/space — Anchor account-space rules + `#[max_len]` on `String` fields

### Project Files to Read

- `spec/architecture.md` (universal default) — esp. §oracle_aggregator_program (lines 487–605) and §Authorization patterns
- `spec/dev_steps.md` (universal default) — Phase 4 deliverables + tests (lines 336–391)
- `spec/workflow.md` (universal default) — phase lifecycle
- `MEMORY.md` (universal default) — locked Phase 0/1/2/3 decisions; canonical program IDs; Anchor v1 + LiteSVM + Codama patterns to reuse (D16 payload-less enum mapping, D17 reverted-tx signature slot, ID rotation log)
- `spec/phases/phase-03-flight-pool-program.md` — Phase 3 reference for length-cap helper, `set_controller` once-only pattern, Codama payload-less enum tests, strict `init` for one-shot PDAs (D5 D6 D11 D16 D17)
- `spec/phases/phase-01-governance-program.md` — Phase 1 reference for `MAX_FLIGHT_ID_LEN = 16` derivation
- `spec/learn_solana.md` — Soroban-to-Solana sanity check (skim only)
- `contracts/programs/oracle_aggregator/src/lib.rs` — Phase 0 no-op skeleton being replaced
- `contracts/programs/oracle_aggregator/Cargo.toml` — Phase 0 baseline; **DO NOT** add `anchor-spl` (oracle has zero SPL CPIs)
- `contracts/programs/governance/src/lib.rs` — reference for `MAX_FLIGHT_ID_LEN`, `validate_*_lengths` helper style, `has_one = owner` gating
- `contracts/programs/flight_pool/src/lib.rs` — reference for forward-only state-machine guards (Phase 3 D5/D6/D7), `set_controller` once-only, plain-enum `SettlementStatus` Codama mapping (D16)
- `contracts/programs/flight_pool/Cargo.toml` — confirm `anchor-spl` was needed there but is NOT for oracle
- `contracts/tests/setup.ts` — Phase 1/2/3 LiteSVM harness with `bootstrapGovernance`/`bootstrapVault`/`bootstrapFlightPool`. Extend with `bootstrapOracleAggregator`.
- `contracts/tests/flight_pool.test.ts` — reference test pattern: `freshFixture`, `fundedSigner`, `setMockController` lifted into the test file, controller-only revert assertions, plain-enum status assertions (D16), `expireBlockhash` between byte-identical txs (D17)
- `contracts/Anchor.toml` — confirm canonical oracle_aggregator program ID (`EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`)

## Pre-work Notes

> Decisions locked during planning (2026-05-04). The agent must follow these.

### D1 — `MAX_FLIGHT_ID_LEN = 16` (carry over from Phase 1 + Phase 3)

Same constant, same `validate_flight_id` helper. Enforced on `init_flight_data`,
`set_estimated_arrival`, `set_landed`, `set_cancelled`, `set_to_be_settled`,
`set_settled`. The `date: u64` arg is fixed-size; no validation needed.

### D2 — Account types and PDA seeds (matches architecture.md verbatim)

| Account | PDA seeds | Purpose |
|---|---|---|
| `OracleConfig` | `[b"oracle_config"]` | Singleton config: owner, authorized_oracle, authorized_consumer, is_consumer_set, bump. |
| `FlightData` | `[b"flight", flight_id.as_bytes(), &date.to_le_bytes()]` | One per (flight_id, date). Created by `init_flight_data`. **Strict `init`** — re-init reverts via PDA collision (D6). |

`FlightData` fields (matches architecture):
- `flight_id: String` (max 16 bytes per D1)
- `date: u64`
- `status: FlightStatus`
- `estimated_arrival_time: i64` (`0` = not yet set; sentinel collision with LiteSVM clock = 0 is documented but irrelevant in practice — real ETAs are far-future timestamps; tests use sane values)
- `actual_arrival_time: i64` (`0` = not yet set)
- `bump: u8`

### D3 — `FlightStatus` enum (8 forward-only variants)

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum FlightStatus {
    NotInitiated,
    Active,
    Landed,
    Cancelled,
    ToBeSettledOnTime,
    ToBeSettledDelayed,
    ToBeSettledCancelled,
    Settled,
}
```

State machine (forward-only — every reverse transition reverts with `InvalidStateTransition`):

```
NotInitiated → Active → Landed ──► ToBeSettledOnTime ──► Settled
                  │                 ToBeSettledDelayed ──► Settled
                  └──► Cancelled ► ToBeSettledCancelled ► Settled
```

Codama maps this payload-less enum to a plain TS enum with numeric values per Phase 3
D16. Tests assert `flightData.status === FlightStatus.Active`, NOT `__kind`.

### D4 — Three authority types with distinct gating

| Authority | Stored on `OracleConfig` | Gated instructions | Mutability |
|---|---|---|---|
| `owner` | `owner: Pubkey` | `set_authorized_oracle`, `set_authorized_consumer` | Set at `initialize`, NOT rotatable in this phase. (Owner rotation deferred per D13.) |
| `authorized_oracle` | `authorized_oracle: Pubkey` | `set_estimated_arrival`, `set_landed`, `set_cancelled` | **Rotatable** by owner via `set_authorized_oracle`. No `is_oracle_set` flag. |
| `authorized_consumer` | `authorized_consumer: Pubkey`, `is_consumer_set: bool` | `init_flight_data`, `set_to_be_settled`, `set_settled` | **One-shot**: `set_authorized_consumer` reverts when `is_consumer_set == true`. Mirrors Phase 2/3 `set_controller`. |

All three use Anchor `has_one = X @ OracleError::UnauthorizedX` constraints + a `Signer` field for the relevant authority.

### D5 — `set_to_be_settled` strict (current → new) pairing

(User-locked decision: strict pairing.) The instruction reverts unless the current
→ new transition is one of:

| Current `pool.status` | Allowed `new_status` |
|---|---|
| `Landed` | `ToBeSettledOnTime` OR `ToBeSettledDelayed` |
| `Cancelled` | `ToBeSettledCancelled` (only) |

Anything else reverts with `InvalidStateTransition`. Specifically:
- `Landed → ToBeSettledCancelled` reverts (a landed flight can't be classified cancelled).
- `Cancelled → ToBeSettledOnTime|Delayed` reverts (a cancelled flight can't be classified as having flown).
- Current ∉ {Landed, Cancelled} → reverts (covered by the generic forward-only guard too).

This is defense-in-depth on top of `has_one = authorized_consumer`. Even a buggy
controller's `classify_flights` can't corrupt a Landed flight by marking it cancelled.

### D6 — `init_flight_data` strict `init` (matches Phase 3 D5)

Anchor `#[account(init, ...)]`. Re-init for the same `(flight_id, date)` reverts via
`AccountAlreadyInitialized`. The consumer (controller PDA in Phase 5) creates the
`FlightData` PDA on the first `buy_insurance` for a flight. `pub flight_id` and
`pub date` fields are written at init; `status = NotInitiated`,
`estimated_arrival_time = 0`, `actual_arrival_time = 0`, `bump = ctx.bumps.flight_data`.

### D7 — Forward-only state-machine guards on every transition

Each setter checks `require!(self.status == ExpectedCurrent, OracleError::InvalidStateTransition)` at the top:

| Instruction | Expected current | New |
|---|---|---|
| `set_estimated_arrival` | `NotInitiated` | `Active` |
| `set_landed` | `Active` | `Landed` |
| `set_cancelled` | `Active` | `Cancelled` |
| `set_to_be_settled` | `Landed` or `Cancelled` (with strict pairing per D5) | one of `ToBeSettled*` |
| `set_settled` | `ToBeSettledOnTime`, `ToBeSettledDelayed`, or `ToBeSettledCancelled` | `Settled` |

`Settled` is terminal — no instruction has it as the expected current. Any reverse
transition reverts. `init_flight_data` itself is bound by strict `init` (D6) so it
can only run when the PDA doesn't exist.

### D8 — `OracleConfig` initial state and the `Pubkey::default()` placeholder for consumer

At `initialize(authorized_oracle)`:
- `owner = ctx.accounts.owner.key()`
- `authorized_oracle = arg`
- `authorized_consumer = Pubkey::default()` (32 zeros — sentinel for "not set", indistinguishable from system program ID; safe because no real consumer would have that key)
- `is_consumer_set = false`
- `bump = ctx.bumps.config`

`set_authorized_consumer` writes the real consumer pubkey AND flips
`is_consumer_set = true`. Subsequent calls revert.

The `has_one = authorized_consumer` constraint on consumer-gated instructions
(`init_flight_data`, `set_to_be_settled`, `set_settled`) AUTOMATICALLY rejects
`Pubkey::default()` callers because no signer can have that pubkey — but to make the
intent explicit AND emit the proper error, also `require!(config.is_consumer_set,
OracleError::ConsumerNotSet)` at the top of those instructions.

### D9 — Cargo.toml: NO `anchor-spl`

The oracle program has zero SPL CPIs. `programs/oracle_aggregator/Cargo.toml` keeps
the Phase 0 baseline:

```toml
[dependencies]
anchor-lang = { workspace = true }
```

`idl-build = ["anchor-lang/idl-build"]` (no `anchor-spl/idl-build`). Per Phase 0 D9,
this is the right shape until SPL is actually used.

`init_if_needed` is NOT enabled because no instruction needs it (`init_flight_data`
uses strict `init` per D6).

### D10 — Custom errors enum

`#[error_code] pub enum OracleError` with at minimum:

- `UnauthorizedOwner` — generic owner gate failure (typically caught by `has_one = owner`)
- `UnauthorizedOracle` — non-oracle caller of `set_estimated_arrival` / `set_landed` / `set_cancelled`
- `UnauthorizedConsumer` — non-consumer caller of `init_flight_data` / `set_to_be_settled` / `set_settled`
- `ConsumerAlreadySet` — `set_authorized_consumer` when `is_consumer_set == true`
- `ConsumerNotSet` — consumer-gated instruction called before `set_authorized_consumer` was wired
- `InvalidStateTransition` — current → new not in the allowed table (D5 + D7)
- `InvalidToBeSettledVariant` — `set_to_be_settled` with `new_status` not in the `ToBeSettled*` set
- `FlightIdEmpty` / `FlightIdTooLong`

### D11 — Test harness

- Unit tests live at `contracts/tests/oracle_aggregator.test.ts` and use the LiteSVM harness from Phases 1–3.
- Extend `setup.ts` with:
  - `bootstrapOracleAggregator(client)` — calls `oracle_aggregator.initialize(authorizedOracle.address)` with a fresh keypair as the initial oracle. Returns `{ ownerSigner, oracleSigner, configPda, programAddress }`.
- Tests use **regular keypairs** (not real PDAs) for the consumer mock — per the dev_steps note "simulate by setting `authorized_consumer` to a test keypair". Phase 5 wires the actual controller PDA via `invoke_signed`. This is the simpler, less-coupled path for unit testing.
- The `REAL_PROGRAMS` set in `smoke.test.ts` must be expanded to include `oracle_aggregator`.

### D12 — Codama-generated client expectations

- `FlightStatus` Codama-generated as a plain TS enum (D16 carries over from Phase 3). Tests assert `flightData.status === FlightStatus.Landed`.
- `set_to_be_settled` takes `new_status: FlightStatus` as an arg → Codama generates a typed `FlightStatusArgs` parameter on the input. Pass via `FlightStatus.ToBeSettledOnTime`.
- No optional accounts on the oracle program → no D11-style program-ID-as-None sentinel needed (carry from Phase 1 D11).
- Use `expireBlockhash` between byte-identical or byte-near-identical txs (D17 from Phase 3) — especially when the same setter is called repeatedly to test reverse-transition reverts.

### D13 — Out of scope (do not implement)

- Owner rotation (no `transfer_owner`).
- Oracle freeze / pause.
- Per-flight historical change-log (architecture stores only the latest state).
- On-chain reader instructions (FlightData is read by the controller via account-passing + owner check, not via CPI; no `Result<T>` reader needed).
- Multi-oracle aggregation (architecture is single-oracle; defer to Pyth/Switchboard integration phase if needed).
- Time-window enforcement on `set_estimated_arrival` (e.g., reject ETAs in the past). The cron is trusted; if it submits a stale ETA, that's a cron bug, not an oracle bug.

### Open follow-ups (post-phase, do not block)

- `set_owner` rotation. Defer to multisig handover.
- Oracle pause. Audit-driven decision.
- Multi-oracle redundancy / Pyth-Switchboard integration. Out of scope.

---

## Subtasks

### 1. Program crate

- [x] 1.1 Replace `programs/oracle_aggregator/src/lib.rs` no-op with the real module: `declare_id!` preserved (`EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`).
- [x] 1.2 Confirm `programs/oracle_aggregator/Cargo.toml` does NOT add `anchor-spl` (D9). `idl-build = ["anchor-lang/idl-build"]` only. No `init-if-needed` feature flag.
- [x] 1.3 Define account structs: `OracleConfig`, `FlightData`, `FlightStatus` enum (D2, D3).
- [x] 1.4 Define module constants: `MAX_FLIGHT_ID_LEN = 16` (D1), shared `validate_flight_id` helper (mirror governance/flight_pool).
- [x] 1.5 Define `OracleError` enum (D10).
- [x] 1.6 Implement `initialize(authorized_oracle: Pubkey)` — owner = signer, creates `OracleConfig` PDA. `authorized_consumer = Pubkey::default()`, `is_consumer_set = false` (D8).
- [x] 1.7 Implement `set_authorized_oracle(new_oracle: Pubkey)` — owner-only via `has_one = owner`. Rotatable; no flag.
- [x] 1.8 Implement `set_authorized_consumer(consumer: Pubkey)` — owner-only, settable once via `is_consumer_set` flag (D4).
- [x] 1.9 Implement `init_flight_data(flight_id, date)` — consumer-only via `has_one = authorized_consumer` AND `require!(config.is_consumer_set, ConsumerNotSet)`. Strict `init` for FlightData PDA (D6). Validates flight_id length (D1).
- [x] 1.10 Implement `set_estimated_arrival(flight_id, date, eta)` — oracle-only via `has_one = authorized_oracle`. Forward-only guard: `NotInitiated → Active` (D7).
- [x] 1.11 Implement `set_landed(flight_id, date, actual_arrival)` — oracle-only. `Active → Landed`.
- [x] 1.12 Implement `set_cancelled(flight_id, date)` — oracle-only. `Active → Cancelled`.
- [x] 1.13 Implement `set_to_be_settled(flight_id, date, new_status: FlightStatus)` — consumer-only. Validates `new_status ∈ {ToBeSettledOnTime, ToBeSettledDelayed, ToBeSettledCancelled}` (`InvalidToBeSettledVariant` if not). Validates current → new pairing per D5 (`InvalidStateTransition` if mismatched).
- [x] 1.14 Implement `set_settled(flight_id, date)` — consumer-only. Forward-only guard: `ToBeSettled* → Settled` (D7).

### 2. IDL + typed-client bridge

- [x] 2.1 `NO_DNA=1 anchor build` clean for `oracle_aggregator_program`. `pnpm sync-idl` updates `oracle_aggregator.json` in `frontend/src/idl/` and `executor/src/idl/`.
- [x] 2.2 `pnpm gen-clients` regenerates Codama clients into all 3 dirs (incl. `contracts/tests/clients/`); `pnpm typecheck` passes.

### 3. Test harness

- [x] 3.1 Extend `contracts/tests/setup.ts` with `bootstrapOracleAggregator(client)` — calls `oracle_aggregator.initialize` with a fresh `authorizedOracle` keypair, returns `{ ownerSigner, oracleSigner, configPda, programAddress }` (D11).
- [x] 3.2 Update `contracts/tests/smoke.test.ts` `REAL_PROGRAMS` set to include `oracle_aggregator`. Smoke loop drops to 1 program (controller).

### 4. Unit tests (`contracts/tests/oracle_aggregator.test.ts`)

#### 4a. Initialization + authority wiring

- [x] 4.1 `initialize` — `OracleConfig.owner = client.payer`; `authorized_oracle = arg`; `authorized_consumer = Pubkey::default()`; `is_consumer_set = false`.
- [x] 4.2 `set_authorized_oracle` — owner success rotates the field; non-owner reverts. (Multiple rotations succeed.)
- [x] 4.3 `set_authorized_consumer` — owner success once; second call reverts with `ConsumerAlreadySet`; non-owner reverts.

#### 4b. Forward-only state machine — happy paths

- [x] 4.4 `init_flight_data` — consumer-signed creates FlightData PDA in `NotInitiated`. Re-init reverts (PDA collision). Length cap on `flight_id` reverts (`FlightIdTooLong`).
- [x] 4.5 `set_estimated_arrival` — oracle-signed; `NotInitiated → Active`; `estimated_arrival_time` set.
- [x] 4.6 `set_landed` — oracle-signed; `Active → Landed`; `actual_arrival_time` set.
- [x] 4.7 `set_cancelled` — oracle-signed; `Active → Cancelled` (separate fixture from 4.6 — branch).
- [x] 4.8 `set_to_be_settled` happy paths: `Landed → ToBeSettledOnTime`, `Landed → ToBeSettledDelayed`, `Cancelled → ToBeSettledCancelled` (3 sub-cases).
- [x] 4.9 `set_settled` — consumer-signed; each `ToBeSettled*` variant transitions to `Settled`.

#### 4c. Authorization reverts

- [x] 4.10 Oracle-only ix (`set_estimated_arrival`, `set_landed`, `set_cancelled`) revert when called by non-oracle (parameterised across at least 2 of the 3).
- [x] 4.11 Consumer-only ix (`init_flight_data`, `set_to_be_settled`, `set_settled`) revert when called by non-consumer (parameterised across at least 2 of the 3).
- [x] 4.12 Consumer-only ix revert with `ConsumerNotSet` when called BEFORE `set_authorized_consumer` (i.e., `is_consumer_set == false`).

#### 4d. Forward-only state-machine guards

- [x] 4.13 `set_estimated_arrival` reverts when `status != NotInitiated` (already Active).
- [x] 4.14 `set_landed` reverts when `status != Active` (e.g., NotInitiated, Landed).
- [x] 4.15 `set_cancelled` reverts when `status != Active`.
- [x] 4.16 `set_to_be_settled` strict pairing (D5):
  - `Landed → ToBeSettledCancelled` reverts.
  - `Cancelled → ToBeSettledOnTime` reverts.
  - `Cancelled → ToBeSettledDelayed` reverts.
  - Current ∉ {Landed, Cancelled} reverts (e.g., Active → ToBeSettledOnTime).
- [x] 4.17 `set_to_be_settled` reverts when `new_status` is NOT a `ToBeSettled*` variant (e.g., `FlightStatus.Active`, `FlightStatus.Settled`) — `InvalidToBeSettledVariant`.
- [x] 4.18 `set_settled` reverts when `status` is not in `{ToBeSettledOnTime, ToBeSettledDelayed, ToBeSettledCancelled}` (e.g., Settled, Active).
- [x] 4.19 Reverse-transition invariant — after `Settled`, NO setter can transition out of it. (Cover via one assertion attempting `set_settled` again on a Settled flight.)

### Gate

All of the following must hold before `/complete-phase 4`:

- [x] `NO_DNA=1 anchor build` succeeds for `oracle_aggregator_program` (clean binary, no warnings).
- [x] `pnpm sync-idl` produces an updated `contracts/target/idl/oracle_aggregator.json`; copies land in `frontend/src/idl/`, `executor/src/idl/`, and `contracts/tests/clients/`.
- [x] `pnpm gen-clients` produces fresh typed Kit clients in all 3 dirs; `pnpm typecheck` passes across all workspaces.
- [x] `pnpm test:contracts` passes (1 smoke + 17 governance + 16 vault + 16 flight_pool + 19 oracle_aggregator = 69/69).
- [x] No regression in `governance.test.ts`, `vault.test.ts`, `flight_pool.test.ts`, or `smoke.test.ts`.
- [x] `Anchor.toml` oracle_aggregator program ID unchanged from Phase 1 rotation (`EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`).
- [x] `programs/oracle_aggregator/Cargo.toml` does NOT pull in `anchor-spl` (D9).

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-04

Starting Phase 4. Lite prime + manifest carried forward from this conversation's earlier phases.

Skills/refs loaded: `solana-dev` (SKILL.md + compatibility-matrix.md + common-errors.md + security.md + programs/anchor.md + idl-codegen.md + testing.md + kit/overview.md + anchor/migrating-v0.32-to-v1.md).

Project files read: README.md, CLAUDE.md, spec/{architecture.md (overview + §oracle_aggregator_program), workflow.md, progress.md, dev_steps.md (Phase 4), phases/phase-03-flight-pool-program.md (D-references)}, contracts/{programs/oracle_aggregator/{src/lib.rs (Phase 0 skeleton), Cargo.toml (already correct per D9 — no anchor-spl)}, programs/governance/src/lib.rs (style ref), programs/flight_pool/src/lib.rs (state-machine + plain-enum ref), tests/{setup.ts, flight_pool.test.ts}, Anchor.toml}. Canonical oracle_aggregator program ID confirmed: `EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`.

Phase 4 has no Cargo.toml changes (D9 — Phase 0 baseline is already correct). Proceeding to subtask group 1 (program crate).

#### Implementation log

- **§1 program crate** — `programs/oracle_aggregator/src/lib.rs` rewritten end-to-end. Three authority types (`owner`, `authorized_oracle`, `authorized_consumer`) with explicit handler-level checks for the five status-mutator instructions that share the `SetFlightStatus` accounts struct (oracle ix vs consumer ix branch via `require_keys_eq!` against the relevant config field). `OracleConfig` and `FlightData` accounts match architecture verbatim. `MAX_FLIGHT_ID_LEN = 16` shared across all programs. `OracleError` enum (9 variants).
- **D14 (new)** — *Shared accounts struct for status mutators.* Five instructions (`set_estimated_arrival`, `set_landed`, `set_cancelled`, `set_to_be_settled`, `set_settled`) reuse one `SetFlightStatus` accounts struct with `authority: Signer`. Per-ix authority class (oracle vs consumer) is enforced via handler-level `require_keys_eq!` against the relevant config field, NOT via Anchor `has_one`. This keeps the IDL surface tight (1 struct vs 5) and the Codama-generated client uniform across the five setters.
- **§2 IDL + Codama** — `pnpm sync-idl` + `pnpm gen-clients` clean. `ORACLE_AGGREGATOR_PROGRAM_ADDRESS` exported from the generated index. `FlightStatus` mapped to a plain TS enum per Phase 3 D16. PDAs: `findConfigPda` and `findFlightDataPda`. Both async and sync `getInitializeInstruction[Async]` are generated; tests use the async variant.
- **§3 test harness** — `setup.ts` got `bootstrapOracleAggregator(client)` returning `{ ownerSigner, oracleSigner, configPda, programAddress }`. `smoke.test.ts` `REAL_PROGRAMS` set extended with `oracle_aggregator` (smoke loop now down to 1 program: controller). `generateKeyPairSigner` import added to `setup.ts` for the freshly-generated oracle keypair.
- **§4 unit tests** — `contracts/tests/oracle_aggregator.test.ts` covers all 19 dev_steps test cases. `reachStatus(f, consumer, target)` helper drives the state machine to a target FlightStatus by replaying the right ix sequence — keeps test bodies focused on the assertion at the target state.

#### Test bring-up issues hit and resolved

None. **All 19 oracle_aggregator tests + 50 prior tests passed on the first integrated run** — the patterns inherited from Phases 1–3 (Codama plain-enum mapping, `expireBlockhash` between byte-identical txs, mock-keypair as consumer, strict `init` for one-shot PDAs) made the first pass clean.

#### Final gate result

All subtasks complete. **69/69 tests passing** (1 smoke + 17 governance + 16 vault + 16 flight_pool + 19 oracle_aggregator). Typecheck clean across all 3 workspaces. Build clean. oracle_aggregator program ID unchanged from Phase 1 (`EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`). Cargo.toml does NOT include `anchor-spl` (D9). No regressions. Ready for user validation and `/complete-phase 4`.

### Session 2026-05-04 — Completed

Phase validated by user. All gate conditions met. Marking complete.

---

## Files Created / Modified

> Populated by the agent during work.

**Modified:**
- `contracts/programs/oracle_aggregator/src/lib.rs` — full real implementation.
- `contracts/tests/setup.ts` — added `bootstrapOracleAggregator` helper, `ORACLE_AGGREGATOR_PROGRAM_ADDRESS` re-export, `generateKeyPairSigner` import.
- `contracts/tests/smoke.test.ts` — `REAL_PROGRAMS` set extended with `oracle_aggregator`.
- `spec/progress.md` — Phase 4 row + active-phase pointer.

**Created:**
- `contracts/tests/oracle_aggregator.test.ts` — 19 unit tests covering 4.1–4.19.

**Unchanged (intentional, per D9):**
- `contracts/programs/oracle_aggregator/Cargo.toml` — Phase 0 baseline is already correct (no `anchor-spl`, no `init-if-needed`).

**Regenerated (gitignored):**
- `contracts/target/idl/oracle_aggregator.json` (and 4 others; only oracle_aggregator changed semantically).
- `frontend/src/idl/`, `executor/src/idl/`, `frontend/src/clients/`, `executor/src/clients/`, `contracts/tests/clients/` — synced for all 5 programs.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

D1–D13 above are **locked at planning time** and seed this section. Add new entries below as they arise.

### D14 — Shared accounts struct for status-mutator instructions

The five status-mutator instructions (`set_estimated_arrival`, `set_landed`, `set_cancelled`, `set_to_be_settled`, `set_settled`) reuse a single `SetFlightStatus` accounts struct with `authority: Signer`. Per-ix authority class (oracle vs consumer) is enforced inside the handler via `require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.config.authorized_X, OracleError::UnauthorizedX)`, NOT via Anchor `has_one`. Rationale: Anchor's `has_one = X` resolves the field NAME at the accounts-struct level, so reusing the same struct for both classes would require two distinct structs (or a more complex constraint expression). Handler-level `require_keys_eq!` keeps the IDL surface tight (1 accounts struct vs 5) and the Codama-generated client uniform across the five setters. The `is_consumer_set` guard for consumer-only ix is also enforced in the handler. Pattern reusable for any program where multiple instructions take the same accounts but route through different authority classes.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.

### What was built

`oracle_aggregator_program` is now the canonical flight-data feed. It owns `FlightData` PDAs (one per `(flight_id, date)`), holds zero funds (no SPL CPIs anywhere), and gates writes through three distinct authorities: `owner` (initialize, rotate oracle, one-shot wire consumer), `authorized_oracle` (the FlightDataFetcher cron — `set_estimated_arrival`, `set_landed`, `set_cancelled`), and `authorized_consumer` (the controller's `ControllerConfig` PDA, set once — `init_flight_data`, `set_to_be_settled`, `set_settled`). The forward-only state machine `NotInitiated → Active → {Landed, Cancelled} → ToBeSettled* → Settled` is enforced on every transition, and `set_to_be_settled` enforces strict (current → new) pairing so a Landed flight can't be classified cancelled and vice-versa. Authority isolation is now firm: an oracle-key compromise cannot trigger settlement transitions, and a consumer-key compromise cannot rewrite raw flight status.

### Key decisions locked in (D-numbers map to the phase file's Decisions Made section)

- **D1** — `MAX_FLIGHT_ID_LEN = 16` carries over from Phase 1 + Phase 3. Shared `validate_flight_id` helper.
- **D2** — Account types and PDA seeds match `architecture.md` §oracle_aggregator_program verbatim. `OracleConfig` at `[b"oracle_config"]`; `FlightData` at `[b"flight", flight_id, date]`.
- **D3** — `FlightStatus` 8-variant payload-less enum. Codama maps it to a plain TS enum (Phase 3 D16 carries over). Tests assert `flightData.status === FlightStatus.Active`.
- **D4** — Three authority types: `owner` (set at initialize, NOT rotatable in this phase), `authorized_oracle` (rotatable, no flag), `authorized_consumer` (one-shot via `is_consumer_set`).
- **D5** — `set_to_be_settled` strict (current → new) pairing: `Landed → OnTime|Delayed`; `Cancelled → Cancelled`. All other pairings revert with `InvalidStateTransition`.
- **D6** — `init_flight_data` strict `init`. Re-init reverts via PDA collision.
- **D7** — Forward-only state-machine guards on every transition. `Settled` is terminal.
- **D8** — `Pubkey::default()` is the unset sentinel for `authorized_consumer`; `is_consumer_set` is the canonical check, enforced by handler-level `require!(config.is_consumer_set, ConsumerNotSet)`.
- **D9** — **NO `anchor-spl`** in Cargo.toml. First (and only) program in Phases 1–5 that doesn't touch SPL Token. Phase 0 baseline is correct as-is.
- **D10** — `OracleError` enum with 9 variants.
- **D11** — Test harness extension: `bootstrapOracleAggregator(client)` returns `{ ownerSigner, oracleSigner, configPda, programAddress }`. Tests use a regular keypair as the mock consumer (Phase 5 wires the real controller PDA).
- **D12** — Codama enum + Phase 3 D16/D17 conventions reused.
- **D13** — Out of scope: owner rotation, oracle freeze, multi-oracle aggregation, time-window enforcement on `set_estimated_arrival`.
- **D14 (new)** — **Shared accounts struct for status mutators.** Five instructions (`set_estimated_arrival`, `set_landed`, `set_cancelled`, `set_to_be_settled`, `set_settled`) reuse a single `SetFlightStatus` accounts struct with `authority: Signer`. Per-ix authority class (oracle vs consumer) is enforced in the handler via `require_keys_eq!` against the relevant config field, NOT via Anchor `has_one`. Keeps the IDL surface tight (1 struct vs 5) and the Codama-generated client uniform. Pattern reusable for any program where multiple instructions take the same accounts but route through different authority classes.

### Files created or modified — final list

**Modified (committed sources):**
- `contracts/programs/oracle_aggregator/src/lib.rs` — full real implementation.
- `contracts/tests/setup.ts` — added `bootstrapOracleAggregator` helper, `ORACLE_AGGREGATOR_PROGRAM_ADDRESS` re-export, `generateKeyPairSigner` import.
- `contracts/tests/smoke.test.ts` — `REAL_PROGRAMS` set extended with `oracle_aggregator`.
- `spec/progress.md` — Phase 4 row + active-phase pointer.

**Created:**
- `contracts/tests/oracle_aggregator.test.ts` — 19 unit tests covering 4.1–4.19.
- `spec/phases/phase-04-oracle-aggregator-program.md` — this file.

**Unchanged (intentional, per D9):**
- `contracts/programs/oracle_aggregator/Cargo.toml` — Phase 0 baseline is already correct (no `anchor-spl`, no `init-if-needed`).

**Regenerated (gitignored):**
- `contracts/target/idl/oracle_aggregator.json` (and 4 others; only oracle_aggregator changed semantically).
- `frontend/src/idl/`, `executor/src/idl/`, `frontend/src/clients/`, `executor/src/clients/`, `contracts/tests/clients/` — synced for all 5 programs.

### Notes for the next phase (Phase 5 — controller_program)

- **Controller is the orchestrator.** It owns `ControllerConfig` (with refs to all four other programs + USDC mint) and `ActiveFlightList`. It holds zero user funds — every money movement is delegated to `flight_pool` (treasury) or `vault` (capital). It's the only program that CPIs into all four others.
- **CPI signing pattern.** The controller's `ControllerConfig` PDA at `[b"controller_config"]` is the signer for CPIs to:
  - `governance` — `is_route_whitelisted`, `get_route_terms` (read-only via `Result<T>` return data per Phase 1 D3/D10)
  - `flight_pool` — `register_pool`, `add_buyer`, `settle_on_time`, `settle_delayed`, `settle_cancelled`
  - `vault` — `increase_locked`, `decrease_locked`, `send_payout`, `record_premium_income`, `process_withdrawal_queue`, `snapshot`
  - `oracle_aggregator` — `init_flight_data`, `set_to_be_settled`, `set_settled`
  Use `CpiContext::new_with_signer(<TARGET>::id(), accounts, signer_seeds)` per Anchor v1 (signer_seeds = `[b"controller_config", &[bump]]`). Cache the bump on `ControllerConfig` per Phase 3 D-bumps-cache pattern.
- **`buy_insurance` is the heavy hitter.** 6+ CPIs in one tx: governance read (terms + whitelist via return-data), maybe oracle.init_flight_data (first buy only), maybe flight_pool.register_pool (first buy only), flight_pool.add_buyer, vault.increase_locked. Solvency check in between. Watch the compute budget; consider `setComputeUnitLimit` in tests if needed.
- **`classify_flights` and `execute_settlements`** loop over `ActiveFlightList` entries. Architecture sets `MAX_FLIGHTS_PER_TX ≈ 2` due to per-flight CPI overhead. Tests should explicitly exercise the multi-flight batch path.
- **`set_authorized_keeper` is rotatable** (no `is_X_set` flag — like the oracle's `authorized_oracle`). Owner-only.
- **`set_authorized_consumer` wiring on the oracle.** Phase 5's `controller.initialize` doesn't call `oracle.set_authorized_consumer` — it can't (the controller's CPI signer is the controller PDA, but `set_authorized_consumer` is owner-gated on the oracle). The owner of the oracle must call it manually with the controller's PDA address. Same for `vault.set_controller` and `flight_pool.set_controller`. Document this as a one-shot bring-up sequence in the Phase 5 plan.
- **Phase 5 ID is canonical** (`G4v4i3LoLX7v3cEb3cehNGWMHbvHArRyPSEiZmg5VSot`). Don't rotate.
- **`Result<T>` return-data reads from CPI.** Phase 1 D3/D10 readers (`get_route_terms`, `is_route_whitelisted`) use Anchor's native `Result<T>` return shape. The controller calls these via CPI and reads return data using `program::get_return_data()` after the CPI. Test this carefully — it's the trickiest CPI pattern in the project.
- **All five programs' Codama clients are now in `contracts/tests/clients/`.** Phase 5 tests can compose multi-program flows.

### Known limitations / deferred

- No owner rotation for oracle (`set_owner`) — defer to multisig handover.
- No oracle freeze / pause — audit-driven decision.
- No multi-oracle aggregation. `authorized_oracle` is a single key; replacing with Pyth/Switchboard is out of scope.
- No time-window enforcement on `set_estimated_arrival` (e.g., reject ETAs in the past). The cron is trusted.
- No historical change-log of FlightData transitions — only the latest state is stored.
- Settled FlightData PDAs persist indefinitely (no close path). This is intentional — they're historical record.
