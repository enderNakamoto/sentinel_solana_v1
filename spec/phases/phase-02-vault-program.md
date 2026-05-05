# Phase 2 — vault_program

Status: complete
Started: 2026-05-04
Completed: 2026-05-04

---

## Goal

Replace the Phase 0 no-op `vault` skeleton with the real capital-pool program: a custom
SPL-token vault that mints **RVS share tokens** to underwriters, tracks an internal
`total_managed_assets` counter (decoupled from the raw token-account balance to defeat
inflation attacks), supports both immediate and FIFO-queued withdrawals, takes daily
share-price snapshots, and exposes controller-only mutators (`increase_locked`,
`decrease_locked`, `send_payout`, `record_premium_income`, `process_withdrawal_queue`,
`snapshot`) that the controller program will CPI in Phase 5. After this phase, the vault
is a self-contained ERC-4626-style capital pool unit-tested in isolation; cross-program
integration with `flight_pool` + `controller` lands in Phases 5–6.

## Dependencies

- **Phase 0** — workspace, IDL/Codama pipeline, mock USDC keypair (`keys/mock-usdc.pubkey`),
  LiteSVM harness in `contracts/tests/setup.ts`.
- **Phase 1** — confirmed Anchor v1 patterns reused here: `init_if_needed` (Pre-work D6),
  optional-account "None" sentinel pattern (Pre-work D7), reader instructions via
  `Result<T>` (Pre-work D5), generated Codama clients written into 3 dirs including
  `contracts/tests/clients/` (Pre-work D8).

No on-chain dependency on `governance`. The vault doesn't read governance terms — terms
flow into the system via controller in Phase 5.

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
- `references/programs/anchor.md` — Anchor v1 patterns: `Mint`/`TokenAccount` constraints, PDA-signed CPIs, `init_if_needed`, `realloc`
- `references/idl-codegen.md` — Anchor IDL → Codama → Kit-client pipeline
- `references/testing.md` — LiteSVM unit-test patterns, sysvar manipulation, packed account seeding
- `references/kit/overview.md` — `@solana/kit` Address, Transaction, signer patterns used by tests
- `references/anchor/migrating-v0.32-to-v1.md` — Anchor v1 idioms (CpiContext::new takes Pubkey, borsh::to_vec, Token::id())
- `references/payments.md` — SPL Token transfer/transfer_checked semantics, ATA construction, decimals discipline (vault deals with USDC = 6 decimals)

### Docs to Fetch

- https://www.anchor-lang.com/docs — Anchor v1 program structure
- https://www.anchor-lang.com/docs/references/account-constraints — `#[account(...)]` reference (init_if_needed, realloc, mint::authority, associated_token, has_one)
- https://www.anchor-lang.com/docs/references/space — Anchor account-space rules (esp. for Vec<...> + realloc)
- https://spl.solana.com/token — SPL Token program reference (Mint, TokenAccount, MintTo, Burn, Transfer)
- https://docs.rs/spl-token/latest/spl_token/state/struct.Mint.html — packed `Mint` layout (for the LiteSVM `setAccount` mock-USDC seed)

### Project Files to Read

- `spec/architecture.md` (universal default) — esp. §vault_program (lines 197–328) and §Authorization patterns
- `spec/dev_steps.md` (universal default) — Phase 2 deliverables + tests (lines 235–276)
- `spec/workflow.md` (universal default) — phase lifecycle
- `MEMORY.md` (universal default) — locked Phase 0 + Phase 1 decisions; Phase 1 program IDs (canonical) and Anchor v1 + Codama patterns to reuse
- `spec/phases/phase-01-governance-program.md` — Phase 1 work log (§D11 optional-account sentinel, §D12 3-output Codama, gen-clients pattern)
- `spec/learn_solana.md` — Soroban-to-Solana sanity check (skim only; vault is closer to standard SPL patterns)
- `contracts/programs/vault/src/lib.rs` — Phase 0 no-op skeleton being replaced
- `contracts/programs/vault/Cargo.toml` — confirm `idl-build` feature still only includes `anchor-lang/idl-build`; this phase ADDS `anchor-spl/idl-build`
- `contracts/programs/governance/src/lib.rs` — Phase 1 reference for `init_if_needed`, error enum, account constraints style
- `contracts/programs/governance/Cargo.toml` — Phase 1 reference for the `init-if-needed` feature flag
- `contracts/tests/setup.ts` — Phase 1 LiteSVM harness with `bootstrapGovernance`, `sendAndDecodeReturnData`, PROGRAMS table; extend with `createMockUsdcMint` + `bootstrapVault`
- `contracts/tests/governance.test.ts` — reference test pattern: fundedSigner, freshFixture, owner-only revert assertions
- `contracts/Anchor.toml` — confirm canonical vault program ID (`3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p`)
- `keys/mock-usdc.pubkey` — canonical mock USDC mint address (will be loaded into LiteSVM in `createMockUsdcMint`)
- `Surfpool.toml` — note: placeholder mock-USDC blob is OUT OF SCOPE for Phase 2 per D9

## Pre-work Notes

> Decisions locked during planning (2026-05-04). The agent must follow these.

### D1 — Account types and PDA seeds (matches architecture.md §vault_program verbatim)

| Account | PDA seeds | Purpose |
|---|---|---|
| `VaultState` | `[b"vault_state"]` | Singleton config + counters; vault PDA is the mint authority + token-account authority. |
| `WithdrawalQueue` | `[b"withdrawal_queue"]` | Singleton FIFO queue with `Vec<WithdrawalRequest>`. Realloc-on-push/pop (D2). |
| `ClaimableBalance` | `[b"claimable", underwriter_pubkey.as_ref()]` | One per underwriter. Pre-init at `request_withdrawal` (D5). |
| `SnapshotRecord` | `[b"snapshot", &day.to_le_bytes()]` | One per day. Created lazily on first `snapshot` call per day (D6). |

