# Phase 24 — Token-2022 Migration & PUSD Integration

Status: in_progress
Started: 2026-05-10
Completed: —

---

## Goal

Migrate the protocol's stablecoin layer from the classic SPL Token (`TokenkegQ...`)
mock USDC mint to the Token-2022 program (`TokenzQd...`) so the protocol can
accept Palm USD (PUSD, mainnet mint `CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s`)
as its unit of account. This is a CPI/type refactor across the 3 fund-touching
programs (`vault`, `flight_pool`, `controller`) plus matching frontend / executor
/ test-harness updates. After this phase, the same protocol can accept any
6-decimal Token-2022 mint with `MetadataPointer` + `TokenMetadata` extensions
(the exact shape PUSD ships with) — and, transitively, any classic SPL Token
mint, because `token_interface` accepts both.

The on-chain field `usdc_mint: Pubkey` is renamed to `stable_mint: Pubkey`
throughout (state structs, instruction args, error variants, error messages) so
the protocol's vocabulary is no longer USDC-bound. UI strings, env var names,
file names, and TypeScript identifiers follow the same rename (`MOCK_USDC_MINT`
→ `MOCK_PUSD_MINT`, `lib/usdc.ts` → `lib/pusd.ts`, etc.). PUSD is the on-the-
ground stablecoin everywhere a user-facing label appears; `stable_*` is the
generic name where the code abstracts over "the configured 6-decimal stable".

**Devnet posture:** in-place `anchor upgrade` at the existing canonical program
IDs (those memory entries stay valid). To allow fresh `init` of the singleton
PDAs against the new mint, singleton PDA seeds are bumped (`[b"vault_state"]` →
`[b"vault_state_v2"]`, etc.). Old PDAs at the v1 seeds remain orphaned on
devnet but the new bytecode never addresses them.

**Rollback posture:** the safety net is git-only — tag `pre-pusd-migration` at
`a4d513e` and feature branch `phase-24-token2022-pusd`. The on-chain devnet
upgrade is reversible by checking out the tag, rebuilding, and re-upgrading
backwards (the upgrade authority remains the deployer). The orphaned v1 PDAs on
devnet are unreachable from the new code path but are exactly what a rollback
would re-target, so the rollback is "rebuild + re-upgrade + the old PDAs come
back to life unchanged".

## Dependencies

- **Phases 1–6** (5 programs + integration tests) — the protocol the migration
  is operating on. Phase 24 does NOT change protocol semantics; it only changes
  the token program the protocol talks to. All Phase 1–6 invariants must hold
  after migration (vault virtual-offset math, FIFO withdrawal queue, claim
  expiry, recovery pool, snapshots, admin whitelist).
- **Phase 7** (devnet deployment) — the deployer keypair
  `keys/devnet-deployer.json` holds program upgrade authority on all 5
  programs. Required to `anchor upgrade` in-place.
- **Phase 11** (e2e cron validation) — the Surfpool integration tests are the
  primary validation surface for the on-chain side. Must pass post-migration
  with the new mock PUSD Token-2022 mint.
- **Phase 13–15** (frontend) — every page that touches a USDC ATA or balance
  becomes a PUSD ATA / balance. Faucet route must keep minting (Token-2022
  CPI). `pnpm build` clean and `pnpm playwright test` green.
- **Phase 22** (premium agent) — denomination-agnostic, no changes. Returns
  6-decimal base units which apply identically to PUSD.
- **Phase 23** (route repricer cron) — denomination-agnostic, no changes.

**Out of scope this phase (deferred):**
- Multi-asset support (USDC + PUSD side-by-side, mint-as-PDA-seed pattern,
  TopNav toggle). That is a separate phase (~Phase 25) layered on top of this
  one. After Phase 24, the protocol is **single-asset PUSD**.
- Mainnet deployment of PUSD-backed protocol. Devnet only.
- Removing the classic SPL `anchor_spl::token` dep from vault — the vault's
  RVS share mint stays classic SPL (we own it; no extension benefit). This
  means vault keeps both `Token` AND `TokenInterface` Program refs.

## Context Manifest

### Skills
- `solana-dev`
- `git`

### Skill References
- `references/compatibility-matrix.md` — confirm `anchor-spl` Token-2022 feature
  flag + Anchor v1 compatibility.
- `references/common-errors.md` — Token-2022 error mappings (account owner
  mismatch, transfer-fee/hook absence assertions).
- `references/security.md` — agent guardrails W009 (simulate before send),
  W011 (mint authority isolation).
- `references/programs/anchor.md` — Anchor v1 account constraint reference
  (esp. `InterfaceAccount`, `Program<TokenInterface>`).
