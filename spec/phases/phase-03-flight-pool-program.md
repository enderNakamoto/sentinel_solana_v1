# Phase 3 — flight_pool_program

Status: complete
Started: 2026-05-04
Completed: 2026-05-04

---

## Goal

Replace the Phase 0 no-op `flight_pool` skeleton with the real program: a per-flight
pool registry, a single shared **pool treasury** USDC token account that holds all
in-flight premiums + payouts, per-buyer `BuyerRecord` PDAs (enabling
`getProgramAccounts` + memcmp queries for "my policies"), claim and sweep paths, and
recovery accounting. After this phase, `flight_pool_program` is the system's
sole custodian of in-flight USDC; the controller (Phase 5) orchestrates writes via
CPI, travelers call `claim` directly, and anyone can `sweep_expired` to reclaim
unclaimed payouts. Cross-program integration with vault + controller lands in
Phases 5–6.

## Dependencies

- **Phase 0** — workspace, IDL/Codama pipeline, mock USDC keypair, LiteSVM harness.
- **Phase 1** — `init_if_needed` Cargo feature pattern, optional-account "None" sentinel
  pattern (not used here — flight_pool has no `Option<Account>` constraints planned),
  `Result<T>` reader instruction shape (no on-chain readers planned for flight_pool).
- **Phase 2** — `MAX_FLIGHT_ID_LEN = 16` matches governance Phase 1 D1 (locked here as
  D1). Vault's PDA-signed-token-transfer pattern (`[b"vault_state", &[bump]]` signer
  seeds → `MintTo` / `Burn` / `Transfer`) is the direct analogue for
  `[b"pool_treasury", &[bump]]` here. Vault's `set_controller` once-only flag pattern
  (D7) is reused verbatim. Mock USDC LiteSVM seeding helpers
  (`createMockUsdcMint`, `setTokenAccount`, `mintMockUsdcTo`,
  `getTokenAccountAmount`, `getAtaAddress`) are ready to reuse from `setup.ts`.