**Field decisions:**

- `WithdrawalRequest` adds `claimable: Pubkey` to the architecture's `(owner, shares, timestamp)` tuple. The keeper-side queue drain needs to know which `ClaimableBalance` PDA to credit per request without re-deriving it on-chain (avoids rederivation cost AND lets us pass the right PDA via `remaining_accounts`). The PDA is derivable — it's `find_program_address(&[b"claimable", owner.as_ref()], &program_id)` — but storing it cuts CU and clarifies the consumer contract. Strictly, this is redundant with `owner`; flagging as a deliberate redundancy.
- `VaultState.withdrawal_queue_count: u32` mirrors `withdrawal_queue.requests.len()` — keep both consistent; `count` is for cheap reads without deserializing the queue.
- `last_snapshot_time: i64` (unix seconds) tracks the last day boundary written. `snapshot` is a no-op if `today_day_index() == VaultState::last_day(last_snapshot_time)`.

### D2 — `WithdrawalQueue` realloc on push and pop

- **Push** (`request_withdrawal`): Anchor `realloc = 8 + WithdrawalQueue::INIT_SPACE_FOR(n+1)`, `realloc::payer = caller`, `realloc::zero = false`. The `caller` is the underwriter pushing — they pay incremental rent.
- **Cancel / drain** (`cancel_withdrawal`, `process_withdrawal_queue`): Anchor `realloc` shrinks the account; the freed rent is sent to a refund recipient. For `cancel_withdrawal`, refund the queue-request owner. For `process_withdrawal_queue`, refund to `vault_state` (treat as protocol revenue — minor; alternatively to controller signer keeper, but vault keeps it simpler).
- Initial `WithdrawalQueue` allocation at `initialize` time is `8 + 4 (Vec len prefix) + 1 (bump)` = 13 bytes. Each push adds `sizeof(WithdrawalRequest) = 32 + 8 + 8 + 32 = 80 bytes` (owner + shares + timestamp + claimable).
- Anchor `realloc` requires `mut` on the account and the constraint to be re-evaluated each call. Define a single `RouteRealloc`-style accounts struct per ix that touches the queue.
- **Cancel index validation:** `cancel_withdrawal(queue_index: u32)` reverts if (a) `index >= len`, (b) `queue.requests[index].owner != caller.key()`. Removing an arbitrary index is `requests.swap_remove(index)` (O(1)), but **breaks FIFO ordering** for subsequent drains. Use `requests.remove(index)` (O(n)) to preserve FIFO.

### D3 — Share mint as PDA `[b"share_mint"]` (deterministic)

- Anchor `init` constraint with `seeds = [b"share_mint"]`, `bump`, `mint::decimals = 6`, `mint::authority = vault_state` (PDA), `mint::freeze_authority = vault_state` (or `None`; default to `None` for simplicity unless audit demands a freeze).
- The mint account itself is the PDA — Anchor's `Account<'info, Mint>` with `init` + `seeds` handles both `system_program::create_account` and `spl_token::initialize_mint` in one shot.
- Vault PDA (`vault_state`) signs `MintTo` (deposit) and `Burn` (redeem) via `invoke_signed` with seeds `[b"vault_state", &[ctx.accounts.vault_state.bump]]`.

### D4 — Vault USDC token account: ATA(`vault_state`, `usdc_mint`)

- Anchor `associated_token::mint = usdc_mint`, `associated_token::authority = vault_state`. The ATA is deterministically derivable client-side, no off-chain state required.
- Created at `initialize` time. Vault PDA signs token transfers (out: `redeem`, `send_payout`, `collect`-via-program; in: passive — anyone can transfer USDC to it, and **direct transfers DO NOT mutate `total_managed_assets`** by design (D8)).

### D5 — `ClaimableBalance` lifecycle: pre-init at `request_withdrawal`

- `request_withdrawal(shares)` accounts include the underwriter's `ClaimableBalance` PDA with `init_if_needed`, `seeds = [b"claimable", caller.key().as_ref()]`. Underwriter pays rent. The PDA's `claimable` field is stored in the matching `WithdrawalRequest` (D1).
- Same Phase 1 D4 risk profile: PDA identity is seed-bound (immutable), only mutable state is `amount: u64`, and authentication is the request's owner pubkey. Re-init via `init_if_needed` is benign.
- `process_withdrawal_queue` accesses each request's `ClaimableBalance` via `ctx.remaining_accounts`. The keeper (off-chain) reads the queue, derives the matching PDAs, and passes them as remaining accounts in matching order. The handler iterates `min(queue.requests, free_capital)` and writes via deserialize → mutate → serialize.
- `cancel_withdrawal` does NOT close the `ClaimableBalance` PDA — it just removes the queue request. The PDA persists with its accumulated balance (possibly zero). This is intentional: a user might cancel one request while holding earned claimable from prior settled flights.
- `collect()` debits the `ClaimableBalance` to zero and transfers `amount` USDC to the underwriter's USDC ATA. Reverts if `amount == 0`.

### D6 — `SnapshotRecord` lifecycle: keeper pays per-day

- `snapshot` accounts include the day's `SnapshotRecord` PDA with `init_if_needed`, `seeds = [b"snapshot", &day.to_le_bytes()]`. Day index is `Clock::get()?.unix_timestamp / 86400` (u64).
- `init_if_needed` here is benign — same reasoning as D5 (seed-bound, post-write-once via the no-op-on-same-day guard, scope is just `(day, share_price, bump)`).
- The signer paying rent is whoever initiates the CPI chain. Phase 5 controller's `execute_settlements` will be called by the keeper; rent flows from keeper signer through the chain. For Phase 2 unit tests, we'll call `snapshot` directly with a test signer (the "controller" mock).
- Same-day double-snapshot is a no-op: handler reads `vault_state.last_snapshot_time`, compares day-index to the new day, returns `Ok(())` without write if equal. The `init_if_needed` for `SnapshotRecord` may still create the account on the first same-day call, which is fine (it just stores the share price for that day — idempotent).

### D7 — `set_controller` settable once

- Owner-only via `has_one = owner` on `VaultState`. Reverts when `vault_state.is_controller_set == true`. Mirrors the architecture's stated pattern verbatim.
- Stored value: `controller: Pubkey` is the controller's `ControllerConfig` PDA address (Phase 5 will derive `find_program_address(&[b"controller_config"], &CONTROLLER_PROGRAM_ID)` — for Phase 2 unit tests, we just pass any test pubkey to validate the wiring).
- Controller-only instructions (`increase_locked`, `decrease_locked`, `send_payout`, `record_premium_income`, `process_withdrawal_queue`, `snapshot`) check `has_one = controller` on `VaultState` AND the controller pubkey is `Signer`. In production this is `invoke_signed` from the controller PDA; in Phase 2 tests we'll just sign with a regular keypair set as `controller`.

### D8 — Virtual offset math + internal `total_managed_assets` counter

```
VIRTUAL_SHARES = 1000
VIRTUAL_ASSETS = 1000

