# Phase 4 — oracle_aggregator_program

Status: planned
Started: —
Completed: —

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

- [ ] 1.1 Replace `programs/oracle_aggregator/src/lib.rs` no-op with the real module: `declare_id!` preserved (`EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`).
- [ ] 1.2 Confirm `programs/oracle_aggregator/Cargo.toml` does NOT add `anchor-spl` (D9). `idl-build = ["anchor-lang/idl-build"]` only. No `init-if-needed` feature flag.
- [ ] 1.3 Define account structs: `OracleConfig`, `FlightData`, `FlightStatus` enum (D2, D3).
- [ ] 1.4 Define module constants: `MAX_FLIGHT_ID_LEN = 16` (D1), shared `validate_flight_id` helper (mirror governance/flight_pool).
- [ ] 1.5 Define `OracleError` enum (D10).
- [ ] 1.6 Implement `initialize(authorized_oracle: Pubkey)` — owner = signer, creates `OracleConfig` PDA. `authorized_consumer = Pubkey::default()`, `is_consumer_set = false` (D8).
- [ ] 1.7 Implement `set_authorized_oracle(new_oracle: Pubkey)` — owner-only via `has_one = owner`. Rotatable; no flag.
- [ ] 1.8 Implement `set_authorized_consumer(consumer: Pubkey)` — owner-only, settable once via `is_consumer_set` flag (D4).
- [ ] 1.9 Implement `init_flight_data(flight_id, date)` — consumer-only via `has_one = authorized_consumer` AND `require!(config.is_consumer_set, ConsumerNotSet)`. Strict `init` for FlightData PDA (D6). Validates flight_id length (D1).
- [ ] 1.10 Implement `set_estimated_arrival(flight_id, date, eta)` — oracle-only via `has_one = authorized_oracle`. Forward-only guard: `NotInitiated → Active` (D7).
- [ ] 1.11 Implement `set_landed(flight_id, date, actual_arrival)` — oracle-only. `Active → Landed`.
- [ ] 1.12 Implement `set_cancelled(flight_id, date)` — oracle-only. `Active → Cancelled`.
- [ ] 1.13 Implement `set_to_be_settled(flight_id, date, new_status: FlightStatus)` — consumer-only. Validates `new_status ∈ {ToBeSettledOnTime, ToBeSettledDelayed, ToBeSettledCancelled}` (`InvalidToBeSettledVariant` if not). Validates current → new pairing per D5 (`InvalidStateTransition` if mismatched).
- [ ] 1.14 Implement `set_settled(flight_id, date)` — consumer-only. Forward-only guard: `ToBeSettled* → Settled` (D7).

### 2. IDL + typed-client bridge

- [ ] 2.1 `NO_DNA=1 anchor build` clean for `oracle_aggregator_program`. `pnpm sync-idl` updates `oracle_aggregator.json` in `frontend/src/idl/` and `executor/src/idl/`.
- [ ] 2.2 `pnpm gen-clients` regenerates Codama clients into all 3 dirs (incl. `contracts/tests/clients/`); `pnpm typecheck` passes.

### 3. Test harness

- [ ] 3.1 Extend `contracts/tests/setup.ts` with `bootstrapOracleAggregator(client)` — calls `oracle_aggregator.initialize` with a fresh `authorizedOracle` keypair, returns `{ ownerSigner, oracleSigner, configPda, programAddress }` (D11).
- [ ] 3.2 Update `contracts/tests/smoke.test.ts` `REAL_PROGRAMS` set to include `oracle_aggregator`. Smoke loop drops to 1 program (controller).

### 4. Unit tests (`contracts/tests/oracle_aggregator.test.ts`)

#### 4a. Initialization + authority wiring

- [ ] 4.1 `initialize` — `OracleConfig.owner = client.payer`; `authorized_oracle = arg`; `authorized_consumer = Pubkey::default()`; `is_consumer_set = false`.
- [ ] 4.2 `set_authorized_oracle` — owner success rotates the field; non-owner reverts. (Multiple rotations succeed.)
- [ ] 4.3 `set_authorized_consumer` — owner success once; second call reverts with `ConsumerAlreadySet`; non-owner reverts.