No on-chain dependency on `governance` or `vault`. The flight_pool reads neither —
those references flow in via the controller (Phase 5).

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
- `references/programs/anchor.md` — Anchor v1 patterns: `Mint` / `TokenAccount` constraints, PDA-signed CPIs, `init` strict-mode (no `init_if_needed` for `BuyerRecord` per D2)
- `references/idl-codegen.md` — Anchor IDL → Codama → Kit-client pipeline
- `references/testing.md` — LiteSVM unit-test patterns, sysvar manipulation, packed account seeding
- `references/kit/overview.md` — `@solana/kit` Address / Transaction / signer patterns
- `references/anchor/migrating-v0.32-to-v1.md` — Anchor v1 idioms (single-lifetime `Context`, `CpiContext::new(Pubkey, ...)`, no `Option<Account>` here so D11 sentinel doesn't apply)
- `references/payments.md` — SPL Token transfer semantics, ATA construction, decimals discipline (USDC = 6)

### Docs to Fetch

- https://www.anchor-lang.com/docs — Anchor v1 program structure
- https://www.anchor-lang.com/docs/references/account-constraints — `#[account(...)]` reference (init, has_one, associated_token, mint::, seeds, bump, close)
- https://www.anchor-lang.com/docs/references/space — Anchor account-space rules (`InitSpace` derive for fixed-size accounts; `#[max_len]` on `String` fields)
- https://spl.solana.com/token — SPL Token Transfer reference
- https://docs.solana.com/developing/clients/jsonrpc-api#getprogramaccounts — `getProgramAccounts` + memcmp filter spec (relevant to architecture's "MyPolicies" query pattern)

### Project Files to Read

- `spec/architecture.md` (universal default) — esp. §flight_pool_program (lines 330–485) and §Authorization patterns
- `spec/dev_steps.md` (universal default) — Phase 3 deliverables + tests (lines 280–333)
- `spec/workflow.md` (universal default) — phase lifecycle
- `MEMORY.md` (universal default) — locked Phase 0/1/2 decisions; canonical program IDs; Anchor v1 + LiteSVM patterns to reuse
- `spec/phases/phase-02-vault-program.md` — Phase 2 work log + Decisions (esp. D3 PDA-keyed mint pattern, D4 program-owned ATA, D7 set_controller once-only, D11 error enum style, D17 advanceClock, D18 setAccount shape)
- `spec/phases/phase-01-governance-program.md` — Phase 1 reference for `MAX_FLIGHT_ID_LEN = 16`, error enum style
- `spec/learn_solana.md` — Soroban-to-Solana sanity check (skim only)
- `contracts/programs/flight_pool/src/lib.rs` — Phase 0 no-op skeleton being replaced
- `contracts/programs/flight_pool/Cargo.toml` — needs `anchor-spl` re-introduction (same pattern as Phase 2 D10)
- `contracts/programs/governance/src/lib.rs` — reference for `MAX_FLIGHT_ID_LEN`, length validation helper (`validate_route_lengths` analogue)
- `contracts/programs/vault/src/lib.rs` — reference for SPL Token CPI patterns (`Transfer`, PDA `invoke_signed`, ATA construction), `set_controller` once-only, `has_one = controller` gating
- `contracts/programs/vault/Cargo.toml` — Cargo.toml shape with `anchor-spl` + `idl-build` features
- `contracts/tests/setup.ts` — Phase 2 LiteSVM harness with `createMockUsdcMint`, `setTokenAccount`, `mintMockUsdcTo`, `bootstrapVault`. Extend with `bootstrapFlightPool`.
- `contracts/tests/vault.test.ts` — reference test pattern: `freshFixture`, `fundedSigner`, `setMockController`, controller-only revert assertions, FIFO queue tests, ATA setup
- `contracts/Anchor.toml` — confirm canonical flight_pool program ID (`GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq`)
- `keys/mock-usdc.pubkey` + `keys/mock-usdc-authority.pubkey` — canonical mock USDC mint addresses

## Pre-work Notes

> Decisions locked during planning (2026-05-04). The agent must follow these.

### D1 — `MAX_FLIGHT_ID_LEN = 16` (matches governance)

Align with Phase 1 D1: `pub const MAX_FLIGHT_ID_LEN: usize = 16`. Architecture's
"max 10 chars" comment is a documentation hint, not a hard cap; aligning prevents a
Phase 5 controller bug where a route is governance-whitelisted with an 11–16 char
`flight_id` but `flight_pool.add_buyer` rejects it. Validate length on every
instruction taking `flight_id: String` (`register_pool`, `add_buyer`,
`settle_on_time`, `settle_delayed`, `settle_cancelled`, `claim`, `sweep_expired`)
via a shared helper `validate_flight_id(&str)` that mirrors governance's
`validate_route_lengths`.

`date: u64` is fixed-size (8 bytes) — no length validation needed. Use
`&date.to_le_bytes()` as the PDA seed component.

### D2 — Account types and PDA seeds (matches architecture.md verbatim)

| Account | PDA seeds | Purpose |
|---|---|---|
| `FlightPoolConfig` | `[b"flight_pool_config"]` | Singleton config + counters; pool_treasury ATA address; recovered_balance counter. |
| pool_treasury authority PDA | `[b"pool_treasury"]` | NOT a stored Anchor `#[account]` — just a signer-seed PDA whose `find_program_address` derives the authority for the shared USDC token account. The associated_token program creates the ATA at `ATA(treasury_authority_pda, usdc_mint)`. |
| `FlightPool` | `[b"pool", flight_id.as_bytes(), &date.to_le_bytes()]` | One per (flight_id, date). Created by `register_pool`. **Strict `init`** — `register_pool` reverts if pool already exists. |
| `BuyerRecord` | `[b"buyer", pool_pda.as_ref(), buyer_pubkey.as_ref()]` | One per (pool, buyer). Created by `add_buyer`. **Strict `init`** — re-purchase reverts via PDA collision (dev_steps test). |

**Field order on `BuyerRecord`** matters for the architecture's memcmp pattern:

```rust
#[account]
pub struct BuyerRecord {
    pub buyer: Pubkey,         // offset 8 — filterable
    pub pool: Pubkey,           // offset 40 — filterable
    pub has_policy: bool,
    pub claimed: bool,
    pub bump: u8,
}
```

The `pool` field is redundant with the seed (the seed contains `pool_pda.as_ref()`),
but it's stored explicitly so frontend `getProgramAccounts` can memcmp-filter "all
buyers in pool X" without re-deriving anything client-side. Same redundancy pattern
as Phase 2 D1's `WithdrawalRequest.claimable: Pubkey`.

### D3 — Pool treasury: shared USDC ATA owned by `[b"pool_treasury"]` PDA

Two PDAs in play:
- `flight_pool_config` PDA — stores config (owner, controller, etc.). NOT a token account.
- `pool_treasury` PDA — derived from `[b"pool_treasury"]`. NOT a stored Anchor account; just a signer-seed authority address.

The actual treasury USDC token account is `ATA(pool_treasury_authority_pda, usdc_mint)`.
Anchor `associated_token::mint = usdc_mint, associated_token::authority = pool_treasury_authority`. The Anchor `init` constraint creates the ATA at `initialize` time. The `pool_treasury_authority` is the runtime-resolved PDA address (`UncheckedAccount` with `seeds = [b"pool_treasury"]` constraint).

`FlightPoolConfig.pool_treasury: Pubkey` stores the ATA address (not the authority address) for client-side reads.

The program signs treasury outflows (`settle_on_time`, `claim`, `sweep_expired` for accounting only — no transfer there, `withdraw_recovered`) via `invoke_signed` with seeds `[b"pool_treasury", &[bump]]`. The bump is rederived per-call — store it on `FlightPoolConfig` to skip the `find_program_address` cost.

### D4 — `set_controller` settable once (matches Phase 2 D7)

Owner-only via `has_one = owner`. Reverts when `is_controller_set == true`. Store
`controller: Pubkey` (= controller_program's `ControllerConfig` PDA address; for
Phase 3 unit tests just any test pubkey). Controller-gated instructions
(`register_pool`, `add_buyer`, `settle_on_time`, `settle_delayed`,
`settle_cancelled`) check `has_one = controller` AND require the controller as a
`Signer`. In Phase 5 production this is `invoke_signed`; in Phase 3 unit tests we
sign with a regular keypair set as `controller`.

### D5 — `register_pool` strict `init` + locked terms

Anchor `#[account(init, ...)]` (not `init_if_needed`). Reverts if the FlightPool
PDA already exists for `(flight_id, date)`. Terms (`premium`, `payoff`,
`delay_hours`) are written once at register time and never mutated again. `status`
starts as `SettlementStatus::Active`; `buyer_count = 0`; `claimed_count = 0`;
`claim_expiry = 0`.

### D6 — `add_buyer` strict `init` for `BuyerRecord` + premium transfer

Anchor `#[account(init, ...)]` for `BuyerRecord`. Re-purchase by the same buyer for
the same pool reverts via the PDA-collision-on-init failure path (Anchor returns
`AccountAlreadyInitialized` aka error 0/3008 in v1).

The premium SPL Token transfer (traveler ATA → pool_treasury ATA) is signed by the
**traveler's signature**, which transitively passes through the controller's CPI
chain (architecture §Buying Insurance, "Solana auth note: ... traveler signature
passes through transitively"). The flight_pool program's `add_buyer` instruction
takes the traveler as a `Signer` so Anchor enforces it. In Phase 3 unit tests, the
traveler signs the tx directly (no controller in between); Phase 5 wires the
controller CPI.

`add_buyer` increments `pool.buyer_count`. Reverts if `pool.status != Active`.

### D7 — `settle_*` instructions

| Instruction | What it does | Token movement |
|---|---|---|
| `settle_on_time` | Marks `pool.status = SettledOnTime`. Transfers `pool.premium * pool.buyer_count` from pool_treasury → recipient (vault token account). | YES — outflow signed by `pool_treasury` PDA. |
| `settle_delayed` | Marks `pool.status = SettledDelayed`, sets `pool.claim_expiry = arg`. | NO — vault.send_payout (called separately by controller in same tx) tops up treasury. |
| `settle_cancelled` | Marks `pool.status = SettledCancelled`, sets `pool.claim_expiry = arg`. | NO — same as delayed. |

All three revert if `pool.status != Active` (forward-only state machine). The
recipient for `settle_on_time` is **trusted** (per user choice): it's whatever the
controller passes as the recipient token account. The controller is `has_one`-gated
by config.controller, so a malicious recipient implies a malicious controller —
which would be a Phase 5 / governance issue, not a flight_pool issue. We do
constrain `recipient.mint == config.usdc_mint` to prevent accidental
wrong-mint transfers.

### D8 — `claim` — strict `ATA(traveler, usdc_mint)` recipient

Anchor `associated_token::mint = config.usdc_mint, associated_token::authority = traveler`. Auto-derived; no off-chain ATA bookkeeping. If the ATA doesn't exist on-chain, the traveler must batch an `associated_token::create` ix in the same tx (or pre-create). Tests pre-seed the ATA via `mintMockUsdcTo(client, traveler, 0n)`.

`claim` body:
1. Verify `pool.status == SettledDelayed || pool.status == SettledCancelled`.
2. Verify `now <= pool.claim_expiry` (within window).
3. Verify `buyer_record.has_policy && !buyer_record.claimed`.
4. Set `buyer_record.claimed = true`, increment `pool.claimed_count`.
5. CPI Transfer `pool.payoff` from pool_treasury → traveler ATA, signed by `[b"pool_treasury", &[bump]]`.

Reverts on: status mismatch, past expiry, no policy, already claimed.

### D9 — `sweep_expired` — anyone callable, idempotent

Anchor: caller is `Signer` (for tx fee) but no `has_one` or owner check. Body:
1. Verify `pool.status == SettledDelayed || pool.status == SettledCancelled`.
2. Verify `now > pool.claim_expiry` (past expiry).
3. Compute `unclaimed = (pool.buyer_count - pool.claimed_count) as u64 * pool.payoff`.
4. If `unclaimed == 0`: idempotent return `Ok(())` without state change.
5. Otherwise: increment `config.recovered_balance += unclaimed`. Set
   `pool.claimed_count = pool.buyer_count` (closes the window). NO token transfer
   (USDC stays in the shared pool_treasury — only the counter shifts).
6. Second call: step 4 returns Ok (claimed_count == buyer_count → unclaimed == 0).

### D10 — `withdraw_recovered` — owner-only, decrements counter, transfers USDC

Owner-only via `has_one = owner`. Validates `amount <= config.recovered_balance`,
decrements the counter, transfers USDC from pool_treasury → owner ATA via PDA-signed
CPI. The owner ATA is `ATA(owner, usdc_mint)`, validated via Anchor
`associated_token::mint = usdc_mint, associated_token::authority = owner`.

### D11 — Custom errors enum

`#[error_code] pub enum FlightPoolError` with at minimum:

- `Unauthorized` — generic auth failure
- `ControllerAlreadySet`
- `FlightIdTooLong`
- `FlightIdEmpty`
- `PoolAlreadyExists` — surfaced when `register_pool` collides (Anchor's default `AccountAlreadyInitialized` is fine too; this enum entry is for human-readable wrapping if we ever wrap the constraint error)
- `PoolNotActive` — `add_buyer` / `settle_*` when status != Active
- `PoolNotSettled` — `claim` / `sweep_expired` when status not in {SettledDelayed, SettledCancelled}
- `ClaimExpired` — `claim` when `now > claim_expiry`
- `NotYetExpired` — `sweep_expired` when `now <= claim_expiry`
- `AlreadyClaimed` — `claim` when buyer already claimed
- `NotPolicyHolder` — `claim` when `buyer_record.has_policy == false` (defensive; PDA existence already implies has_policy, but explicit)
- `InsufficientRecovered` — `withdraw_recovered` when `amount > recovered_balance`
- `UsdcMintMismatch` — recipient/buyer ATA wrong mint
- `Overflow` — checked arithmetic guard

### D12 — Out of scope (do not implement)

- Owner rotation (no `transfer_owner`).
- Pool-level pause / freeze.
- Refunds before settlement (architecture doesn't specify; defer to a feature phase if needed).
- `claim` after expiry from a sweep-aware path. After expiry, only `sweep_expired` works; the buyer record stays around as historical record.
- Treasury rebalancing or migration.
- On-chain reader instructions — pool state is read client-side via `getProgramAccounts` + memcmp.

### D13 — Cargo.toml: re-introduce `anchor-spl` (matches Phase 2 D10)

```toml
anchor-lang = { workspace = true, features = ["init-if-needed"] }
anchor-spl = { workspace = true }
```

`init-if-needed` is NOT used by flight_pool — `BuyerRecord` and `FlightPool` both
use strict `init` (D5, D6). However the feature flag is harmless if enabled; enable
it for consistency with Phase 2 in case future enhancements add idempotent PDAs.
**Optional:** drop the `init-if-needed` feature since flight_pool doesn't need it
— smaller surface. Default to enabled for consistency with Phase 2 unless space
is at a premium.

`idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]`.

Imports: `use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};`
Plus `use anchor_spl::associated_token::AssociatedToken;` for the ATA constraints.

### D14 — Testing posture

- Unit tests live at `contracts/tests/flight_pool.test.ts` and use the LiteSVM harness from Phase 2.
- Extend `setup.ts` with:
  - `bootstrapFlightPool(client)` — calls `flight_pool.initialize`, returns
    `{ ownerSigner, configPda, treasuryAuthorityPda, treasuryAta, usdcMint }`.
  - `setMockController(client, configPda)` — generic helper analogous to the one
    inlined in `vault.test.ts`. Consider promoting to `setup.ts` for reuse across
    Phase 3 + Phase 4 (oracle) + Phase 5 (controller).
- Use Codama-generated Kit instruction builders from `contracts/tests/clients/flight_pool/`.
- Clock advancement (`advanceClock` from D17 fix in Phase 2) is needed for `claim`
  expiry tests + `sweep_expired` post-expiry tests.
- `client.svm.expireBlockhash()` between same-args instructions to avoid duplicate-tx-signature collisions (Phase 2 D17 lesson).
- The `REAL_PROGRAMS` set in `smoke.test.ts` must be expanded to include
  `flight_pool` (matches Phase 2 pattern).

### D15 — Idempotent `set_controller` test pattern

The Phase 2 `set_controller` test pattern (owner success → second-call revert →
non-owner revert) is reused here verbatim. Same `ControllerAlreadySet` semantics.

### Open follow-ups (post-phase, do not block)

- `set_owner` rotation. Defer until multisig handover phase.
- Refund-before-settlement instruction (architecture currently has no path to refund a
  premium before the flight settles). Out of scope; flag if user research surfaces it.
- Surfpool seeding still tracked under Phase 6 (D9 from Phase 2).
- Promote `setMockController` to `setup.ts` if Phase 4 also needs it (decide during Phase 4).

---

## Subtasks

### 1. Program crate

- [x] 1.1 Replace `programs/flight_pool/src/lib.rs` no-op with the real module: `declare_id!` preserved (`GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq`).
- [x] 1.2 Update `programs/flight_pool/Cargo.toml`: add `anchor-spl = { workspace = true }`, enable `init-if-needed` on `anchor-lang` (D13), set `idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]`.
- [x] 1.3 Define account structs: `FlightPoolConfig`, `FlightPool`, `BuyerRecord`, `SettlementStatus` enum. Field order on `BuyerRecord` matches D2 (buyer at offset 8, pool at offset 40).
- [x] 1.4 Define module constants: `MAX_FLIGHT_ID_LEN = 16` (D1), shared `validate_flight_id` helper.
- [x] 1.5 Define `FlightPoolError` enum (D11).
- [x] 1.6 Implement `initialize(usdc_mint)` — creates `FlightPoolConfig` PDA + pool_treasury ATA. Stores `pool_treasury` ATA address on config (D3). Stores treasury bump.
- [x] 1.7 Implement `set_controller(controller)` — owner-only, settable once (D4).
- [x] 1.8 Implement `register_pool(flight_id, date, premium, payoff, delay_hours)` — controller-only, strict `init` for FlightPool (D5).
- [x] 1.9 Implement `add_buyer(flight_id, date)` — controller-only, strict `init` for `BuyerRecord`, increments `pool.buyer_count`, transfers premium traveler ATA → pool_treasury ATA (D6).
- [x] 1.10 Implement `settle_on_time(flight_id, date)` — controller-only, transitions Active → SettledOnTime, transfers `premium * buyer_count` from pool_treasury → recipient (vault token account) via PDA-signed CPI (D7).
- [x] 1.11 Implement `settle_delayed(flight_id, date, claim_expiry)` — controller-only, Active → SettledDelayed, sets claim_expiry. No transfer.
- [x] 1.12 Implement `settle_cancelled(flight_id, date, claim_expiry)` — controller-only, Active → SettledCancelled, sets claim_expiry. No transfer.
- [x] 1.13 Implement `claim(flight_id, date)` — traveler signer, validates status + expiry + buyer record, increments `claimed_count`, transfers payoff from pool_treasury → traveler ATA via PDA-signed CPI (D8).
- [x] 1.14 Implement `sweep_expired(flight_id, date)` — anyone callable, post-expiry, increments `recovered_balance`, sets `claimed_count = buyer_count`, idempotent (D9).
- [x] 1.15 Implement `withdraw_recovered(amount)` — owner-only, decrements `recovered_balance`, transfers USDC pool_treasury → owner ATA via PDA-signed CPI (D10).

### 2. IDL + typed-client bridge

- [x] 2.1 `NO_DNA=1 anchor build` clean for `flight_pool_program`. `pnpm sync-idl` updates `flight_pool.json` in `frontend/src/idl/` and `executor/src/idl/`.
- [x] 2.2 `pnpm gen-clients` regenerates Codama clients into all 3 dirs (incl. `contracts/tests/clients/`); `pnpm typecheck` passes.

### 3. Test harness

- [x] 3.1 Extend `contracts/tests/setup.ts` with `bootstrapFlightPool(client)` — calls `flight_pool.initialize`, returns `{ ownerSigner, configPda, treasuryAuthorityPda, treasuryAta, usdcMint }` (D14).
- [x] 3.2 Promote `setMockController` to `setup.ts` (or keep inlined per-test if simpler — decide during work). Same once-only auth pattern as Phase 2.
- [x] 3.3 Update `contracts/tests/smoke.test.ts` `REAL_PROGRAMS` set to include `flight_pool`.

### 4. Unit tests (`contracts/tests/flight_pool.test.ts`)

- [x] 4.1 `initialize` — `FlightPoolConfig` owner = client.payer; pool_treasury ATA exists at the expected address; usdc_mint matches; treasury authority is `[b"pool_treasury"]` PDA; `is_controller_set = false`; `recovered_balance = 0`.
- [x] 4.2 `set_controller` — owner success once; second call reverts with `ControllerAlreadySet`; non-owner reverts (`Unauthorized` / `has_one`).
- [x] 4.3 Controller-only revert paths — `register_pool`, `add_buyer`, `settle_on_time`, `settle_delayed`, `settle_cancelled` all revert when caller is not the configured controller (parameterised).
- [x] 4.4 `register_pool` happy path — creates FlightPool with locked terms; reverts on second call with same `(flight_id, date)` (PDA collision).
- [x] 4.5 `register_pool` validates `flight_id` length cap (`FlightIdTooLong`).
- [x] 4.6 `add_buyer` happy path — creates `BuyerRecord`, increments `buyer_count`, transfers premium traveler ATA → pool_treasury ATA. Verify via `getTokenAccountAmount`.
- [x] 4.7 `add_buyer` second call for same `(pool, buyer)` reverts (PDA collision).
- [x] 4.8 `add_buyer` reverts when `pool.status != Active` (after settlement).
- [x] 4.9 `settle_on_time` happy path — marks `SettledOnTime`, transfers `premium * buyer_count` to recipient, treasury balance decrements correctly.
- [x] 4.10 `settle_delayed` / `settle_cancelled` — sets status + claim_expiry; NO transfer occurs (treasury balance unchanged).
- [x] 4.11 `settle_*` reverts when status != Active (forward-only).
- [x] 4.12 `claim` happy path — `BuyerRecord.claimed = true`, `claimed_count++`, payoff transferred treasury → traveler ATA. Run after `settle_delayed`.
- [x] 4.13 `claim` reverts: no policy (no `BuyerRecord`); already claimed; status `Active` / `SettledOnTime`; past `claim_expiry` (use `advanceClock`).
- [x] 4.14 `sweep_expired` — pre-expiry reverts (`NotYetExpired`); post-expiry: `recovered_balance += (buyer_count - claimed_count) * payoff`, `claimed_count = buyer_count`. Second sweep is a no-op (no state change, no revert).
- [x] 4.15 `withdraw_recovered` happy path — owner only; decrements `recovered_balance`; transfers from treasury → owner ATA; reverts if `amount > recovered_balance`.
- [x] 4.16 Per-user query — pre-condition `add_buyer` for two distinct buyers in two distinct pools, then assert that the BuyerRecord layout puts `buyer` at offset 8 (`Account.data[8..40]` matches the buyer pubkey for each record). Demonstrates the architecture's `getProgramAccounts + memcmp` pattern works in principle (we don't need a live memcmp test in LiteSVM — the byte offsets being correct are the gate).

### Gate

All of the following must hold before `/complete-phase 3`:

- [x] `NO_DNA=1 anchor build` succeeds for `flight_pool_program` (clean binary, no warnings).
- [x] `pnpm sync-idl` produces an updated `contracts/target/idl/flight_pool.json`; copies land in `frontend/src/idl/`, `executor/src/idl/`, and `contracts/tests/clients/`.
- [x] `pnpm gen-clients` produces fresh typed Kit clients in all 3 dirs; `pnpm typecheck` passes across all workspaces.
- [x] `pnpm test:contracts` passes (2 smoke + 17 governance + 16 vault + 16 flight_pool = 51/51).
- [x] No regression in `governance.test.ts`, `vault.test.ts`, or `smoke.test.ts`.
- [x] `Anchor.toml` flight_pool program ID unchanged from Phase 1 rotation (`GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq`).
- [x] `programs/flight_pool/Cargo.toml` re-introduces `anchor-spl` cleanly; workspace lockfile not broken.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-04

Starting Phase 3. Lite prime + manifest loaded.

Skills loaded: `solana-dev` (SKILL.md + compatibility-matrix.md + common-errors.md + security.md + programs/anchor.md + idl-codegen.md + testing.md + kit/overview.md + anchor/migrating-v0.32-to-v1.md + payments.md). Carried forward from Phase 2 via the same conversation.

Project files read: README.md, CLAUDE.md, spec/{architecture.md (overview + §flight_pool_program), workflow.md, progress.md, dev_steps.md (Phase 3), phases/phase-02-vault-program.md (D-references)}, contracts/{programs/flight_pool/{src/lib.rs, Cargo.toml}, programs/governance/{src/lib.rs, Cargo.toml}, programs/vault/{src/lib.rs, Cargo.toml}, tests/{setup.ts, vault.test.ts}, Anchor.toml}. Mock USDC keypair pubkeys carried forward from Phase 2.

Proceeding to subtask group 1 (Cargo.toml + program crate).

#### Implementation log

- **§1 Cargo.toml** — added `anchor-spl`, enabled `init-if-needed` on `anchor-lang`, extended `idl-build`. (D13)
- **§1 program crate** — `programs/flight_pool/src/lib.rs` rewritten. Account types match D2 verbatim; `BuyerRecord` field order has `buyer @ offset 8`, `pool @ offset 40` for the architecture's memcmp filter. `validate_flight_id` helper enforces D1 (`MAX_FLIGHT_ID_LEN = 16`). 10 instructions, all per architecture's authorization table. Treasury authority bump cached on `FlightPoolConfig` (D3) so PDA-signed CPIs avoid `find_program_address` cost.
- **§2 IDL + Codama** — `pnpm sync-idl` + `pnpm gen-clients` clean. 5 generated PDA helpers (`config`, `pool`, `buyerRecord`, `treasuryAuthority`, plus Codama's auto-disambiguated `claimBuyerRecord`). 10 instruction builders + 4 account decoders + `SettlementStatus` enum.
- **§3 test harness** — `setup.ts` got `bootstrapFlightPool(client)` returning `{ ownerSigner, configPda, treasuryAuthorityPda, treasuryAta, usdcMint }`. `smoke.test.ts` `REAL_PROGRAMS` set extended with `'flight_pool'` (smoke loop now down to 2 programs: oracle_aggregator + controller).
- **§4 unit tests** — `contracts/tests/flight_pool.test.ts` covers all 16 dev_steps test cases. `setMockController` lifted into the test file rather than `setup.ts` (will revisit in Phase 4 if needed).

#### Test bring-up issues hit and resolved

1. **`SettlementStatus` shape** — initial draft asserted `pool.status.__kind === 'Active'`. Codama generated it as a plain TS enum (`enum SettlementStatus { Active, ... }`) since the Rust enum has no payload variants. Fixed to `expect(pool.status).toBe(SettlementStatus.Active)`. Documenting as **§D16** below — payload-less Rust enums map to numeric TS enums in Codama, not discriminated unions.
2. **Reverted-tx-occupies-signature-slot in `sweep_expired` test** — pre-expiry call (which `expect.rejects` handles) and post-expiry call had identical args + identical recent blockhash → identical signature. LiteSVM rejected the second submission with "transaction already processed" even though the first one reverted. Fixed by `client.svm.expireBlockhash()` between the two. **Generalises Phase 2 D17** — applies not just to back-to-back successful txs but also after a reverted tx. Documented as **§D17** below.

#### Final gate result

All subtasks complete. **51/51 tests passing** (2 smoke + 17 governance + 16 vault + 16 flight_pool). Typecheck clean across all 3 workspaces. Build clean. flight_pool program ID unchanged from Phase 1 (`GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq`). No regressions. Ready for user validation and `/complete-phase 3`.

### Session 2026-05-04 — Completed

Phase validated by user. All gate conditions met. Marking complete.

---

## Files Created / Modified

> Populated by the agent during work.

**Modified:**
- `contracts/programs/flight_pool/src/lib.rs` — full real implementation.
- `contracts/programs/flight_pool/Cargo.toml` — `init-if-needed`, `anchor-spl`, extended `idl-build`.
- `contracts/tests/setup.ts` — added `bootstrapFlightPool` + re-export of `FLIGHT_POOL_PROGRAM_ADDRESS`.
- `contracts/tests/smoke.test.ts` — `REAL_PROGRAMS` set extended.
- `spec/progress.md` — Phase 3 row + active-phase pointer.

**Created:**
- `contracts/tests/flight_pool.test.ts` — 16 unit tests covering 4.1–4.16.

**Regenerated (gitignored):**
- `contracts/target/idl/flight_pool.json` (and 4 others; only flight_pool changed semantically).
- `frontend/src/idl/`, `executor/src/idl/`, `frontend/src/clients/`, `executor/src/clients/`, `contracts/tests/clients/` — synced for all 5 programs.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

D1–D15 above are **locked at planning time** and seed this section. Add new entries below as they arise.

### D16 — Codama maps payload-less Rust enums to plain TS enums

When a Rust enum has no payload variants (e.g. `SettlementStatus { Active, SettledOnTime, ... }`), Codama generates a plain TS `enum SettlementStatus { Active, SettledOnTime, ... }` (numeric values 0/1/2/...). Tests assert `pool.status === SettlementStatus.Active`, NOT `pool.status.__kind === 'Active'`. The `__kind` shape is reserved for tagged unions (e.g. Phase 2's `U64Update` / `U32Update`).

### D17 — Reverted txs still occupy their signature slot in LiteSVM (extends Phase 2 D17)

A transaction that submits and reverts STILL records its signature with LiteSVM. A subsequent retry with byte-identical args + the same recent blockhash will fail with "transaction already processed" — even though the first attempt didn't change state. **Always rotate `client.svm.expireBlockhash()` between any two byte-identical txs**, including after a reverted one. Phase 3's `sweep_expired` test (pre-expiry revert → advanceClock → post-expiry retry) made this explicit; the Phase 2 D17 lesson is hereby generalised.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.

### What was built

`flight_pool_program` is now the system's sole custodian of in-flight USDC. A single program-controlled token account (the **pool treasury**, `ATA([b"pool_treasury"]_pda, usdc_mint)`) holds premiums from all active flights, payouts for delayed/cancelled settlements, and expired-claim funds. Per-flight money state lives in `FlightPool` PDA fields (`buyer_count`, `claimed_count`, `status`, `claim_expiry`); per-buyer state lives in `BuyerRecord` PDAs at `[b"buyer", pool, buyer]` with `buyer @ offset 8` and `pool @ offset 40` for the architecture's `getProgramAccounts + memcmp` query pattern.

Five controller-gated mutators (`register_pool`, `add_buyer`, `settle_on_time`, `settle_delayed`, `settle_cancelled`) are ready for Phase 5's controller to CPI. Travelers call `claim` directly; anyone can `sweep_expired` after the claim window closes; the owner uses `withdraw_recovered` to pull expired-claim funds. Premium / payoff / claim transfers all flow through the shared treasury, signed by the `[b"pool_treasury"]` PDA via `invoke_signed`.

### Key decisions locked in (D-numbers map to the phase file's Decisions Made section)

- **D1** — `MAX_FLIGHT_ID_LEN = 16` matches Phase 1 governance. `validate_flight_id` helper enforced on every ix taking a `flight_id` arg.
- **D2** — Account types and PDA seeds match `architecture.md` §flight_pool_program verbatim. `BuyerRecord` field order is **load-bearing** for the memcmp pattern: `buyer @ 8`, `pool @ 40`. The `pool: Pubkey` field is intentionally redundant with the seed.
- **D3** — Pool treasury authority is `[b"pool_treasury"]` PDA. Treasury USDC token account = `ATA(treasury_authority, usdc_mint)`, created at `initialize`. `treasury_authority_bump: u8` cached on `FlightPoolConfig` so PDA-signed CPIs skip `find_program_address` cost.
- **D4** — `set_controller` settable once via `is_controller_set` flag + `has_one = owner` (mirrors Phase 2 D7).
- **D5** — `register_pool` uses strict `init` (NOT `init_if_needed`) — re-registering reverts via PDA collision (Anchor's standard `AccountAlreadyInitialized`).
- **D6** — `add_buyer` uses strict `init` for `BuyerRecord`. Re-purchase by the same buyer reverts via PDA collision. Premium SPL Token transfer is signed by the buyer's signature (which the controller's CPI passes through transitively in Phase 5).
- **D7** — `settle_on_time` **trusts the controller** for the recipient token account: `has_one = controller` gates the ix; controller is honest by construction (Phase 5 validates against `vault_state.vault_token_account`). We do enforce `recipient.mint == config.usdc_mint` to guard against accidental wrong-mint transfers.
- **D8** — `claim` enforces strict `ATA(traveler, usdc_mint)` (Anchor `associated_token::mint = usdc_mint, associated_token::authority = traveler`).
- **D9** — `sweep_expired` is anyone-callable (Signer for fee + post-expiry checks). Idempotent: when `claimed_count == buyer_count`, returns `Ok(())` without state change. No token transfer — only the `recovered_balance` counter on config moves.
- **D10** — `withdraw_recovered` enforces strict `ATA(owner, usdc_mint)`; decrements `recovered_balance`; PDA-signed Transfer.
- **D11** — `FlightPoolError` enum with 15 variants covering auth, length, status, expiry, claim, recovery, and overflow.
- **D12** — Out of scope: owner rotation, refund-before-settlement, treasury rebalancing, on-chain readers, snapshot pruning.
- **D13** — Cargo.toml: `anchor-spl` re-introduced; `init-if-needed` enabled for consistency (not actually used by flight_pool — strict `init` per D5/D6).
- **D14** — Test harness: `bootstrapFlightPool(client)` returns owner + PDAs. `setMockController` lifted into the test file (revisit if Phase 4 needs it elsewhere).
- **D15** — `set_controller` test pattern reused from Phase 2 verbatim.
- **D16 (new)** — Codama maps payload-less Rust enums to plain TS enums (numeric values), NOT `__kind` discriminated unions. Tests assert `pool.status === SettlementStatus.Active`. The `__kind` shape is reserved for tagged unions.
- **D17 (extends Phase 2 D17)** — Reverted txs still occupy their signature slot in LiteSVM. Always `client.svm.expireBlockhash()` between any byte-identical txs, including after a reverted one.

### Files created or modified — final list

**Modified (committed sources):**
- `contracts/programs/flight_pool/src/lib.rs` — full real implementation.
- `contracts/programs/flight_pool/Cargo.toml` — `init-if-needed`, `anchor-spl`, extended `idl-build`.
- `contracts/tests/setup.ts` — added `bootstrapFlightPool` helper + `FLIGHT_POOL_PROGRAM_ADDRESS` re-export.
- `contracts/tests/smoke.test.ts` — `REAL_PROGRAMS` set extended with `'flight_pool'`.
- `spec/progress.md` — Phase 3 row + active-phase pointer.

**Created:**
- `contracts/tests/flight_pool.test.ts` — 16 unit tests covering 4.1–4.16.
- `spec/phases/phase-03-flight-pool-program.md` — this file.

**Regenerated (gitignored):**
- `contracts/target/idl/flight_pool.json` (and 4 others; only flight_pool changed semantically).
- `frontend/src/idl/`, `executor/src/idl/`, `frontend/src/clients/`, `executor/src/clients/`, `contracts/tests/clients/` — synced for all 5 programs.

### Notes for the next phase (Phase 4 — oracle_aggregator_program)

- **Three authority types.** Per `architecture.md` §oracle_aggregator_program: `owner` (initialize, set_authorized_oracle, set_authorized_consumer), `authorized_oracle` (FlightDataFetcher cron — `set_estimated_arrival`, `set_landed`, `set_cancelled`), and `authorized_consumer` (controller PDA — `init_flight_data`, `set_to_be_settled`, `set_settled`). Use `has_one = owner` / `has_one = authorized_oracle` / `has_one = authorized_consumer` on `OracleConfig`. Pattern is the same as flight_pool's `set_controller` once-only flag, but applied twice (`is_consumer_set` for the consumer wiring; `authorized_oracle` is rotatable).
- **`FlightData` PDA seeds.** `[b"flight", flight_id.as_bytes(), &date.to_le_bytes()]` — same shape as flight_pool's `[b"pool", flight_id, date]`. Reuse `MAX_FLIGHT_ID_LEN = 16` (D1 from Phase 3, established in Phase 1).
- **Forward-only state machine.** `FlightStatus` enum has 8 variants: `NotInitiated → Active → {Landed, Cancelled} → ToBeSettled* → Settled`. Implement transition guards via `require!(self.status == ExpectedStatus, ...)` at the top of each setter. Reverse transitions revert.
- **`set_to_be_settled` arg validation.** Takes `new_status: FlightStatus` but must only accept `ToBeSettledOnTime/Delayed/Cancelled`. Validate explicitly — Anchor doesn't constrain enum variants for you.
- **Holds zero funds.** No SPL Token CPIs needed. **Do NOT add `anchor-spl` dependency** — keep the Cargo.toml minimal (just `anchor-lang` with `init-if-needed` if any reactivation is needed; otherwise plain `anchor-lang`). This is the only program in Phases 1–5 that doesn't touch SPL.
- **`init_flight_data`.** Strict `init` on the FlightData PDA (one per flight). Re-init reverts via collision. Same as Phase 3 `register_pool` (D5).
- **Reuse the test harness pattern.** `bootstrapOracleAggregator` returns `{ ownerSigner, configPda, programAddress }`. The "controller" account in oracle's auth model is the `authorized_consumer` — you wire it via a one-shot setter. Use a regular keypair as the mock consumer in unit tests; Phase 5 wires the real controller PDA.
- **Phase 4 ID is canonical** (`EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6`). Don't rotate.
- **`SettlementStatus` enum experience (D16) carries over.** `FlightStatus` is also payload-less → Codama generates a plain TS enum. Assertions: `flightData.status === FlightStatus.Active`.
- **D17 still applies.** Reverted txs occupy their signature slot — `expireBlockhash` between byte-identical txs, including after a revert.

### Known limitations / deferred

- No owner rotation (`set_owner`) — defer to a multisig-handover phase.
- No refund-before-settlement instruction — out of scope; flag if user research surfaces it.
- `claim` after expiry routes through `sweep_expired` (anyone can call); the buyer record stays around as historical state. There's no buyer-driven "I missed the window, refund me" path.
- Surfpool packed-Mint blob in `Surfpool.toml` is still a placeholder. Phase 6 picks this up.
- The `BuyerRecord` PDA persists indefinitely (no close path). Rent stays locked on the buyer who paid for it. A rent-recovery follow-up is a Phase 12 (traveler UI) candidate.