shares = floor(usdc_amount * (total_shares + 1000) / (total_managed_assets + 1000))
assets = ceil(shares * (total_managed_assets + 1000) / (total_shares + 1000))
```

- Constants live in `lib.rs` as `pub const VIRTUAL_SHARES: u64 = 1000;` etc.
- `deposit` rounds shares DOWN — `checked_mul` + `checked_div` (integer floor by default). Depositor receives slightly fewer shares.
- `redeem` rounds USDC UP — manually compute ceiling: `(numer + denom - 1) / denom` with checked math. Vault retains slightly more assets.
- All arithmetic goes through `checked_*` / `ok_or(VaultError::Overflow)?`.
- `total_managed_assets` is bumped by `deposit` (+ `usdc_amount`) and `record_premium_income` (+ `amount`); decremented by `redeem` (- `assets_out`), `send_payout` (- `amount`), `process_withdrawal_queue` (- per-request `assets_out`). It is **never** read from the vault token account balance — direct USDC transfers to the vault token account are accounting-invisible by design.
- Total share supply for math: read from the `share_mint` `Mint::supply` field (Anchor `Account<'info, Mint>` exposes it).
- `share_price` (informational) = `(total_managed_assets + VIRTUAL_ASSETS) * 10^6 / (share_supply + VIRTUAL_SHARES)`. Stored on `SnapshotRecord` for daily history.

### D9 — Surfpool mock USDC seeding deferred

- Phase 2 unit tests use LiteSVM ONLY. `setup.ts` adds `createMockUsdcMint(client)` that builds a packed `spl_token::state::Mint` (via `@solana/spl-token` or hand-rolled byte layout) and writes it to the canonical address from `keys/mock-usdc.pubkey` via `client.svm.setAccount`.
- `Surfpool.toml` packed-Mint blob remains a placeholder. Phase 6 (cross-program integration tests on Surfpool) will populate it via `scripts/surfpool-seed.ts` or inline.
- Document this deferral in the work log so Phase 6 picks it up cleanly.

### D10 — Cargo.toml: re-introduce `anchor-spl`

- `programs/vault/Cargo.toml` adds:
  ```toml
  anchor-spl = { workspace = true, features = [] }
  anchor-lang = { workspace = true, features = ["init-if-needed"] }
  ```
- `idl-build` feature becomes `["anchor-lang/idl-build", "anchor-spl/idl-build"]`. Per Phase 0 D9 (locked memory), this is the first phase where `anchor-spl/idl-build` is required, because vault is the first phase actually using SPL.
- Imports: `use anchor_spl::token::{Mint, Token, TokenAccount, MintTo, Burn, Transfer, mint_to, burn, transfer};` (classic SPL Token, NOT `token_interface` — the mock USDC is plain SPL Token, no Token-2022 extensions).
- Per Anchor v1 migration §15, prefer `anchor_spl::token::ID` constants for the token program ID where needed.

### D11 — Custom errors enum

`#[error_code] pub enum VaultError` with at minimum:

- `ControllerAlreadySet`
- `Unauthorized` — generic; specific paths revert with this when caller isn't the configured controller / owner
- `InsufficientFreeCapital` — `redeem` when free_capital < usdc_out
- `InsufficientShares` — `redeem` / `request_withdrawal` when caller's share balance < shares
- `InsufficientLocked` — `decrease_locked` when amount > locked_capital (catches arithmetic bug)
- `QueueIndexOutOfRange` — `cancel_withdrawal`
- `NotRequestOwner` — `cancel_withdrawal`
- `NothingToCollect` — `collect` when claimable.amount == 0
- `Overflow`

### D12 — Out of scope (do not implement)