- `references/idl-codegen.md` — Codama regen flow.
- `references/testing.md` — LiteSVM mock mint setup, Surfpool clone pattern.
- `references/kit/overview.md` — `@solana/kit` + `@solana-program/token-2022`
  ATA derivation patterns.
- `references/frontend-framework-kit.md` — `useSendTx` + Codama builder usage
  (unchanged shape, but inputs differ).
- `references/surfpool/overview.md` — clone-mainnet-account `[[setup]]` blocks.
- `references/surfpool/cheatcodes.md` — `set_account` for writing mint bytes.

### Docs to Fetch
- https://spl.solana.com/token-2022 — Token-2022 program reference, account
  layouts, extension TLV.
- https://spl.solana.com/token-2022/extensions — extension catalog. Relevant
  to confirm: `MetadataPointer`, `TokenMetadata` are inert (no CPI hooks); no
  `TransferFeeConfig`, no `TransferHook`, no `PermanentDelegate` on PUSD.
- https://www.anchor-lang.com/docs/account-types/interface-accounts —
  `InterfaceAccount` + `TokenInterface` reference.
- https://docs.rs/anchor-spl/latest/anchor_spl/token_interface/ —
  `transfer_checked`, `mint_to`, `burn` CPI shapes (`amount` + `decimals`).
- https://github.com/solana-program/token-2022 — Token-2022 source-of-truth.

### Project Files to Read
- `spec/architecture.md` §Program Architecture (the CPI graph this phase
  preserves), §Off-Chain Executor Layer (no changes but must verify the
  agent / cron contracts stay valid).
- `spec/workflow.md` — phase lifecycle.
- `MEMORY.md` — locked decisions, esp. canonical program IDs (UNCHANGED
  post-Phase-24), Phase 0 mock USDC keypair convention.
- `contracts/programs/vault/src/lib.rs` — full file (heaviest refactor;
  RVS-side stays classic SPL, USDC-side becomes `token_interface`).
- `contracts/programs/flight_pool/src/lib.rs` — full file (pool treasury
  becomes Token-2022 ATA; all transfers become `transfer_checked`).
- `contracts/programs/controller/src/lib.rs` — full file (passes
  `InterfaceAccount` through to CPIs; account-struct field types update).
- `contracts/programs/governance/src/lib.rs` — NO CHANGES (asset-agnostic).
- `contracts/programs/oracle_aggregator/src/lib.rs` — NO CHANGES
  (asset-agnostic, no token dep).
- `contracts/tests/setup.ts` — mock mint creation (rewrite for Token-2022).
- `contracts/tests/integration.test.ts` — primary validation suite.
- `Surfpool.toml` — `[[setup]]` block for the seeded mint (rewrite for
  Token-2022).
- `keys/mock-usdc.json` + `keys/mock-usdc.pubkey` — old mock keypair
  (preserved for rollback parity; NEW `keys/mock-pusd.json` generated).
- `deployments/devnet-latest.json` — schema bump (`usdcMint` → `stableMint`,
  new `tokenProgram` field carrying `TokenzQd...`).
- `frontend/src/config/devnet.ts` — `MOCK_USDC_MINT` → `MOCK_PUSD_MINT`.
- `frontend/src/lib/usdc.ts` — rename to `lib/pusd.ts`, math unchanged
  (still 6 decimals).
- `frontend/src/lib/ata.ts` — pass Token-2022 program ID to ATA derivation.
- `frontend/app/api/faucet/mint/route.ts` — rewrite to Token-2022 `mintTo`.
- `frontend/src/data/onchain.ts` — `usdcBalance` → `stableBalance`.
- `frontend/src/lib/vault-math.ts` — no math changes, only field renames.
- `frontend/src/clients/*/` — Codama-regenerated post-IDL-change.
- `executor/src/core/agent_client.ts` — denomination-agnostic; check strings.
- `executor/src/core/solana_client.ts` — `usdcMint` config field rename.
- `scripts/fund-usdc.ts` — rename to `fund-pusd.ts`, Token-2022 mint CPI.
- `scripts/bootstrap-e2e.ts` — Token-2022 ATA creation.

## Pre-work Notes

> Decisions locked from the planning conversation. Treat as hard
> requirements during implementation.

- **Q1 → (b) `stable_mint`** — generic field name, future-proof for multi-
  asset. UI labels stay literal "PUSD" everywhere a user reads them.