#### 4b. Forward-only state machine — happy paths

- [ ] 4.4 `init_flight_data` — consumer-signed creates FlightData PDA in `NotInitiated`. Re-init reverts (PDA collision). Length cap on `flight_id` reverts (`FlightIdTooLong`).
- [ ] 4.5 `set_estimated_arrival` — oracle-signed; `NotInitiated → Active`; `estimated_arrival_time` set.
- [ ] 4.6 `set_landed` — oracle-signed; `Active → Landed`; `actual_arrival_time` set.
- [ ] 4.7 `set_cancelled` — oracle-signed; `Active → Cancelled` (separate fixture from 4.6 — branch).
- [ ] 4.8 `set_to_be_settled` happy paths: `Landed → ToBeSettledOnTime`, `Landed → ToBeSettledDelayed`, `Cancelled → ToBeSettledCancelled` (3 sub-cases).
- [ ] 4.9 `set_settled` — consumer-signed; each `ToBeSettled*` variant transitions to `Settled`.

#### 4c. Authorization reverts

- [ ] 4.10 Oracle-only ix (`set_estimated_arrival`, `set_landed`, `set_cancelled`) revert when called by non-oracle (parameterised across at least 2 of the 3).
- [ ] 4.11 Consumer-only ix (`init_flight_data`, `set_to_be_settled`, `set_settled`) revert when called by non-consumer (parameterised across at least 2 of the 3).
- [ ] 4.12 Consumer-only ix revert with `ConsumerNotSet` when called BEFORE `set_authorized_consumer` (i.e., `is_consumer_set == false`).

#### 4d. Forward-only state-machine guards

- [ ] 4.13 `set_estimated_arrival` reverts when `status != NotInitiated` (already Active).
- [ ] 4.14 `set_landed` reverts when `status != Active` (e.g., NotInitiated, Landed).
- [ ] 4.15 `set_cancelled` reverts when `status != Active`.
- [ ] 4.16 `set_to_be_settled` strict pairing (D5):
  - `Landed → ToBeSettledCancelled` reverts.
  - `Cancelled → ToBeSettledOnTime` reverts.
  - `Cancelled → ToBeSettledDelayed` reverts.
  - Current ∉ {Landed, Cancelled} reverts (e.g., Active → ToBeSettledOnTime).
- [ ] 4.17 `set_to_be_settled` reverts when `new_status` is NOT a `ToBeSettled*` variant (e.g., `FlightStatus.Active`, `FlightStatus.Settled`) — `InvalidToBeSettledVariant`.
- [ ] 4.18 `set_settled` reverts when `status` is not in `{ToBeSettledOnTime, ToBeSettledDelayed, ToBeSettledCancelled}` (e.g., Settled, Active).
- [ ] 4.19 Reverse-transition invariant — after `Settled`, NO setter can transition out of it. (Cover via one assertion attempting `set_settled` again on a Settled flight.)

### Gate

All of the following must hold before `/complete-phase 4`:

- `NO_DNA=1 anchor build` succeeds for `oracle_aggregator_program` (clean binary, no warnings).
- `pnpm sync-idl` produces an updated `contracts/target/idl/oracle_aggregator.json`; copies land in `frontend/src/idl/`, `executor/src/idl/`, and `contracts/tests/clients/`.
- `pnpm gen-clients` produces fresh typed Kit clients in all 3 dirs; `pnpm typecheck` passes across all workspaces.
- `pnpm test:contracts` passes ALL tests: 1 smoke (the remaining no-op program: controller) + 17 governance + 16 vault + 16 flight_pool + 19 oracle_aggregator = ≥69 tests.
- No regression in `governance.test.ts`, `vault.test.ts`, `flight_pool.test.ts`, or `smoke.test.ts`.
- `Anchor.toml` oracle_aggregator program ID unchanged from Phase 1 rotation (`EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`).
- `programs/oracle_aggregator/Cargo.toml` does NOT pull in `anchor-spl` (D9).

---

## Work Log

> Populated by the agent during work. Do not edit manually.

---

## Files Created / Modified

> Populated by the agent during work.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

D1–D13 above are **locked at planning time** and seed this section. Add new entries below as they arise.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.
