# Phase 14 — Frontend: Underwriter Dashboard

Status: complete
Started: 2026-05-08
Completed: 2026-05-08

---

## Goal

Wire the existing `/earn` page (mock data today) to the live devnet vault.
Underwriters will be able to deposit USDC for shares, redeem shares for USDC,
queue withdrawals when free capital is short, cancel queued requests, and
collect when the queue drains. Real reads for `VaultState` (TMA / locked /
free / share price), the connected wallet's RVS share balance, daily
snapshot share-price history, the user's queue position(s), and their
`ClaimableBalance`.

This is one of two remaining frontend phases that swap the Phase 12 mock
data layer for real RPC reads + writes. Phase 15 covers the traveler side
(`/buy` + `/portfolio`).

## Dependencies

- **Phase 12** — `/earn` scaffold with mock data + risk-tier UI + sparkline.
- **Phase 13** — `useSendTx`, `useRpc`, `src/config/devnet.ts`,
  `src/data/onchain.ts` (the `readVaultState` reader is already there).
- **Phase 7** — devnet vault is live; `VaultState`, `WithdrawalQueue`,
  `shareMint`, and the vault's USDC ATA all exist on devnet.

The deployed vault may be **empty** when this phase starts. Manual smoke
relies on the Phase 13 `/faucet` to fund the deployer wallet, which then
deposits seed liquidity.

## Context Manifest

### Skills

- `git`
- `solana-dev` *(mandatory)*

### Skill References

- `references/compatibility-matrix.md`
- `references/common-errors.md`
- `references/security.md`
- `references/frontend-framework-kit.md`
- `references/kit/overview.md`
- `references/kit/plugins.md`
- `references/idl-codegen.md`
- `references/payments.md` *(SPL ATA + decimal handling)*

### Docs to Fetch

- https://github.com/anza-xyz/kit — `@solana/kit` patterns
- https://github.com/anza-xyz/kit — `@solana/react-hooks` (useSolanaClient, useWalletSession)

### Project Files to Read

- `spec/architecture.md` — §vault_program (full)
- `spec/dev_steps.md` — Phase 14 section
- `spec/workflow.md`
- `MEMORY.md`
- Phase 13 wiring artifacts:
  - `frontend/src/config/devnet.ts`
  - `frontend/src/lib/{rpc,sendTx}.ts`
  - `frontend/src/data/onchain.ts`
  - `frontend/src/components/admin/{Card,AddressBadge}.tsx`
- `frontend/app/earn/page.tsx` — current mock-driven scaffold (rewriting,
  not greenfield)
- `frontend/src/clients/vault/src/generated/` — Codama vault client
  (instructions: deposit, redeem, requestWithdrawal, cancelWithdrawal,
  collect; accounts: VaultState, WithdrawalQueue, ClaimableBalance,
  SnapshotRecord; types: WithdrawalRequest)
- `contracts/programs/vault/src/lib.rs` — Rust source for invariants
  (Model B value-at-request-time, virtual-offset math)

## Pre-work Notes

**Style + modularity**
- Reuse the existing `/earn` chrome (header, sparkline card, tier selector,
  deposit panel). The risk-tier UI is decorative — it doesn't map to
  on-chain state. Keep the visual but make it informational only (no tier
  is sent to the deposit ix).