- **Q2 → (c) In-place `anchor upgrade`** at the canonical program IDs from
  MEMORY.md. PDA seeds bump (`_v2` suffix) on the SINGLETON accounts
  (`vault_state`, `share_mint`, `flight_pool::config`, `pool_treasury`,
  `controller_config`, `active_flights`). **Per-flight** and **per-buyer**
  PDAs (`flight_pool`, `buyer_record`, `claimable_balance`, `withdrawal_request`,
  `snapshot`) DO NOT bump — their seeds reference the per-instance
  identifiers (`flight_id`, `buyer.key()`, etc.) and they inherit isolation
  transitively from the bumped singletons (a v2 `controller_config` is the
  authority for new flight registrations; old v1 flight PDAs were derived
  against the v1 `controller_config` which is now orphaned).
- **D24-1 — Faucet still works on devnet.** New mock PUSD mint at
  `keys/mock-pusd.json` (NEW keypair; clean break from mock-USDC). Faucet
  authority lives in `keys/mock-pusd-authority.json`. The frontend faucet
  route (`/api/faucet/mint`) is rewritten to use Token-2022's `mintTo` CPI
  (different program ID; same instruction shape). On mainnet (post-hackathon)
  the faucet is gone — real PUSD is acquired from PalmUSD.
- **D24-2 — RVS share mint stays classic SPL Token.** The vault's RVS share
  mint is OUR mint (we control it for share accounting; no benefit from
  Token-2022 extensions). Vault keeps `anchor_spl::token::{Mint, Token,
  TokenAccount, MintTo, Burn}` for RVS-side CPIs AND adds
  `anchor_spl::token_interface::*` for stable-side CPIs. The vault's
  `Accounts` structs hold both `Program<'info, Token>` (for RVS) and
  `Program<'info, TokenInterface>` (for the stable).
- **D24-3 — `transfer_checked` carries decimals.** Every stable-side transfer
  CPI now takes the mint account + decimals. Audit pass: any instruction that
  currently does `token::transfer` without `usdc_mint` in its `Accounts`
  struct gets the mint added. Affected (preliminary): `vault::deposit`,
  `vault::redeem`, `flight_pool::register_pool` (premium-in-from-buyer),
  `flight_pool::claim` (payout-out-to-claimant), `flight_pool::sweep_to_recovery`,
  `flight_pool::collect`. Audit during implementation; this list may grow.
- **D24-4 — Singleton PDA seeds bump rule.** New seeds are byte-equivalent to
  the old seed with a trailing `_v2` (e.g. `b"vault_state_v2"`). Anchor's
  `Pubkey::find_program_address` derives a brand-new PDA. Tests, frontend,
  executor, deployments JSON ALL update in lockstep — there is no
  partial-update intermediate state.
- **D24-5 — Codama regen is mandatory.** Post-program-rebuild, run
  `pnpm sync-idl && pnpm gen-clients` in the root. Generated TS clients in
  `frontend/src/clients/`, `executor/src/clients/`, and
  `contracts/tests/clients/` regenerate. The IDL changes (renamed field,
  Token-2022 program IDs, new mint account in some instructions) propagate.
- **D24-6 — Surfpool seeds clone live PUSD bytes.** A new script
  `scripts/clone-pusd-mainnet.ts` curls a mainnet RPC for the live PUSD
  mint account, writes the base64 blob into `Surfpool.toml`'s `[[setup]]`
  block at the SAME pubkey as on mainnet. This gives surfnet test fidelity
  for the real PUSD shape (correct extensions, correct decimals, correct
  authority). For LiteSVM unit tests, the mock PUSD created in `setup.ts`
  is sufficient (extensions: `MetadataPointer` + `TokenMetadata` only).
- **D24-7 — Rollback procedure.** Documented in MEMORY.md after this phase
  completes; tested before phase close. Recipe:
  1. `git checkout pre-pusd-migration` (jumps to tag at `a4d513e`)
  2. `anchor build` (rebuilds old classic-SPL bytecode)
  3. `anchor upgrade` each program against the canonical program IDs
  4. Re-init the v1 singletons against the mock-USDC mint (the v1 PDAs were
     orphaned but their state still lives on-chain; init will FAIL because
     they're not empty; instead use the live re-init path via the deployer
     which calls a noop owner-gated `verify_config` instruction — N/A in
     practice since the old code never had that. Honest answer: the safest
     "running devnet" rollback is "redeploy v1 PDAs at v3 seeds" — at which
     point we're past the point where in-place rollback is cheaper than just
     reverting in git and accepting the live devnet is broken.).
  Practical rollback ≡ git checkout + frontend dev-server points back at the
  v1 PDA seeds. Live devnet may need re-init at v3 seeds if Phase 24's
  in-place upgrade is being unwound. This complexity is the price of (c).
- **No Stellar/Soroban anywhere.** Confirmed during planning.

---

## Subtasks

### A. Program refactor (vault, flight_pool, controller)