- Owner rotation (no `transfer_owner` in the architecture).
- Pause / freeze. Defer until audit phase if needed.
- Rate limiting (deposit caps, redemption rate limits). Out of scope.
- ERC-4626 `previewDeposit` / `previewRedeem` view instructions on-chain. Math is reproduced client-side from `VaultState` + `share_mint.supply` data; no need for an on-chain reader (matches architecture's "Read (view helpers — can also be read client-side from account data)" comment).
- Snapshot pruning. Old `SnapshotRecord` PDAs accumulate over time (intentional — daily share-price history). Cleanup is a separate operational concern.

### D13 — Testing posture

- Unit tests live at `contracts/tests/vault.test.ts` and use the LiteSVM harness from Phase 1.
- Extend `setup.ts` with:
  - `createMockUsdcMint(client)` — packs an `spl_token::state::Mint` and seeds it at `keys/mock-usdc.pubkey` via `client.svm.setAccount`.
  - `mintMockUsdcTo(client, ata, amount)` — tops up an ATA (creates if missing) by writing the packed `TokenAccount` directly via `setAccount`. This avoids the chicken-and-egg of needing the mint authority's keypair to do real `MintTo` from outside.
  - `bootstrapVault(client, { usdcMint })` — calls `vault_program.initialize`, returns owner signer + state PDAs (vault_state, withdrawal_queue, share_mint, vault_token_account).
- Use Codama-generated Kit instruction builders from `contracts/tests/clients/vault/`. Same pattern as Phase 1.
- Apply Phase 1 D11 (optional-account "None" sentinel) wherever vault has `Option<Account>` constraints — none expected in vault, but flag it if it crops up.
- Apply Phase 1 D5 (`Result<T>` return shape) IF we add any reader instructions. Default plan is no on-chain readers — share price + free capital are derived client-side.
- Always run `pnpm sync-idl && pnpm gen-clients` before running tests so vault's typed Kit client is fresh.
- `pnpm test:contracts` runs ALL test files including `vault.test.ts` (vitest auto-discovery is already set up post-Phase-1).

### D14 — Inflation attack defense test (4.16 in subtasks)

The classic ERC-4626 inflation attack: a malicious first-depositor (Mallory) deposits 1 unit and receives all shares (since `total_shares == 0`). Mallory then transfers a large USDC amount directly to the vault token account, inflating `total_managed_assets / total_shares`. A subsequent honest depositor (Bob) computes `shares = floor(deposit * (total_shares + V_S) / (total_managed_assets + V_A))` and gets ZERO shares due to integer truncation — their deposit is effectively donated to Mallory.

Our defense:
1. **`total_managed_assets` is internal**, not vault-balance-derived (D8). Mallory's direct transfer doesn't move TMA.
2. **Virtual offset of 1000 shares + 1000 assets** ensures `shares = floor(1 * (0 + 1000) / (0 + 1000)) = 1` for Mallory's first deposit (NOT all shares).

The test:
- Mallory deposits 1 unit USDC → receives 1 share.
- Mallory transfers 1,000,000 USDC directly to the vault token account (e.g. via `setAccount` to top up the ATA).
- Bob deposits 100 USDC → must receive ~100 shares (NOT 0). Specifically: `floor(100 * (1 + 1000) / (1 + 1000)) = 100` shares (TMA stays 1 because direct transfer doesn't touch the counter).

### Open follow-ups (post-phase, do not block)

- `set_owner` / owner rotation. Defer to a multisig-handover phase if needed.
- Optional `pause` / circuit breaker. Audit-driven decision.
- Surfpool seeding of mock USDC (Phase 6 picks this up — D9).
- A `cancel_withdrawal` variant that closes the user's `ClaimableBalance` PDA when the user wants to reclaim rent. Out of scope for Phase 2; could be a Phase 13 (underwriter UI) follow-up if rent recovery becomes a UX concern.

---

## Subtasks

### 1. Program crate

- [x] 1.1 Replace `programs/vault/src/lib.rs` no-op with the real module: `declare_id!` preserved from Phase 1 rotation (`3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p`).
- [x] 1.2 Update `programs/vault/Cargo.toml`: add `anchor-spl = { workspace = true }`, enable `init-if-needed` on `anchor-lang`, set `idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]` (D10).
- [x] 1.3 Define account structs: `VaultState`, `WithdrawalQueue`, `ClaimableBalance`, `SnapshotRecord`, `WithdrawalRequest` (D1).
- [x] 1.4 Define module constants `VIRTUAL_SHARES`, `VIRTUAL_ASSETS`, helper functions for share math (rounded down for deposit, up for redeem) with `checked_*` arithmetic (D8).
- [x] 1.5 Define `VaultError` enum (D11).
- [x] 1.6 Implement `initialize(usdc_mint: Pubkey)` — owner = signer, creates `VaultState`, `WithdrawalQueue` (zero-length Vec, base size), `share_mint` PDA (`mint::authority = vault_state`, decimals 6), and `vault_token_account` ATA(vault_state, usdc_mint).
- [x] 1.7 Implement `set_controller(controller: Pubkey)` — owner-only, settable once (D7).
- [x] 1.8 Implement `deposit(usdc_amount: u64)` — transfers USDC from caller's ATA → vault token account, mints shares to caller's share-mint ATA via PDA-signed CPI, increments TMA (D8).
- [x] 1.9 Implement `redeem(shares: u64)` — burns shares from caller's share-mint ATA, transfers USDC out via PDA-signed CPI, decrements TMA. Caps at `free_capital`; reverts otherwise (D8, D11).
- [x] 1.10 Implement `request_withdrawal(shares: u64)` — verifies caller share balance, pre-inits caller's `ClaimableBalance` PDA, reallocs `WithdrawalQueue` +1 slot, pushes `WithdrawalRequest { owner, shares, timestamp, claimable }`, increments `withdrawal_queue_count` (D2, D5).
- [x] 1.11 Implement `cancel_withdrawal(queue_index: u32)` — validates ownership + range, removes request preserving FIFO order, reallocs queue −1 slot (D2, D11).
- [x] 1.12 Implement `collect()` — transfers `claimable.amount` USDC from vault token account → caller ATA via PDA-signed CPI, zeroes `claimable.amount`. Reverts if amount is 0 (D5, D11).
- [x] 1.13 Implement controller-only `increase_locked(amount: u64)` and `decrease_locked(amount: u64)` — `has_one = controller`, validate Signer, checked arithmetic on `locked_capital`.
- [x] 1.14 Implement controller-only `send_payout(amount: u64)` — validates recipient token account, transfers out via PDA-signed CPI, decrements TMA.
- [x] 1.15 Implement controller-only `record_premium_income(amount: u64)` — increments TMA. No token transfer (the actual USDC arrived earlier into the flight_pool treasury and is forwarded by `flight_pool.settle_on_time`).
- [x] 1.16 Implement controller-only `process_withdrawal_queue()` — iterates requests via `ctx.remaining_accounts` (one `ClaimableBalance` per request, in queue order), credits as `min(free_capital, shares-equivalent assets)` allows, shrinks the queue accordingly. Stops when free_capital exhausted or queue empty (D5).
- [x] 1.17 Implement controller-only `snapshot()` — computes day index from `Clock`, compares to `vault_state.last_snapshot_time`, no-op if same day, otherwise inits `SnapshotRecord` PDA via `init_if_needed`, writes share price, updates `last_snapshot_time` (D6).

### 2. IDL + typed-client bridge

- [x] 2.1 `NO_DNA=1 anchor build` produces a clean binary (no warnings beyond Anchor's standard noise); `pnpm sync-idl` updates `frontend/src/idl/vault.json` and `executor/src/idl/vault.json`.
- [x] 2.2 `pnpm gen-clients` regenerates Codama clients into all 3 dirs (`frontend/`, `executor/`, `contracts/tests/`); `pnpm typecheck` passes across all 3 workspaces.

### 3. Test harness

- [x] 3.1 Extend `contracts/tests/setup.ts` with `createMockUsdcMint(client)` — packs `spl_token::state::Mint` (mint_authority = `mock-usdc-authority.pubkey`, supply 0, decimals 6, is_initialized true, freeze_authority None) and writes via `client.svm.setAccount` at `keys/mock-usdc.pubkey` (D9).
- [x] 3.2 Add `mintMockUsdcTo(client, ownerAddress, amount)` — derives ATA, packs `spl_token::state::Account` with the requested amount + owner, writes via `setAccount`. Used to fund underwriters in tests without needing the mock-USDC mint authority's signature.
- [x] 3.3 Add `bootstrapVault(client)` — calls `vault.initialize`, returns `{ ownerSigner, vaultStatePda, withdrawalQueuePda, shareMintPda, vaultTokenAccount, usdcMint }`.
- [x] 3.4 Add `getShareBalance(client, owner)` and `getUsdcBalance(client, owner)` helpers that read packed `TokenAccount` data and return amounts as `bigint`.

### 4. Unit tests (`contracts/tests/vault.test.ts`)

- [x] 4.1 `initialize` — `VaultState` owner = client.payer, share mint exists with mint authority = `vault_state` PDA, vault token account exists owned by `vault_state` PDA, `WithdrawalQueue` exists with empty Vec, TMA + locked = 0.
- [x] 4.2 `set_controller` — owner-only succeeds; second call reverts with `ControllerAlreadySet`; non-owner reverts with `Unauthorized` / `has_one`.
- [x] 4.3 `deposit` — virtual offset math: 1 USDC → 1 share when TMA=0/supply=0; TMA increments correctly; share-mint supply increases.
- [x] 4.4 Direct USDC transfer to vault token account does NOT change share price — the next `deposit` computes shares using the un-mutated TMA (D14 partial, isolated test).
- [x] 4.5 `redeem` happy path — burns shares, transfers USDC, decrements TMA.
- [x] 4.6 `redeem` reverts when `usdc_out > free_capital` (after a controller calls `increase_locked` to lock most of the pool).
- [x] 4.7 `request_withdrawal` enqueues correctly — `WithdrawalQueue.requests.len()` increments, `withdrawal_queue_count` matches, `ClaimableBalance` PDA created with amount = 0, queue stores claimable PDA address.
- [x] 4.8 `request_withdrawal` reverts when caller share balance < shares (`InsufficientShares`).
- [x] 4.9 `cancel_withdrawal` — non-owner of request reverts with `NotRequestOwner`; owner succeeds; queue length decrements; FIFO order preserved (test by enqueueing 3 requests, cancelling the middle, confirming the remaining 2 stay in original order).
- [x] 4.10 Controller-only revert paths — `increase_locked`, `decrease_locked`, `send_payout`, `record_premium_income`, `process_withdrawal_queue`, `snapshot` ALL revert when caller is not the configured controller (parameterized).
- [x] 4.11 `increase_locked` / `decrease_locked` track `locked_capital` correctly; `decrease_locked(>locked)` reverts with `InsufficientLocked`.
- [x] 4.12 `record_premium_income` increases TMA without moving any tokens.
- [x] 4.13 `send_payout` transfers from vault token account to a mock recipient token account; TMA decrements.
- [x] 4.14 `process_withdrawal_queue` walks FIFO, credits `ClaimableBalance` until free_capital exhausted; partial drains leave residual queue intact.
- [x] 4.15 `collect` transfers claimable amount and zeroes `ClaimableBalance.amount`; reverts with `NothingToCollect` if amount is 0.
- [x] 4.16 `snapshot` writes once per day; second call same day is a no-op (no new `SnapshotRecord` overwrite, `last_snapshot_time` unchanged); advancing the clock by ≥86400 seconds via `advanceClock` lets a new snapshot land on the next day.
- [x] 4.17 **Inflation attack defense (D14)**: Mallory deposits 1 unit → 1 share; Mallory `setAccount`-pumps the vault token account by 1,000,000 USDC; Bob deposits 100 USDC → receives ~100 shares (NOT 0). Assert Bob's share count > 0.

### Gate

All of the following must hold before `/complete-phase 2`:

- [x] `NO_DNA=1 anchor build` succeeds for `vault_program` (clean binary, no warnings).
- [x] `pnpm sync-idl` produces an updated `contracts/target/idl/vault.json`; copies land in `frontend/src/idl/`, `executor/src/idl/`, and `contracts/tests/clients/`.
- [x] `pnpm gen-clients` produces fresh typed Kit clients in all 3 dirs; `pnpm typecheck` passes across all workspaces.
- [x] `pnpm test:contracts` passes (3 smoke + 17 governance + 16 vault = 36/36). One smoke test removed (`vault` no longer Phase-0-shape) — 3 smoke is the new baseline.
- [x] No regression in `governance.test.ts` or `smoke.test.ts`.
- [x] `Anchor.toml` vault program ID unchanged from Phase 1 (`3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p`).
- [x] `programs/vault/Cargo.toml` re-introduces `anchor-spl` cleanly; workspace lockfile not broken.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-04

Starting Phase 2. Lite prime + manifest loaded.

Skills loaded: `solana-dev` (SKILL.md + compatibility-matrix.md + common-errors.md + security.md + programs/anchor.md + payments.md). Other skill refs (idl-codegen.md, testing.md, kit/overview.md, anchor/migrating-v0.32-to-v1.md) carried forward from Phase 1's session in this conversation.

Project files read: README.md, CLAUDE.md, spec/{architecture.md (overview + §vault_program), workflow.md, progress.md, dev_steps.md (Phase 2)}, contracts/{Anchor.toml, Cargo.toml, programs/vault/{src/lib.rs, Cargo.toml}, programs/governance/{src/lib.rs, Cargo.toml}, tests/{setup.ts, governance.test.ts}}, keys/{mock-usdc.pubkey, mock-usdc-authority.pubkey}.

Mock USDC mint: `epYcquLhSzRpNZCYrdhv81J4mHAXHEChxnejTmMp91K`, authority `CzJ5AL4APAggkgGDikJw2GNYScVTdevqbnzntMp7MfGn`.

Notes:
- Phase 1 patterns to reuse: Codama-generated typed Kit builders, `init_if_needed` feature flag, optional-account program-ID-as-None sentinel, `Result<T>` reader-instruction shape (no readers planned for vault per D12), 3-output Codama gen-clients, `freshFixture()` + `fundedSigner()` test helpers.
- Workspace already has `anchor-spl = "1.0.0"` and `solana-program = "^3"` declared in `[workspace.dependencies]` — vault crate just needs to reference them.
- LiteSVM packed-account seeding for mock USDC: use `@solana/spl-token` (already in contracts deps as `^0.4.13`) for `MintLayout` / `AccountLayout` / `MINT_SIZE` / `ACCOUNT_SIZE` to build the byte buffers, then `client.svm.setAccount(addr, ...)` writes them.

Proceeding to subtask group 1 (Cargo.toml wiring + program crate).

#### Implementation log

- **§1 Cargo.toml** — added `anchor-lang = { workspace = true, features = ["init-if-needed"] }` and `anchor-spl = { workspace = true }`; `idl-build` now includes `anchor-spl/idl-build`.
- **§1 program crate** — `programs/vault/src/lib.rs` rewritten end-to-end. Account types, virtual-offset math helpers (floor for deposit, ceil for redeem), `VaultError` enum (20 variants), all 13 instructions including `process_withdrawal_queue` consuming `ctx.remaining_accounts`.
- **D5 refinement (Model B / value-at-request-time)** — initial draft used "shares stay in user wallet, drain prices at current rate." That has a soundness hole: between request and drain, supply/TMA can shift and the user's payout drifts from their fair share. **Refactored to Model B**: `request_withdrawal` (a) snapshots `pending_assets = ceil_redeem(shares)` at current price, (b) burns the user's shares immediately (signed by the user), (c) decrements TMA by `pending_assets`, (d) stores `pending_assets` on the queue request. `cancel_withdrawal` re-mints shares (vault PDA signs) and restores TMA. `process_withdrawal_queue` just credits the recorded `pending_assets` — no re-pricing, no share/TMA mutation. This is documented as **§D15 (refinement of D5)** below.
- **D5 schema** — `WithdrawalRequest` gained `pending_assets: u64`; SIZE bumped from 80 to 88 bytes.
- **§2 IDL + Codama** — `pnpm sync-idl` + `pnpm gen-clients` clean. Codama auto-renamed two PDAs that had different seed sources but the same name: `Claimable` (collect-time) and `RequestWithdrawalClaimable` (request-time). Both produce the same address; tests use `findClaimablePda({ collector: ... })`.
- **§3 test harness** — extended `contracts/tests/setup.ts` with `createMockUsdcMint`, `setTokenAccount`, `mintMockUsdcTo`, `getTokenAccountAmount`, `getAtaAddress`, `bootstrapVault`. SPL Token packed-state authoring via `@solana/spl-token`'s `MintLayout` / `AccountLayout` (web3.js types confined to this file).
- **`advanceClock` fix** — Phase 0 stub used `{ ...cur, unixTimestamp: ... }`. The LiteSVM `Clock` is a napi class with private inner state, so spreading drops it and `setClock` errors with "Failed to recover Clock type from napi value." Fix: mutate the bound property (`cur.unixTimestamp = ...`) and pass the same instance back.
- **`setAccount` shape** — Kit's `LiteSVM.setAccount` takes a single `EncodedAccount` (`{ address, executable, lamports, programAddress, space, data }`), not `(address, info)`. Updated the helpers.
- **§4 unit tests** — `contracts/tests/vault.test.ts` covers all 17 dev_steps test cases in 16 `it()` blocks (4.10/4.11 merged into one parameterised test). All pass.
- **Phase 0 smoke test** — `smoke.test.ts` filter expanded to skip both `governance` AND `vault` (REAL_PROGRAMS set). Other 3 programs still smoke-tested.

#### Test bring-up issues hit and resolved

1. **Snapshot sentinel collision with LiteSVM clock** — used `last_snapshot_time = 0` as the "never snapshotted" sentinel; LiteSVM's default `unix_timestamp = 0` collides. Switched the sentinel to `-1` (i64 supports it). §D6 updated implicitly; documenting as §D16 below.
2. **Duplicate-tx signature on same-day snapshot** — same Phase 1 lesson: identical instruction bytes + identical recent blockhash → identical signature → "transaction already processed". Fixed by `client.svm.expireBlockhash()` before the second-same-day call. (Phase 1's `sendAndDecodeReturnData` did this implicitly; here the test calls `sendTransaction` directly so the test must rotate explicitly.)

#### Final gate result

All subtasks complete. **36/36 tests passing** (3 smoke + 17 governance + 16 vault). Typecheck clean across all 3 workspaces. Build clean. Vault program ID unchanged from Phase 1 (`3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p`). No regressions. Ready for user validation and `/complete-phase 2`.

### Session 2026-05-04 — Completed

Phase validated by user. All gate conditions met. Marking complete.

---

## Files Created / Modified

> Populated by the agent during work.

**Modified:**
- `contracts/programs/vault/src/lib.rs` — full real implementation.
- `contracts/programs/vault/Cargo.toml` — `init-if-needed` feature on `anchor-lang`; added `anchor-spl`; `idl-build` extended.
- `contracts/tests/setup.ts` — added `createMockUsdcMint`, `setTokenAccount`, `mintMockUsdcTo`, `getTokenAccountAmount`, `getAtaAddress`, `bootstrapVault`. Fixed `advanceClock` for napi `Clock` shape.
- `contracts/tests/smoke.test.ts` — `REAL_PROGRAMS` filter now also excludes `vault`.

**Created:**
- `contracts/tests/vault.test.ts` — 16 unit tests covering 4.1–4.17.

**Regenerated (gitignored):**
- `contracts/target/idl/vault.json` (and 4 others; only vault changed semantically).
- `frontend/src/idl/`, `executor/src/idl/`, `frontend/src/clients/`, `executor/src/clients/`, `contracts/tests/clients/` — synced.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase. Populated during work.

D1–D14 above are **locked at planning time** and seed this section. Add new entries below as they arise.

### D15 — Withdrawal queue uses Model B (value-at-request-time, refines D5)

`request_withdrawal` snapshots `pending_assets = ceil_redeem(shares, supply, TMA)` at call time, burns the user's shares, decrements TMA by `pending_assets`, stores `pending_assets` on the queue request. `cancel_withdrawal` re-mints the original `shares` and restores TMA by `pending_assets`. `process_withdrawal_queue` credits the recorded `pending_assets` directly — no re-pricing, no share/TMA mutation at drain time.

This locks in the user's payout value at queue time and prevents inter-request supply/TMA drift from changing what they're owed. It's the analogue of an immediate `redeem` whose final USDC transfer is delayed until free capital is available.

### D16 — `last_snapshot_time = -1` is the never-snapshotted sentinel (refines D6)

Originally used `0` as the sentinel. LiteSVM's default `Clock::unix_timestamp = 0` collides with this — a legitimate first-day snapshot at `t=0` would be indistinguishable from "never snapshotted." Switched to `-1` (i64 supports negatives). `initialize` writes `-1`; the snapshot path checks `if state.last_snapshot_time >= 0` before computing the day index.

### D17 — Phase 0 `advanceClock` helper bug (fixed)

Phase 0 wrote `advanceClock` as `setClock({ ...cur, unixTimestamp: ... })`. LiteSVM's `Clock` is a napi class with private inner state; the spread drops it and the next `setClock` call throws "Failed to recover Clock type from napi value." Phase 2 fixes the helper to mutate the bound property and pass the same instance back. This is a Phase 0 bug surfaced by Phase 2's first user.

### D18 — `setAccount` takes a single `EncodedAccount` argument

The Kit-LiteSVM `LiteSVM.setAccount(account: EncodedAccount)` API takes ONE arg — the account object — not `(address, info)`. The `EncodedAccount` shape is `{ address, executable, lamports, programAddress, space, data }`. The Phase 2 setup helpers conform to this. Documenting so future phases don't re-discover.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.

### What was built

`vault_program` is now a fully functional capital-pool layer. All underwriter USDC sits in a vault PDA-owned ATA. Underwriters mint RVS share tokens (a PDA-keyed SPL Mint) on deposit and burn them on redeem. Two withdrawal paths: immediate `redeem` (capped at `free_capital = TMA - locked`) and FIFO-queued `request_withdrawal` for the locked-capital case. Daily share-price snapshots are recorded by the keeper. Six controller-gated mutators (`increase_locked`, `decrease_locked`, `send_payout`, `record_premium_income`, `process_withdrawal_queue`, `snapshot`) are ready for Phase 5's controller to CPI.

The internal `total_managed_assets` counter is decoupled from the raw token-account balance. Combined with the 1000-virtual-share/asset offset, the program is provably hardened against the ERC-4626 inflation attack (test 4.17 verifies).

### Key decisions locked in (D-numbers map to the phase file's Decisions Made section)

- **D1** — Account types and PDA seeds match `architecture.md` §vault_program verbatim. `WithdrawalRequest` adds `pending_assets: u64` (D15) on top of the architecture's `(owner, shares, timestamp)` plus a `claimable: Pubkey` redundancy field.
- **D2** — `WithdrawalQueue` reallocs on push/pop. Underwriter pays incremental rent. `cancel_withdrawal` uses `Vec::remove` (O(n)) to preserve FIFO order.
- **D3** — Share mint is a PDA `[b"share_mint"]` with `mint::authority = vault_state` (PDA). Deterministic; no off-chain keypair.
- **D4** — Vault USDC token account = `ATA(vault_state, usdc_mint)`. Vault PDA signs all outflow transfers via `invoke_signed`.
- **D5 + D15 (refinement)** — `ClaimableBalance` pre-init at `request_withdrawal`. **Withdrawal queue uses Model B (value-at-request-time)**: `request_withdrawal` snapshots `pending_assets`, burns shares, debits TMA. `cancel_withdrawal` re-mints shares + restores TMA. `process_withdrawal_queue` just credits the recorded `pending_assets` — no re-pricing, no share/TMA mutation. The user's payout value is locked at queue time.
- **D6 + D16 (refinement)** — `SnapshotRecord` per-day; controller signer pays rent. **`last_snapshot_time = -1` is the never-snapshotted sentinel** (LiteSVM's default `unix_timestamp = 0` would collide with `0` as sentinel).
- **D7** — `set_controller` settable once via `is_controller_set` flag + owner check.
- **D8** — Virtual offset math: deposit floors, redeem ceils. All arithmetic is `checked_*` and routed through `VaultError::Overflow`.
- **D9** — Surfpool mock-USDC blob deferred to Phase 6. Phase 2 uses LiteSVM `setAccount`-based seeding only.
- **D10** — `programs/vault/Cargo.toml` re-introduced `anchor-spl` (first phase to need it). `idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]`. Classic SPL Token (no Token-2022 extensions).
- **D11** — `VaultError` enum (20 variants) covers auth, free-capital, share-balance, queue, overflow, mint/account-mismatch, return-data, and snapshot-day error paths.
- **D12** — Out of scope: owner rotation, pause/freeze, rate limits, on-chain readers (math reproduced client-side from `VaultState` + `share_mint.supply`), snapshot pruning.
- **D13** — Tests use Codama-generated typed Kit builders from `contracts/tests/clients/vault/`. No hand-rolled discriminators.
- **D14** — Inflation-attack defense test (4.17) verifies: Mallory deposits 1 → 1 share; pumps vault token account by 1M USDC; Bob's 100-USDC deposit still gets ~100 shares (NOT 0).
- **D17 (Phase 0 helper bug fixed)** — `advanceClock` mutates the napi `Clock` instance in place rather than spreading.
- **D18** — `LiteSVM.setAccount` takes a single `EncodedAccount` arg (`{ address, executable, lamports, programAddress, space, data }`).

### Files created or modified — final list

**Modified (committed sources):**
- `contracts/programs/vault/src/lib.rs` — full real implementation.
- `contracts/programs/vault/Cargo.toml` — `init-if-needed`, `anchor-spl`, extended `idl-build`.
- `contracts/tests/setup.ts` — added `createMockUsdcMint`, `setTokenAccount`, `mintMockUsdcTo`, `getTokenAccountAmount`, `getAtaAddress`, `bootstrapVault`. Fixed `advanceClock` napi shape.
- `contracts/tests/smoke.test.ts` — `REAL_PROGRAMS` filter expanded to skip `vault`.
- `spec/progress.md` — Phase 2 row + active-phase pointer.

**Created:**
- `contracts/tests/vault.test.ts` — 16 unit tests covering 4.1–4.17.
- `spec/phases/phase-02-vault-program.md` — this file.

**Regenerated (gitignored):**
- `contracts/target/idl/vault.json` (and 4 others; only vault changed semantically).
- `frontend/src/idl/`, `executor/src/idl/`, `frontend/src/clients/`, `executor/src/clients/`, `contracts/tests/clients/` — synced for all 5 programs.

### Notes for the next phase (Phase 3 — flight_pool_program)

- **Pool-treasury PDA pattern.** `flight_pool` owns a single `pool_treasury` USDC token account, authority = PDA `[b"pool_treasury"]`. Mirrors vault's pattern: an Anchor `init` of an associated token account with the PDA as authority, and PDA-signed `Transfer` CPIs on outflow. Vault's `send_payout` is the directly analogous instruction to copy.
- **Per-flight liability tracking on `FlightPool` PDAs**, NOT per-flight token accounts (per architecture). Same accounting-counter philosophy as vault's TMA: state lives in PDA fields, not the SPL balance. The vault's "internal counter > raw balance" rationale (D8) carries over.
- **`set_controller` once-only** is shared with vault (D7). Copy the `has_one = owner` + `is_controller_set` flag pattern; same `ControllerAlreadySet` semantics.
- **`BuyerRecord` PDA seeds** (`[b"buyer", pool_pda.as_ref(), buyer_pubkey.as_ref()]`) follow the same per-user PDA pattern as vault's `ClaimableBalance`. No need for a Vec/realloc — one PDA per `(pool, buyer)`.
- **Premium transfer** in `add_buyer` happens via `Transfer` signed by the traveler's signature (passes through CPI from controller — see architecture's "transitive signature" note). No vault-style PDA signature needed for inflows.
- **Phase 3 ID is canonical** (`GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq`). Don't rotate.
- **Reuse the LiteSVM mock-USDC harness** — Phase 2's `createMockUsdcMint` + `mintMockUsdcTo` + `setTokenAccount` are ready to use without modification. The Phase 3 `bootstrapFlightPool` helper just calls `createMockUsdcMint` + `flight_pool.initialize`.
- **Reuse Codama D12 (3-output gen-clients)** — `gen-clients.ts` already writes to `contracts/tests/clients/`. Tests import from there.
- **Anchor v1 idiom reminders:** single-lifetime `Context`, `let _ = (...)` for `#[instruction(...)]`-bound but otherwise-unused args, prefer `Result<T>` over manual `set_return_data` for any reader you write.
- **Cancel-tx idempotency:** if any test issues byte-identical instructions back-to-back, prepend `client.svm.expireBlockhash()` to the second send (D17 lesson, applies project-wide).

### Known limitations / deferred

- No owner rotation (`set_owner`) — defer to a multisig-handover phase.
- No pause / freeze / rate limits — audit-driven decisions.
- `cancel_withdrawal` does NOT close the user's `ClaimableBalance` PDA. That PDA persists with whatever balance was previously credited. Rationale: a user might cancel one queued request while still holding earned claimable from prior settlements. A rent-recovery follow-up is logged as a Phase 13 (underwriter UI) candidate.
- Surfpool packed-Mint blob in `Surfpool.toml` is still a placeholder. Phase 6 (cross-program integration tests on Surfpool) populates it.
- Snapshot pruning is intentionally absent — daily share-price history accumulates as a feature.