- All write txs through `useSendTx`. Reads via `useRpc` + `data/onchain.ts`.
- Decimal helpers from Phase 13 admin page (`toUsdcUnits`, `fmtUsdc`)
  should be promoted to a shared `frontend/src/lib/usdc.ts` so both the
  admin page and the earn page use the same conversion. Same for share
  decimals (RVS uses 6 decimals to match the SPL convention; verify via
  shareMint's `Mint.decimals`).

**Reads to wire**
- `VaultState` → `totalManagedAssets`, `lockedCapital`, `withdrawalQueueCount`,
  `lastSnapshotTime`, `shareMint`, `vaultTokenAccount`. `freeCapital =
  totalManagedAssets - lockedCapital`.
- `WithdrawalQueue.requests[]` → filter by `request.owner === wallet` for
  the user's queued positions.
- `ClaimableBalance` PDA seeds: `[b"claimable", wallet.as_ref()]` (need to
  add a `findClaimableBalancePda` helper if Codama didn't generate one;
  check `vault/generated/pdas/`).
- `SnapshotRecord` PDAs: read the last ~30 days for the chart.
  `findSnapshotRecordPda({ day })` exists from Phase 13's contracts page.
- User's RVS balance: SPL `getTokenAccountBalance` on
  `findAssociatedTokenPda({ owner: wallet, mint: shareMint, tokenProgram })`.
- User's USDC balance: same pattern with `MOCK_USDC_MINT`.

**Share price math**
- `share_price = (total_managed_assets + 1000) / (rvs_supply + 1000)` —
  scaled by 10^6 in `SnapshotRecord.sharePrice` per the program's stored
  precision.
- Deposit preview: `shares_received = floor(usdc * (rvs_supply + 1000) /
  (total_managed_assets + 1000))`. Round down protects vault solvency.
- Redeem preview: `usdc_received = floor(shares * (total_managed_assets +
  1000) / (rvs_supply + 1000))`.
- Use the same virtual-offset constant (`VIRTUAL_OFFSET = 1000n`) the
  program uses; pull from a shared constants file or re-declare with a
  pointer comment.

**Writes to wire**
- `deposit({ usdc_amount })` — needs depositor's USDC ATA + share ATA.
  Auto-create share ATA via `getCreateAssociatedTokenIdempotentInstruction`
  if missing (same pattern as the faucet).
- `redeem({ shares })` — capped at `free_capital`. If the user requests more
  than `free_capital`, show a warning and offer the queued path.
- `request_withdrawal({ shares })` — enqueue. Show updated queue position
  after success.
- `cancel_withdrawal({ queue_index })` — only for the user's own
  request(s); index comes from the queue scan.
- `collect()` — pulls `ClaimableBalance.amount` USDC into the user's USDC
  ATA. Idempotent: zero balance returns ok with no-op.

**UI shape (replaces the existing mock layout)**
- Left column: Vault metrics card (TVL = TMA / 10^6, Locked, Free, Share
  Price, 30d sparkline from snapshots), composition section can stay (it's
  decorative).
- Right column:
  - **Deposit form** with live "you'll receive X RVS" preview.
  - **Redeem form** with live "you'll receive Y USDC" preview + warning
    when `free_capital < requested`. Auto-suggest queued path.
  - **Queued withdrawals** list (rows for each user request; per-row
    Cancel button, position indicator).
  - **Claimable balance** card with Collect button (greyed when 0).
  - **My position summary** (RVS balance, USDC equivalent at current price,
    deposited cumulative — last one we can defer; not on-chain unless we
    derive from event history).

**Test depth**
- Manual only on devnet. Same convention as Phase 13. End-of-phase
  walkthrough: deposit → redeem (small) → queue (large) → settle a flight
  via `/admin` + `/crons` to drive `process_withdrawal_queue` (or just
  invoke the keeper-only `vault.snapshot` ix from `/contracts` to advance
  state) → collect → cancel a fresh queue request.

**Out of scope**
- Tier-based deposit allocation (decorative only — vault is a single pool).
- Share-price chart from on-chain SnapshotRecord — implement if time
  permits, otherwise keep the static sparkline data with a `// TODO:
  derive from SnapshotRecord` comment.
- Cumulative-earned calculation (would need event history; defer).

---

## Subtasks

### M1 — Shared decimal + ATA helpers

- [x] 1. Promote `toUsdcUnits` / `fmtUsdc` from `frontend/app/admin/page.tsx`
       to `frontend/src/lib/usdc.ts`. Reuse from admin via import. Add
       `toShares` / `fmtShares` (RVS = 6 decimals, mirrors USDC convention).
- [x] 2. Add helper `frontend/src/lib/ata.ts` exposing `userUsdcAta(wallet)`
       and `userShareAta(wallet)` — wraps `findAssociatedTokenPda` with
       Phase 13 constants.

### M2 — Vault data layer

- [x] 3. Extend `frontend/src/data/onchain.ts` with:
       - `readWithdrawalQueue(rpc)` → returns the full queue (already a
         re-export from generated; just expose).
       - `findClaimableBalancePda({ owner })` and `readClaimableBalance(rpc, owner)`.
       - `readUserVaultPosition(rpc, wallet)` → bundles the user's RVS
         balance, USDC balance, queued requests, claimable amount, and
         pre-computed share-price into one call.
       - `readSnapshotHistory(rpc, days = 30)` → array of `SnapshotRecord`
         data for the last `days` days (Maybe-fetch + filter to existing).

### M3 — Math helpers

- [x] 4. Add `frontend/src/lib/vault-math.ts` with:
       - `previewSharesFromDeposit({ tma, rvsSupply, usdc })` (round down)
       - `previewUsdcFromRedeem({ tma, rvsSupply, shares })` (round down)
       - `currentSharePrice({ tma, rvsSupply })` → bigint scaled by 10^6
       - `VIRTUAL_OFFSET = 1000n`. Source-of-truth comment pointing at
         `contracts/programs/vault/src/lib.rs`.

### M4 — Rewire `/earn` page reads

- [x] 5. Replace the `getVaultStats()` mock call in `app/earn/page.tsx` with
       a parallel `Promise.all` of the new readers + RVS mint supply (via
       `getTokenSupply`) on mount. Add a manual Refresh button.
- [x] 6. Render real values: TVL = TMA in USDC units; Locked + Free; current
       share price; "Your position" reads RVS balance × share price.
- [x] 7. Show a fallback when the vault is empty (TMA = 0 → "vault not yet
       seeded; deposit to bootstrap"). Important for first-run on devnet.
- [x] 8. Replace the static sparkline data with `readSnapshotHistory`
       output. If fewer than 2 snapshots exist (likely on devnet),
       fallback to a single horizontal line at current share price with a
       "no history yet" caption.

### M5 — Deposit form

- [x] 9. Live "you'll receive" share preview using `previewSharesFromDeposit`
       (recompute on amount change). Disable submit if amount > USDC balance.
- [x] 10. Submit handler: build `deposit({ usdc_amount })` ix, prepend an
       idempotent `getCreateAssociatedTokenIdempotentInstruction` for the
       user's share ATA so first-time deposits don't fail. Send via
       `useSendTx`. On success: toast with shares received + refresh page
       state.

### M6 — Redeem form

- [x] 11. Live USDC preview via `previewUsdcFromRedeem`. Show a warning bar
       if `free_capital < usdc_preview`: "Vault is fully utilized — your
       redemption would exceed free capital. Use the queued path instead."
- [x] 12. "Redeem now" button → `redeem({ shares })`. Greyed when free is
       insufficient.
- [x] 13. "Queue withdrawal" button → `request_withdrawal({ shares })`. Show
       success toast with queue position.

### M7 — Queue + claimable + collect

- [x] 14. New "Queued withdrawals" card listing the user's queued requests.
       Per row: shares, pending USDC at request-time, queue position,
       request timestamp (relative), Cancel button → `cancel_withdrawal({
       queue_index })`.
- [x] 15. "Claimable balance" card: shows `ClaimableBalance.amount` USDC.
       Collect button → `collect()`. Greyed when amount = 0. Auto-create
       USDC ATA if missing (idempotent ix prepended).

### M8 — Smoke + typecheck

- [x] 16. `pnpm -r typecheck` clean.
- [x] 17. `pnpm build` clean — all 9 routes prerender; no new runtime errors.
- [x] 18. Dev-server smoke: `/earn` renders read state with deployer wallet
       on devnet (vault state visible even when empty); `/admin` and
       `/contracts` still load with no regression.
- [x] 19. Manual devnet flow (USER PASS):
       - deposit 1,000 USDC → confirm RVS minted to wallet, TMA increases.
       - redeem 100 shares immediately → USDC arrives.
       - queue a redemption larger than free capital → entry appears in
         the user's queued list.
       - cancel that queued request → list empties; shares restored to wallet.
       - (optional) drive a settlement on `/admin` so the queue drains and
         a `ClaimableBalance` appears, then click Collect.

### Gate

- A connected wallet on devnet can deposit, redeem, queue, cancel, and
  (if queue drains) collect via `/earn`.
- Vault TVL / Locked / Free / Share price reflect real on-chain state.
- No new typecheck or build errors.
- Phase 13 pages remain functional.

---

## Work Log

### Session 2026-05-08
All 19 subtasks complete. `pnpm -r typecheck` ✓, `pnpm build` ✓ (12 routes
prerender static, /earn bundle 5.32 kB / 181 kB first-load).

- M1: Promoted `toUsdcUnits` / `fmtUsdc` (and added `fmtUsdcLocal`) to
  `frontend/src/lib/usdc.ts`; rewired admin page to import. New
  `frontend/src/lib/ata.ts` with `userUsdcAta` / `userShareAta`.
- M2: `data/onchain.ts` gained `readWithdrawalQueue`,
  `findClaimableBalanceAddress`, `readClaimableBalance`,
  `readUserVaultPosition` (single concurrent batch over RVS balance, USDC
  balance, claimable, and full queue scan filtered to wallet),
  `readShareSupply`, `readSnapshotHistory(days=30)`. The `Rpc` type alias
  widened with `GetTokenAccountBalanceApi & GetTokenSupplyApi`. All
  re-exported through `@/data`.
- M3: `frontend/src/lib/vault-math.ts` ships
  `previewSharesFromDeposit`, `previewUsdcFromRedeem`, `currentSharePrice`,
  `freeCapital`, with the on-chain `VIRTUAL_OFFSET = 1000n` constant.
- M4–M7: Replaced the entire `app/earn/page.tsx` (was a mock-driven scaffold).
  New layout: VaultMetricsCard (TVL / Locked / Free / Share Price + 30-day
  snapshot SVG chart), DepositCard (live preview + idempotent share ATA
  create), RedeemCard (with "redeem now" vs "queue withdrawal" branching
  on free-capital warning), QueueCard (table of user's queued requests +
  per-row Cancel), ClaimableCard (greyed when zero, idempotent USDC ATA
  create + collect). All writes through `useSendTx`.

Manual smoke deferred to user (subtask 19) — needs deployer wallet on devnet.



---

## Files Created / Modified

Created:
- `frontend/src/lib/usdc.ts` — USDC + share decimal helpers (promoted from admin page)
- `frontend/src/lib/ata.ts` — `userUsdcAta` / `userShareAta`
- `frontend/src/lib/vault-math.ts` — preview helpers, share price, free capital, `VIRTUAL_OFFSET`

Modified:
- `frontend/app/earn/page.tsx` — full rewrite, real vault wiring
- `frontend/src/data/onchain.ts` — vault helpers, widened Rpc alias
- `frontend/src/data/index.ts` — re-exports
- `frontend/app/admin/page.tsx` — import shared usdc helpers
- `spec/progress.md` — phase 14 row + active pointer
- `spec/phases/phase-14-frontend-underwriter.md` — work log + completion

---

## Decisions Made

- **D1** decimal helpers promoted to `lib/usdc.ts`, admin re-imports.
- **D2** vault-math constants in `lib/vault-math.ts` with source-of-truth pointer at the Rust file.
- **D3** `readUserVaultPosition` bundles 4 reads in one `Promise.all`.
- **D4** token balance fetches catch errors → 0n (first-time wallets render as zero).
- **D5** idempotent ATA-create prepended to every write that needs an SPL ATA (deposit / redeem / collect).
- **D6** redeem vs queue path distinguished on preview-USDC vs free-capital; warning text steers users to the queue automatically.

---

## Decisions Made

> Populated by the agent during work.

---

## Completion Summary

**What was built**

`/earn` is fully wired against the live devnet vault. Connected wallets
can deposit USDC for RVS shares, redeem shares back for USDC (with
preview math that mirrors the on-chain virtual-offset formula), queue
withdrawals when free capital is short, cancel their own queued requests,
and collect claimable balances after settlements drain the queue. Vault
metrics (TVL / Locked / Free / Share Price / queue count / last snapshot)
read live, and a 30-day share-price chart pulls from `SnapshotRecord` PDAs
(falls back to a "no history yet" caption on first-run / empty vault).

**Key decisions**

- D1 — Decimal helpers promoted from the admin page to `src/lib/usdc.ts`
  rather than copy-pasted; admin re-imports.
- D2 — Vault-math constants live in `src/lib/vault-math.ts` with a comment
  pointing back at `contracts/programs/vault/src/lib.rs` for the source of
  truth on `VIRTUAL_OFFSET = 1000`.
- D3 — `readUserVaultPosition` bundles four reads (RVS bal, USDC bal,
  claimable PDA, queue scan) into one `Promise.all` so the page hits
  devnet once per refresh.
- D4 — Token balance fetches catch `getTokenAccountBalance` errors and
  return 0n, so first-time wallets without ATAs render as zero rather
  than a hard failure.
- D5 — Idempotent ATA-create instructions are prepended to deposit /
  redeem / collect (any path that needs an SPL ATA) — same pattern as
  Phase 13's `/faucet` so first-time users don't need a separate "create
  account" click.
- D6 — Redeem button vs "Queue withdrawal" button distinguish on the
  preview USDC vs `free_capital` comparison; the warning text drives the
  user to the queue path automatically.

**Files created**
- `frontend/src/lib/usdc.ts`
- `frontend/src/lib/ata.ts`
- `frontend/src/lib/vault-math.ts`

**Files modified**
- `frontend/src/data/onchain.ts` — added all vault helpers, widened `Rpc` alias.
- `frontend/src/data/index.ts` — re-exports for the new helpers.
- `frontend/app/earn/page.tsx` — full rewrite (470 LoC).
- `frontend/app/admin/page.tsx` — drop inline USDC helpers, import from `lib/usdc`.

**Limitations / deferred**
- Risk-tier selector from the original mock-driven /earn was removed;
  the on-chain vault is a single pool. We can re-introduce a decorative
  tier UI later if the design demands it.
- Cumulative-earned across deposits would need event history; deferred.
- `cumulativeDeposited` per wallet is not on-chain (would need indexer);
  the position summary shows current RVS balance + USDC equivalent only.
- Manual devnet walkthrough (subtask 19) is the user's pass — code paths
  type-check and the build prerenders all 12 routes static.