- [x] A1. `anchor_spl::token_interface` imports added to all 3 programs.
      flight_pool drops `anchor_spl::token::*` entirely (purely stable-side).
      vault keeps `anchor_spl::token::*` (subset: `Burn`, `Mint`, `MintTo`,
      `Token`, `TokenAccount`) for RVS share-mint CPIs alongside
      `token_interface::*` for stable. Controller keeps only
      `anchor_spl::token::Mint` (for the `share_mint` typed field on the
      vault.snapshot CPI accounts struct; no direct classic Token CPI).
- [x] A2. `usdc_mint` → `stable_mint` rename applied across vault,
      flight_pool, controller (state structs, instruction args, error
      variants `UsdcMintMismatch` → `StableMintMismatch`, comments where
      relevant). Account name renames: `*_usdc_account` → `*_stable_account`
      for buyer/traveler/owner/depositor/redeemer/collector ATAs.
- [x] A3. vault stable-side accounts migrated to `InterfaceAccount<>` +
      type aliases `Mint2022`/`TokenAccount2022` (= `token_interface::Mint`/
      `token_interface::TokenAccount`). RVS share-mint side stays
      `Account<Mint>`. Two program fields per relevant struct:
      `token_program: Program<Token>` (classic, for share burn/mint) AND
      `stable_token_program: Interface<TokenInterface>` (any, for stable
      `transfer_checked`). Collect / SendPayout drop classic `token_program`
      entirely (no share-side ops).
- [x] A4. flight_pool migrated to `InterfaceAccount<Mint|TokenAccount>` +
      `Interface<TokenInterface>` throughout. All transfers use
      `transfer_checked`. `AddBuyer` + `SettleOnTime` accounts structs
      gained a `stable_mint: InterfaceAccount<Mint>` field
      (D24-3 audit produced exactly these two additions; the other 2
      transfer-bearing structs `Claim`/`WithdrawRecovered` already had
      the mint).
- [x] A5. controller migrated. `BuyInsurance` + `ExecuteSettlements` both
      gained `stable_mint: Box<InterfaceAccount<Mint2022>>` and
      `stable_token_program: Interface<TokenInterface>`. The stable-side
      token accounts (`buyer_stable_account`, `pool_treasury`,
      `vault_token_account`) became `Box<InterfaceAccount<TokenAccount2022>>`.
      CPI call sites updated to forward `stable_mint` to
      `flight_pool.add_buyer`, `flight_pool.settle_on_time`,
      `vault.send_payout`, and to pass `stable_token_program.key()` as the
      Pubkey arg to `CpiContext::new[_with_signer]`.
- [x] A6. `token::transfer` → `token_interface::transfer_checked` at every
      stable CPI site (4 in vault: deposit, redeem, collect, send_payout;
      4 in flight_pool: add_buyer, settle_on_time, claim, withdraw_recovered).
      `mint` field added to each `TransferChecked` struct; `decimals`
      sourced from `ctx.accounts.stable_mint.decimals` and passed to the
      CPI. **Discovered + locked:** Anchor 1.0's `CpiContext::new[_with_signer]`
      takes `Pubkey` (not `AccountInfo`) for the program arg — keep
      `ctx.accounts.token_program.key()` pattern (the existing codebase
      pattern). My initial `.to_account_info()` was wrong; reverted.
- [x] A7. Singleton PDA seeds bumped to `_v2`:
       - vault: `vault_state`, `share_mint`, `withdrawal_queue` → all `_v2`
       - flight_pool: `flight_pool_config`, `pool_treasury` → both `_v2`
       - controller: `controller_config`, `active_flights` → both `_v2`
      Per-flight / per-buyer / per-day / per-claimable PDAs unchanged (they
      transitively inherit isolation via the bumped singletons).
- [x] A8. CPI signer seeds updated to match new singleton seeds across all
      three programs.
- [x] A9. `NO_DNA=1 anchor build` clean (release + idl-build profiles).
      Stack-frame discovery: vault's `Deposit::try_accounts` and
      `Redeem::try_accounts` initially exceeded the 4096-byte BPF stack
      cap by 8 bytes after adding the `Box<InterfaceAccount<Mint2022>>`
      `stable_mint` field. **Fix:** boxed `vault_token_account`,
      `depositor_stable_account`, `depositor_share_account`, and
      `redeemer_*` fields. Build clean after that.
      **Lock (D-Phase24-Stack):** any future field addition to vault's
      Deposit/Redeem must continue to use `Box<>`.
- [x] A10. IDLs regenerated under `contracts/target/idl/` for all 5
      programs. Codama-generated TS clients are NOT yet regenerated —
      that's the first step of Group B (`pnpm sync-idl && pnpm gen-clients`).

### B. Test harness (LiteSVM)

- [x] B1. Mock PUSD keypairs generated. Committed `.pubkey` files:
      - Mint: `F5KjXXvUB9UP24Kky5yUiDGdHdA11Fbp5YHUkV8DRFvE`
      - Authority: `5JbXjGvf2UDtBqbAdQwXr8zDUToDjbnDgaXNFLY1wstD`
      `.json` secrets gitignored per project convention. Old
      `keys/mock-usdc.{json,pubkey}` remain on disk for rollback parity
      (tag `pre-pusd-migration` will reuse them).
- [x] B2. `contracts/tests/setup.ts` rewritten for Token-2022:
       - `createMockPusdMint()` packs a base Token-2022 mint at
         `TOKEN_2022_PROGRAM_ID_KIT` (D-Phase24-MintBytes: the 82-byte base-
         mint layout is identical for classic SPL and Token-2022; what makes
         it Token-2022 is the owner program. Extensions deferred — real
         PUSD has `MetadataPointer`+`TokenMetadata` only, but those are inert
         for transfer flows. Surfpool can later clone real-mainnet bytes for
         extension fidelity per §E3.)
       - `setTokenAccount()` takes optional `tokenProgram` arg — defaults
         to classic SPL (correct for the RVS share mint) — and routes
         `getAssociatedTokenAddressSync` through the right program for ATA
         derivation.
       - `mintMockPusdTo()` always uses `TOKEN_2022_PROGRAM_ID_KIT`.
       - `getAtaAddress()` gained an optional `tokenProgram` arg + a
         convenience wrapper `getPusdAta(owner)`.
       - `bootstrapVault()` passes `stableTokenProgram:
         TOKEN_2022_PROGRAM_ID_KIT` and derives `vaultTokenAccount` via the
         Token-2022 ATA path.
       - `bootstrapFlightPool()` passes `tokenProgram:
         TOKEN_2022_PROGRAM_ID_KIT` (flight_pool uses a single token-
         interface field, no separate classic + stable).
       - `simulateSettler()` passes `stableMint: ctrl.vault.stableMint` and
         `stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT` (replaced the
         vestigial classic `tokenProgram` arg).
       - `depositToVault()` wires `stableMint` + `stableTokenProgram`.
       - `TOKEN_2022_PROGRAM_ID_KIT` exported so tests can reference it
         directly at ix call sites.
       - `makeClient()` calls `client.svm.withDefaultPrograms()` so the
         LiteSVM instance has SPL Token + Token-2022 + ATA + memo loaded.
- [x] B3. `PROGRAMS` table unchanged (canonical IDs preserved per Group A).
      Codama clients regenerated across all 3 (actually 4) workspaces:
      `frontend/src/clients/`, `executor/src/clients/`,
      `contracts/tests/clients/`, `scripts/clients/`. IDLs synced via
      `pnpm sync-idl && pnpm gen-clients`. Generated TS reflects new field
      names (`stableMint`, `stableTokenProgram`) + new account fields on
      Deposit/Redeem/Collect/SendPayout/AddBuyer/SettleOnTime/BuyInsurance/
      ExecuteSettlements.
- [~] B4. vault unit tests — partial.
      Bulk renames applied across `vault.test.ts` (`depositorUsdcAccount`
      → `depositorStableAccount`, etc.). Targeted Edits added `stableMint`
      + `stableTokenProgram` after every Deposit/Redeem/Collect anchor line.
      `pnpm typecheck` clean. **Runtime status:** subset passes; the rest
      fail at fixture setup (see B-blocker below).
- [~] B5. flight_pool unit tests — same status as B4.
- [~] B6. controller unit tests — same status as B4.
- [~] B7. integration tests — same status as B4. Bulk-renamed + ix-arg-
      fixed across `integration.test.ts`,
      `integration/full-flow-deployed.test.ts`,
      `integration/e2e-with-crons-deployed.test.ts`.
- [~] B8. **Suite runtime status: 53/88 LiteSVM tests pass; 35 fail.**
      All 35 failures share the same root cause: `bootstrapFlightPool` →
      flight_pool.initialize fails with
      `An account required by the instruction is missing (instruction #1)`.
      Symptoms point to the Anchor `associated_token::*` constraint
      creating the pool_treasury ATA against a Token-2022 mint — the
      inner ATA-program CPI cannot resolve a required account. Adding
      `client.svm.withDefaultPrograms()` to `makeClient` (so SPL Token +
      Token-2022 + ATA programs are in the SVM) did NOT resolve the
      failure.

      **B-blocker (D-Phase24-AtaInit):** untriaged. Hypothesis stack:
      (1) Anchor's `Interface<TokenInterface>` may not propagate the
      runtime-resolved token program ID into the `associated_token::*`
      ATA-creation CPI; an explicit `associated_token::token_program =
      stable_token_program` constraint on the `pool_treasury` field in
      flight_pool's `Initialize` struct may fix it.
      (2) LiteSVM 1.0's `withDefaultPrograms()` may not actually load the
      Token-2022 program in this version; an explicit
      `addProgramFromFile()` for `TokenzQd...` may be needed.
      (3) The regenerated `findTreasuryAuthorityPda` could be using the
      wrong seed — a quick check that the PDA address matches what the
      program expects would confirm.

      Next session work: triage hypothesis (1) first by inspecting the
      built program's account meta order for `flight_pool.initialize`,
      then add the explicit `associated_token::token_program` constraint
      if absent. Re-run the test suite and iterate.

### C. Frontend

- [ ] C1. Rename file `frontend/src/lib/usdc.ts` → `frontend/src/lib/pusd.ts`.
      Update all imports project-wide. Math unchanged.
- [ ] C2. Update `frontend/src/config/devnet.ts`:
       - `MOCK_USDC_MINT` → `MOCK_PUSD_MINT` (set to new mock-pusd pubkey)
       - `MOCK_USDC_AUTHORITY` → `MOCK_PUSD_AUTHORITY`
       - Add `STABLE_TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ADDRESS`
       - Add live-PUSD mainnet pubkey constant (for surfpool fork tests)
- [ ] C3. Update `frontend/src/lib/ata.ts`:
       - Rename `userUsdcAta` → `userStableAta`
       - Pass `STABLE_TOKEN_PROGRAM` to `findAssociatedTokenPda` calls
- [ ] C4. Update `frontend/src/data/onchain.ts`:
       - `usdcBalance` → `stableBalance`, query against PUSD mint
       - `readUserVaultPosition` and friends — update field names
- [ ] C5. Update `frontend/src/lib/vault-math.ts` — field renames only,
      no math changes (`VIRTUAL_OFFSET = 1000n` unchanged).
- [ ] C6. Rewrite `frontend/app/api/faucet/mint/route.ts`:
       - Import Token-2022 program ID
       - Build `mintTo` instruction via Token-2022 (different program ID,
         same instruction layout)
       - Idempotent ATA-create prepended (already pattern, must use
         Token-2022 ATA derivation)
       - Mints from `MOCK_PUSD_AUTHORITY` keypair (loaded from
         `keys/mock-pusd-authority.json` via the env loader)
- [ ] C7. Update UI strings: every "USDC" in pages/components becomes
      "PUSD". This includes labels in `/buy`, `/earn`, `/portfolio`,
      `/faucet`, `/admin`, `/markets`. BottomNav badge labels too.
- [ ] C8. Regenerated Codama clients land in `frontend/src/clients/`.
      Verify field names changed (e.g. `account.stableMint` everywhere
      `account.usdcMint` was).
- [ ] C9. `pnpm -C frontend typecheck` clean. `pnpm -C frontend build`
      clean.

### D. Executor / cron

- [ ] D1. Update `executor/src/core/solana_client.ts` — `usdcMint` config
      field → `stableMint`. The config loader reads the renamed field
      from `deployments/devnet-latest.json`.
- [ ] D2. Update `executor/src/core/agent_client.ts` — no math changes
      (still `round(usdc * 1_000_000)` for base units). Audit string
      labels.
- [ ] D3. Regenerated Codama clients land in `executor/src/clients/`.
      All cron entry points (`runFetcherOnce`, `runClassifierOnce`,
      `runSettlerOnce`, `runRepricerOnce`) must typecheck against the
      regenerated builders.
- [ ] D4. Run `executor` unit tests (77 baseline from Phase 11). Fix until
      green.
- [ ] D5. `pnpm -C executor typecheck` clean. `pnpm -C executor build`
      clean.

### E. Surfpool + scripts + deployments artifact

- [ ] E1. Rename `scripts/fund-usdc.ts` → `scripts/fund-pusd.ts`. Rewrite to
      use Token-2022 `mintTo`. Read keypair from `keys/mock-pusd-authority.json`.
- [ ] E2. Update `scripts/bootstrap-e2e.ts` — Token-2022 mint pubkey,
      Token-2022 ATA derivation.
- [ ] E3. New `scripts/clone-pusd-mainnet.ts` — `solana account
      CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s --url mainnet-beta
      --output json`, write the base64 account data + owner into a
      `[[setup]]` block in `Surfpool.toml` (overwrite the existing mock
      USDC block) at the SAME pubkey as mainnet. Document the script in
      its top-comment for future regeneration.
- [ ] E4. Update `Surfpool.toml`:
       - Replace mock USDC `[[setup]]` block with the real-mainnet PUSD
         clone (or the local mock PUSD for tests that don't need fidelity)
       - Add `[[setup]]` blocks for pre-funded ATAs at test wallets
         (deployer, keeper, oracle, test buyers)
- [ ] E5. Update `deployments/devnet-latest.json` schema (will be written
      by re-init flow in section F):
       - Rename `usdcMint` → `stableMint`
       - Add `stableTokenProgram: "TokenzQd..."` field
       - Update PDA addresses for the v2 singletons

### F. Devnet upgrade

- [ ] F1. Pre-flight: deployer balance check (must have ≥ 1 SOL for upgrade
      + init costs; current is 3.78 SOL per MEMORY.md — sufficient).
- [ ] F2. `anchor upgrade` each of the 3 changed programs (vault,
      flight_pool, controller) against canonical program IDs from
      Anchor.toml `[programs.devnet]`. Governance and oracle_aggregator
      are unchanged (no upgrade needed). Show each upgrade tx signature
      to the user before submission (W009 / explicit confirmation).
- [ ] F3. Init script: fresh init of the v2 singletons against the new
      mock PUSD mint on devnet. Order:
       1. `vault.initialize(stable_mint = MOCK_PUSD)` → creates
          `vault_state_v2`, `share_mint_v2`
       2. `flight_pool.initialize(stable_mint = MOCK_PUSD)` → creates
          `config_v2`, `pool_treasury_v2`
       3. `controller.initialize({ stable_mint = MOCK_PUSD, ...refs })` →
          creates `controller_config_v2`, `active_flights_v2`
- [ ] F4. Mint test PUSD to deployer wallet via the new `fund-pusd.ts`
      (1000 PUSD initial bag, mints to deployer ATA at PUSD pubkey).
- [ ] F5. Write the resulting v2 PDA addresses + new mint pubkey into
      `deployments/devnet-latest.json` (gitignored; the README's "Live
      deployments" section is also updated with the new addresses in
      F-final).
- [ ] F6. Smoke test from the deployer keypair (CLI script, not
      frontend):
       - Whitelist a test route (via governance — unchanged, still works)
       - Deposit 100 PUSD to vault (Token-2022 ATA → vault stable ATA,
         RVS minted to depositor)
       - Set flight data for `AA100` to ToBeSettled.OnTime via the
         oracle keeper
       - Buy insurance (controller.buy_insurance — heaviest CPI; this is
         the integration acid test on chain)
       - Execute settlement (controller.execute_settlements with n=1)
       - Verify: vault.total_managed_assets matches PUSD balance, no
         orphaned lamports, no failed CPIs in tx logs.

### G. Frontend e2e validation

- [ ] G1. `pnpm -C frontend dev` against the new devnet deployment
      (`NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com`,
      regenerated `frontend/src/config/devnet.ts`).
- [ ] G2. Connect wallet via Wallet Standard, navigate to `/faucet`,
      click "Mint PUSD". Verify the tx succeeds and PUSD balance updates.
      This is the user-facing acceptance criterion the user called out.
- [ ] G3. Walk the full happy path in the browser: `/admin` (verify route
      is whitelisted) → `/earn` (deposit, redeem) → `/buy` (purchase
      insurance) → `/portfolio` (view BuyerRecord). Every page renders
      "PUSD" everywhere it previously rendered "USDC".
- [ ] G4. Run the Playwright e2e suite (`pnpm -C frontend test:e2e`).
      Fix anything that needed renaming. The `cronTick.ts` helper imports
      `MOCK_USDC_MINT` — must update to `MOCK_PUSD_MINT`.

### H. Documentation + rollback validation

- [ ] H1. Save MEMORY.md memory file `phase24_rollback.md`:
       - Exact `git checkout pre-pusd-migration` recipe
       - How to re-upgrade backwards if devnet rollback is needed
       - Note on orphaned v1 PDAs (cosmetic; new code never reaches them)
- [ ] H2. Update MEMORY.md index entry — Phase 24 status, new mock PUSD
      mint pubkey, v2 PDA seed scheme. Keep entry to one line under
      ~200 chars per the MEMORY.md guidelines.
- [ ] H3. Update `README.md` PUSD section: replace any "mock USDC"
      references with "mock PUSD"; document the live PUSD mint pubkey;
      document the rollback recipe in the "Tests" section appendix.
- [ ] H4. Update `spec/architecture.md` §Program Architecture token notes:
      mention Token-2022 + `token_interface` as the stable-side standard.
- [ ] H5. **Rollback dry-run** (final validation): on a throwaway worktree
      or clean clone, `git checkout pre-pusd-migration && anchor build`.
      Verify the old bytecode builds clean. Do NOT actually upgrade devnet
      backwards — that's a real action reserved for the user. Confirm
      the build success in the work log.

### Gate

All of the following must be true before `/complete-phase 24`:

- All 88+ on-chain tests green (vault 16, flight_pool 16, controller 10,
  governance 17, oracle_aggregator 19, integration 9 — 87 minimum; the
  exact count may grow with new Token-2022 assertions).
- All 77+ executor unit tests green (Phase 11 baseline).
- `pnpm -r typecheck` clean across all 3 TS workspaces.
- `pnpm -C frontend build` produces a clean static export (12 routes).
- Frontend faucet mints mock PUSD on devnet; user clicks the button and
  sees their PUSD balance increase (manually validated).
- Full happy path (whitelist → deposit → buy → settle → claim) works on
  devnet at the v2 PDAs with mock PUSD.
- Rollback dry-run logged in the work log: `git checkout pre-pusd-migration
  && anchor build` builds clean.
- MEMORY.md updated with Phase 24 status + rollback memory.

---

## Work Log

> Populated by the agent during work. Do not edit manually.

### Session 2026-05-10

Starting phase. Lite prime complete. Context manifest loaded:
- Skills loaded: `solana-dev` (SKILL.md + security.md baseline).
- Project files read: `README.md`, `CLAUDE.md`, `spec/architecture.md` top, `spec/workflow.md`, `spec/progress.md`, all 3 fund-touching program sources (`contracts/programs/{vault,flight_pool,controller}/src/lib.rs`), `contracts/programs/{vault,flight_pool,controller}/Cargo.toml`, `contracts/tests/setup.ts`, `frontend/app/api/faucet/mint/route.ts`, `frontend/src/config/devnet.ts`, `frontend/src/lib/{ata,usdc}.ts`.
- Docs to fetch deferred — Token-2022 patterns are well documented in `security.md` §§10-18; will fetch on demand if needed.

**Baseline confirmed:** `NO_DNA=1 anchor build` on `phase-24-token2022-pusd` branch (tag `pre-pusd-migration` at `a4d513e`) builds clean. Refactor starts from green state.

**Strategic ordering decision (D-Phase24-StratOrd):** Refactoring programs in order `flight_pool` → `vault` → `controller`. Reasons:
- `flight_pool` is smallest (779 lines) AND purely stable-side (no classic SPL mixed in) → validates the `token_interface::*` pattern with minimum complexity.
- `vault` mixes classic SPL (RVS share mint, `MintTo`/`Burn`) with `token_interface` (stable side, `TransferChecked`) — applies learnings from flight_pool.
- `controller` is a typed passthrough; its CPI account struct types must match vault/flight_pool's new shapes, so it's the natural last step.

**Pre-flight Cargo.toml inventory:**
- `vault/Cargo.toml`, `flight_pool/Cargo.toml`, `controller/Cargo.toml` all already depend on `anchor-spl = { workspace = true }`. `anchor_spl::token_interface` is part of the crate's default API surface (no feature flag needed). No Cargo.toml changes required for the refactor itself.

**Group A complete (2026-05-10).** All 5 programs compile clean under
`NO_DNA=1 anchor build`; IDLs regenerated; `.so` artifacts written to
`contracts/target/deploy/`. Key in-flight discoveries logged as
D-Phase24-Stack (vault Deposit/Redeem stack frame requires Box<> on the
new InterfaceAccount fields) and the Anchor 1.0 `CpiContext::new` signature
note (takes `Pubkey`, not `AccountInfo`). Ready to proceed to Group B
(test harness + Codama client regen) in the next working session.

**Session 2026-05-10 → 2026-05-11 (partial Group B).** Mock PUSD keypairs
generated. setup.ts rewritten for Token-2022 (mint packed at Token-2022
program ID; ATA derivation routes through Token-2022; bootstrap helpers
pass `stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT`). Codama clients
regenerated across 4 workspaces. Bulk renames + manual ix-arg additions
applied across 11 source files (test + executor + scripts). `pnpm
typecheck` clean across contracts workspace.

**Runtime status at end of session: 53/88 LiteSVM tests pass.** All 35
failures share the same root cause at the test-fixture setup step
(bootstrapFlightPool → flight_pool.initialize → ATA-create inner CPI
"missing account"). Logged as **D-Phase24-AtaInit** in the B8 subtask
above with a 3-hypothesis triage plan for the next session. Group B is
**~75% done** by file coverage but blocked on this single runtime issue
that gates the remaining 35 tests.





## Files Created / Modified

> Populated by the agent during work.

---

## Decisions Made

> Key architectural or implementation decisions locked in during this phase.
> Populated during work.

---

## Completion Summary

> Populated by /complete-phase. Do not edit manually.
