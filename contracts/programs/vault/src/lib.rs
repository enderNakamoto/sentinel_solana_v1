//! Sentinel — vault program.
//!
//! The capital-pool layer. Underwriters deposit USDC and receive RVS share
//! tokens (custom SPL Token mint). The vault tracks an internal
//! `total_managed_assets` counter decoupled from the raw token-account
//! balance — direct USDC transfers to the vault token account do NOT mutate
//! TMA, defeating the classic ERC-4626 inflation attack alongside the 1000
//! virtual-share/asset offset.
//!
//! Two withdrawal paths:
//!  - `redeem` — immediate, capped at `free_capital = TMA - locked_capital`.
//!  - `request_withdrawal` — FIFO queue for locked capital. The controller
//!    drains the queue after each settlement via `process_withdrawal_queue`,
//!    crediting per-underwriter `ClaimableBalance` PDAs that the user
//!    `collect`s.
//!
//! Controller-only mutators (`increase_locked`, `decrease_locked`,
//! `send_payout`, `record_premium_income`, `process_withdrawal_queue`,
//! `snapshot`) are gated by `has_one = controller` and a `Signer` check.
//! Phase 5 will wire the controller PDA to call these via `invoke_signed`.
//!
//! See `spec/architecture.md` §vault_program and
//! `spec/phases/phase-02-vault-program.md` for locked decisions D1–D14.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{
    self, Burn, Mint, MintTo, Token, TokenAccount, Transfer,
};

declare_id!("3yzuTtfGYUBsdhXf4QGeq9MUGj5RDNLj3hFPtsWGkj8p");

// ─── Constants ────────────────────────────────────────────────────────────
// Virtual offset (D8). 1000 virtual shares + 1000 virtual assets. Together
// with the internal-counter TMA (D8), prevents the ERC-4626 inflation
// attack. Matches `spec/architecture.md` §vault_program verbatim.
pub const VIRTUAL_SHARES: u64 = 1000;
pub const VIRTUAL_ASSETS: u64 = 1000;

// Daily snapshot bucketing. `Clock::get()?.unix_timestamp / SECONDS_PER_DAY`
// gives an unsigned day index suitable for the `SnapshotRecord` PDA seed.
pub const SECONDS_PER_DAY: i64 = 86_400;

// Share-price scaling factor for the daily snapshot record. Matches
// architecture.md ("scaled by 10^6 for precision").
pub const SHARE_PRICE_SCALE: u128 = 1_000_000;

#[program]
pub mod vault {
    use super::*;

    // ─── Initialization ─────────────────────────────────────────────

    /// Owner-only. Creates `VaultState`, `WithdrawalQueue` (empty),
    /// `share_mint` PDA, and the vault USDC ATA. Mint authority + token
    /// account authority is the `vault_state` PDA itself.
    pub fn initialize(ctx: Context<Initialize>, usdc_mint: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.usdc_mint.key(),
            usdc_mint,
            VaultError::UsdcMintMismatch
        );

        let state = &mut ctx.accounts.vault_state;
        state.owner = ctx.accounts.owner.key();
        state.controller = Pubkey::default();
        state.usdc_mint = usdc_mint;
        state.share_mint = ctx.accounts.share_mint.key();
        state.vault_token_account = ctx.accounts.vault_token_account.key();
        state.total_managed_assets = 0;
        state.locked_capital = 0;
        // Sentinel: `-1` means "never snapshotted". We avoid `0` because
        // LiteSVM's default Clock starts at unix_timestamp = 0, which is a
        // legitimate value the snapshot path could see in tests.
        state.last_snapshot_time = -1;
        state.withdrawal_queue_count = 0;
        state.is_controller_set = false;
        state.bump = ctx.bumps.vault_state;

        let queue = &mut ctx.accounts.withdrawal_queue;
        queue.requests = Vec::new();
        queue.bump = ctx.bumps.withdrawal_queue;

        Ok(())
    }

    /// Owner-only. Settable once. Stores the controller's `ControllerConfig`
    /// PDA address. Future controller-gated instructions enforce
    /// `has_one = controller` against this field.
    pub fn set_controller(ctx: Context<SetController>, controller: Pubkey) -> Result<()> {
        let state = &mut ctx.accounts.vault_state;
        require!(!state.is_controller_set, VaultError::ControllerAlreadySet);
        state.controller = controller;
        state.is_controller_set = true;
        Ok(())
    }

    // ─── Underwriter operations ─────────────────────────────────────

    /// Transfers USDC from the depositor → vault token account, mints RVS
    /// shares to the depositor's share-mint ATA. Shares rounded DOWN.
    pub fn deposit(ctx: Context<Deposit>, usdc_amount: u64) -> Result<()> {
        require!(usdc_amount > 0, VaultError::ZeroAmount);

        // 1. Pull USDC from depositor's ATA into the vault token account.
        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_usdc_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts),
            usdc_amount,
        )?;

        // 2. Compute shares using the virtual offset (rounds DOWN).
        let total_shares = ctx.accounts.share_mint.supply;
        let shares_to_mint = compute_shares_for_deposit(
            usdc_amount,
            total_shares,
            ctx.accounts.vault_state.total_managed_assets,
        )?;
        require!(shares_to_mint > 0, VaultError::ZeroShares);

        // 3. Mint shares to the depositor's share ATA, signed by the
        //    `vault_state` PDA (the mint authority).
        let bump = ctx.accounts.vault_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault_state", &[bump]]];
        let cpi_accounts = MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.depositor_share_account.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                cpi_accounts,
                signer_seeds,
            ),
            shares_to_mint,
        )?;

        // 4. Bump the internal TMA counter (NOT the raw vault balance).
        let state = &mut ctx.accounts.vault_state;
        state.total_managed_assets = state
            .total_managed_assets
            .checked_add(usdc_amount)
            .ok_or(VaultError::Overflow)?;

        Ok(())
    }

    /// Burns RVS shares, transfers USDC out. Capped at `free_capital`.
    /// Reverts with `InsufficientFreeCapital` otherwise. USDC out is
    /// rounded UP (vault retains rounding).
    pub fn redeem(ctx: Context<Redeem>, shares: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroAmount);

        let state = &ctx.accounts.vault_state;
        let total_shares = ctx.accounts.share_mint.supply;
        let usdc_out = compute_assets_for_redeem(shares, total_shares, state.total_managed_assets)?;

        let free_capital = state
            .total_managed_assets
            .checked_sub(state.locked_capital)
            .ok_or(VaultError::Overflow)?;
        require!(usdc_out <= free_capital, VaultError::InsufficientFreeCapital);

        // 1. Burn shares from caller's ATA. Burn is signed by the share
        //    holder, NOT the vault PDA.
        let cpi_accounts = Burn {
            mint: ctx.accounts.share_mint.to_account_info(),
            from: ctx.accounts.redeemer_share_account.to_account_info(),
            authority: ctx.accounts.redeemer.to_account_info(),
        };
        token::burn(
            CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts),
            shares,
        )?;

        // 2. Transfer USDC out, signed by vault PDA.
        let bump = ctx.accounts.vault_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault_state", &[bump]]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.redeemer_usdc_account.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                cpi_accounts,
                signer_seeds,
            ),
            usdc_out,
        )?;

        // 3. Decrement TMA.
        let state = &mut ctx.accounts.vault_state;
        state.total_managed_assets = state
            .total_managed_assets
            .checked_sub(usdc_out)
            .ok_or(VaultError::Overflow)?;

        Ok(())
    }

    /// Enqueues a queued withdrawal. Burns the underwriter's shares
    /// immediately (the user is paying-in their share value now to lock it
    /// at the current rate), decrements TMA by the snapshotted
    /// `pending_assets`, pre-inits the caller's `ClaimableBalance` PDA,
    /// reallocs the queue +1 slot, pushes the request. Cancellation
    /// re-mints shares and restores TMA. The drain just credits the
    /// snapshotted `pending_assets` — no re-pricing.
    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, shares: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroAmount);

        // Verify the caller actually has the shares they're queueing.
        require!(
            ctx.accounts.requester_share_account.amount >= shares,
            VaultError::InsufficientShares
        );

        // Snapshot pending_assets at the current price (BEFORE burn).
        let total_shares = ctx.accounts.share_mint.supply;
        let tma = ctx.accounts.vault_state.total_managed_assets;
        let pending_assets = compute_assets_for_redeem(shares, total_shares, tma)?;
        require!(pending_assets > 0, VaultError::ZeroAmount);

        // Burn the user's shares — signed by the user (authority over their
        // own share ATA).
        let cpi_accounts = Burn {
            mint: ctx.accounts.share_mint.to_account_info(),
            from: ctx.accounts.requester_share_account.to_account_info(),
            authority: ctx.accounts.requester.to_account_info(),
        };
        token::burn(
            CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts),
            shares,
        )?;

        // Decrement TMA by the snapshotted assets — the value is now
        // earmarked for this queued request and is no longer part of the
        // pool's free / locked accounting.
        let now = Clock::get()?.unix_timestamp;
        let claimable_pda = ctx.accounts.claimable.key();
        let requester_key = ctx.accounts.requester.key();

        // Initialise the ClaimableBalance fields on first creation.
        // `init_if_needed` may have just created or already existed; either
        // way, we ensure `owner` matches and don't clobber `amount`.
        {
            let claimable = &mut ctx.accounts.claimable;
            if claimable.owner == Pubkey::default() {
                claimable.owner = requester_key;
                claimable.amount = 0;
                claimable.bump = ctx.bumps.claimable;
            } else {
                require_keys_eq!(
                    claimable.owner,
                    requester_key,
                    VaultError::ClaimableOwnerMismatch
                );
            }
        }

        // Push the request.
        let queue = &mut ctx.accounts.withdrawal_queue;
        queue.requests.push(WithdrawalRequest {
            owner: requester_key,
            shares,
            pending_assets,
            timestamp: now,
            claimable: claimable_pda,
        });

        let state = &mut ctx.accounts.vault_state;
        state.total_managed_assets = state
            .total_managed_assets
            .checked_sub(pending_assets)
            .ok_or(VaultError::Overflow)?;
        state.withdrawal_queue_count = state
            .withdrawal_queue_count
            .checked_add(1)
            .ok_or(VaultError::Overflow)?;

        Ok(())
    }

    /// Removes a request at `queue_index`. Only the request owner can
    /// cancel. Preserves FIFO order (`Vec::remove`, O(n)). Re-mints the
    /// original `shares` to the user and restores TMA by the snapshotted
    /// `pending_assets` so the user is whole.
    pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>, queue_index: u32) -> Result<()> {
        let idx = queue_index as usize;
        let req = {
            let queue = &mut ctx.accounts.withdrawal_queue;
            require!(idx < queue.requests.len(), VaultError::QueueIndexOutOfRange);
            require_keys_eq!(
                queue.requests[idx].owner,
                ctx.accounts.requester.key(),
                VaultError::NotRequestOwner
            );
            queue.requests.remove(idx)
        };

        // Re-mint the user's shares — signed by the vault PDA (mint authority).
        let bump = ctx.accounts.vault_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault_state", &[bump]]];
        let cpi_accounts = MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.requester_share_account.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                cpi_accounts,
                signer_seeds,
            ),
            req.shares,
        )?;

        // Restore TMA + queue counter.
        let state = &mut ctx.accounts.vault_state;
        state.total_managed_assets = state
            .total_managed_assets
            .checked_add(req.pending_assets)
            .ok_or(VaultError::Overflow)?;
        state.withdrawal_queue_count = state
            .withdrawal_queue_count
            .checked_sub(1)
            .ok_or(VaultError::Overflow)?;

        Ok(())
    }

    /// Drains the caller's `ClaimableBalance` to their USDC ATA.
    pub fn collect(ctx: Context<Collect>) -> Result<()> {
        let amount = ctx.accounts.claimable.amount;
        require!(amount > 0, VaultError::NothingToCollect);

        let bump = ctx.accounts.vault_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault_state", &[bump]]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.collector_usdc_account.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                cpi_accounts,
                signer_seeds,
            ),
            amount,
        )?;

        let claimable = &mut ctx.accounts.claimable;
        claimable.amount = 0;

        Ok(())
    }

    // ─── Controller-only mutators ───────────────────────────────────

    pub fn increase_locked(ctx: Context<ControllerOnly>, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.vault_state;
        state.locked_capital = state
            .locked_capital
            .checked_add(amount)
            .ok_or(VaultError::Overflow)?;
        // Sanity: locked must never exceed TMA.
        require!(
            state.locked_capital <= state.total_managed_assets,
            VaultError::Overflow
        );
        Ok(())
    }

    pub fn decrease_locked(ctx: Context<ControllerOnly>, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.vault_state;
        require!(
            state.locked_capital >= amount,
            VaultError::InsufficientLocked
        );
        state.locked_capital = state
            .locked_capital
            .checked_sub(amount)
            .ok_or(VaultError::Overflow)?;
        Ok(())
    }

    /// Transfers USDC from the vault token account to a recipient
    /// (typically `flight_pool_program`'s pool treasury). Decrements TMA.
    pub fn send_payout(ctx: Context<SendPayout>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let bump = ctx.accounts.vault_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault_state", &[bump]]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.recipient.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                cpi_accounts,
                signer_seeds,
            ),
            amount,
        )?;

        let state = &mut ctx.accounts.vault_state;
        state.total_managed_assets = state
            .total_managed_assets
            .checked_sub(amount)
            .ok_or(VaultError::Overflow)?;

        Ok(())
    }

    /// Increments TMA by `amount` to reflect premium income realised
    /// elsewhere (the actual USDC arrived earlier into the flight_pool
    /// treasury and is forwarded by `flight_pool.settle_on_time` directly
    /// into the vault token account; this call only updates accounting).
    pub fn record_premium_income(ctx: Context<ControllerOnly>, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.vault_state;
        state.total_managed_assets = state
            .total_managed_assets
            .checked_add(amount)
            .ok_or(VaultError::Overflow)?;
        Ok(())
    }

    /// Walks the FIFO queue head-first, crediting each request's
    /// `ClaimableBalance` by its snapshotted `pending_assets` until
    /// `free_capital` is exhausted, the queue is empty, or
    /// `remaining_accounts` runs out. The keeper passes each
    /// `ClaimableBalance` PDA via `remaining_accounts` in queue order.
    /// **No re-pricing here** — assets were locked at request time. **No
    /// share burn here** — shares were burned at request time.
    /// `vault_token_account` (USDC) is unchanged; the actual USDC pull
    /// happens later in `collect()`.
    pub fn process_withdrawal_queue<'info>(
        ctx: Context<'info, ProcessWithdrawalQueue<'info>>,
    ) -> Result<()> {
        let mut free_capital = ctx
            .accounts
            .vault_state
            .total_managed_assets
            .checked_sub(ctx.accounts.vault_state.locked_capital)
            .ok_or(VaultError::Overflow)?;

        let mut queue_count = ctx.accounts.vault_state.withdrawal_queue_count;
        let queue = &mut ctx.accounts.withdrawal_queue;

        let mut filled: usize = 0;
        while !queue.requests.is_empty() && filled < ctx.remaining_accounts.len() {
            let req = queue.requests[0].clone();

            if req.pending_assets > free_capital {
                // FIFO halts: the head can't be fulfilled. Future drains
                // (after settlement injects more capital) will retry.
                break;
            }

            // Match the remaining_accounts entry to this request's
            // claimable PDA.
            let acc_info = &ctx.remaining_accounts[filled];
            require_keys_eq!(
                *acc_info.key,
                req.claimable,
                VaultError::ClaimableAccountMismatch
            );
            require_keys_eq!(
                *acc_info.owner,
                crate::ID,
                VaultError::InvalidClaimableOwner
            );
            require!(acc_info.is_writable, VaultError::ClaimableNotWritable);

            // Deserialise, credit, reserialise.
            {
                let mut data = acc_info.try_borrow_mut_data()?;
                let mut claimable = ClaimableBalance::try_deserialize(&mut &data[..])
                    .map_err(|_| VaultError::ClaimableDeserializeFailed)?;
                require_keys_eq!(claimable.owner, req.owner, VaultError::ClaimableOwnerMismatch);
                claimable.amount = claimable
                    .amount
                    .checked_add(req.pending_assets)
                    .ok_or(VaultError::Overflow)?;
                let mut writer: &mut [u8] = &mut data;
                claimable.try_serialize(&mut writer)?;
            }

            free_capital = free_capital
                .checked_sub(req.pending_assets)
                .ok_or(VaultError::Overflow)?;

            queue.requests.remove(0);
            queue_count = queue_count.checked_sub(1).ok_or(VaultError::Overflow)?;
            filled = filled.checked_add(1).ok_or(VaultError::Overflow)?;
        }

        // Persist mutated state. TMA is unchanged at drain time — it was
        // already debited at request time.
        let state = &mut ctx.accounts.vault_state;
        state.withdrawal_queue_count = queue_count;

        Ok(())
    }

    /// Records the daily share-price snapshot. No-op if already
    /// snapshotted today.
    pub fn snapshot(ctx: Context<Snapshot>, day: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let today = (now / SECONDS_PER_DAY) as u64;
        require!(day == today, VaultError::SnapshotDayMismatch);

        let state = &mut ctx.accounts.vault_state;
        // `-1` is the never-snapshotted sentinel (set at `initialize`).
        // Once a real snapshot is recorded, `last_snapshot_time >= 0`.
        if state.last_snapshot_time >= 0 {
            let last_day = (state.last_snapshot_time / SECONDS_PER_DAY) as u64;
            if last_day == today {
                // Idempotent within the same day.
                return Ok(());
            }
        }

        // Compute share price scaled by SHARE_PRICE_SCALE.
        let total_shares = ctx.accounts.share_mint.supply;
        let share_price = compute_share_price_scaled(total_shares, state.total_managed_assets)?;

        let snap = &mut ctx.accounts.snapshot_record;
        snap.day = day;
        snap.share_price = share_price;
        snap.bump = ctx.bumps.snapshot_record;

        state.last_snapshot_time = now;
        Ok(())
    }
}

// ─── Math helpers ──────────────────────────────────────────────────────────

/// `floor((deposit_amount * (total_shares + V_S)) / (total_managed_assets + V_A))`.
fn compute_shares_for_deposit(
    deposit_amount: u64,
    total_shares: u64,
    total_managed_assets: u64,
) -> Result<u64> {
    let numer = (deposit_amount as u128)
        .checked_mul((total_shares as u128).checked_add(VIRTUAL_SHARES as u128).ok_or(VaultError::Overflow)?)
        .ok_or(VaultError::Overflow)?;
    let denom = (total_managed_assets as u128)
        .checked_add(VIRTUAL_ASSETS as u128)
        .ok_or(VaultError::Overflow)?;
    let result = numer.checked_div(denom).ok_or(VaultError::Overflow)?;
    u64::try_from(result).map_err(|_| VaultError::Overflow.into())
}

/// `ceil((shares * (total_managed_assets + V_A)) / (total_shares + V_S))`.
/// Vault retains rounding (rounds UP).
fn compute_assets_for_redeem(
    shares: u64,
    total_shares: u64,
    total_managed_assets: u64,
) -> Result<u64> {
    let numer = (shares as u128)
        .checked_mul(
            (total_managed_assets as u128)
                .checked_add(VIRTUAL_ASSETS as u128)
                .ok_or(VaultError::Overflow)?,
        )
        .ok_or(VaultError::Overflow)?;
    let denom = (total_shares as u128)
        .checked_add(VIRTUAL_SHARES as u128)
        .ok_or(VaultError::Overflow)?;
    // Ceiling division: (numer + denom - 1) / denom.
    let one = 1u128;
    let result = numer
        .checked_add(denom.checked_sub(one).ok_or(VaultError::Overflow)?)
        .ok_or(VaultError::Overflow)?
        .checked_div(denom)
        .ok_or(VaultError::Overflow)?;
    u64::try_from(result).map_err(|_| VaultError::Overflow.into())
}

/// `floor((tma + V_A) * SCALE / (total_shares + V_S))`. For the snapshot
/// record only (informational).
fn compute_share_price_scaled(total_shares: u64, total_managed_assets: u64) -> Result<u64> {
    let numer = ((total_managed_assets as u128)
        .checked_add(VIRTUAL_ASSETS as u128)
        .ok_or(VaultError::Overflow)?)
    .checked_mul(SHARE_PRICE_SCALE)
    .ok_or(VaultError::Overflow)?;
    let denom = (total_shares as u128)
        .checked_add(VIRTUAL_SHARES as u128)
        .ok_or(VaultError::Overflow)?;
    let result = numer.checked_div(denom).ok_or(VaultError::Overflow)?;
    u64::try_from(result).map_err(|_| VaultError::Overflow.into())
}

// ─── Accounts: initialize ──────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(usdc_mint: Pubkey)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        init,
        payer = owner,
        space = 8 + WithdrawalQueue::INIT_SPACE,
        seeds = [b"withdrawal_queue"],
        bump,
    )]
    pub withdrawal_queue: Account<'info, WithdrawalQueue>,

    #[account(
        init,
        payer = owner,
        seeds = [b"share_mint"],
        bump,
        mint::decimals = 6,
        mint::authority = vault_state,
    )]
    pub share_mint: Account<'info, Mint>,

    /// CHECK: validated against the `usdc_mint` arg via `require_keys_eq!`.
    /// The mint's decimals/authority are externally controlled; we only
    /// need to know its address.
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_state,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ─── Accounts: set_controller ──────────────────────────────────────────────

#[derive(Accounts)]
pub struct SetController<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub vault_state: Account<'info, VaultState>,
    pub owner: Signer<'info>,
}

// ─── Accounts: deposit ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = share_mint @ VaultError::ShareMintMismatch,
        has_one = vault_token_account @ VaultError::VaultTokenAccountMismatch,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"share_mint"],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Depositor's USDC ATA. We don't enforce ATA-ness at the Anchor layer
    /// (lets tests use synthetic accounts seeded via setAccount); we only
    /// require it's a valid TokenAccount of the configured USDC mint.
    #[account(
        mut,
        constraint = depositor_usdc_account.mint == vault_state.usdc_mint @ VaultError::UsdcMintMismatch,
        constraint = depositor_usdc_account.owner == depositor.key() @ VaultError::Unauthorized,
    )]
    pub depositor_usdc_account: Account<'info, TokenAccount>,

    /// Depositor's share-mint ATA. Created by the test harness (or the
    /// frontend in production) ahead of time.
    #[account(
        mut,
        constraint = depositor_share_account.mint == share_mint.key() @ VaultError::ShareMintMismatch,
        constraint = depositor_share_account.owner == depositor.key() @ VaultError::Unauthorized,
    )]
    pub depositor_share_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ─── Accounts: redeem ──────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = share_mint @ VaultError::ShareMintMismatch,
        has_one = vault_token_account @ VaultError::VaultTokenAccountMismatch,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"share_mint"],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = redeemer_share_account.mint == share_mint.key() @ VaultError::ShareMintMismatch,
        constraint = redeemer_share_account.owner == redeemer.key() @ VaultError::Unauthorized,
    )]
    pub redeemer_share_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = redeemer_usdc_account.mint == vault_state.usdc_mint @ VaultError::UsdcMintMismatch,
        constraint = redeemer_usdc_account.owner == redeemer.key() @ VaultError::Unauthorized,
    )]
    pub redeemer_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub redeemer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ─── Accounts: request_withdrawal ──────────────────────────────────────────

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = share_mint @ VaultError::ShareMintMismatch,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"withdrawal_queue"],
        bump = withdrawal_queue.bump,
        realloc = 8 + WithdrawalQueue::space_for(withdrawal_queue.requests.len() + 1),
        realloc::payer = requester,
        realloc::zero = false,
    )]
    pub withdrawal_queue: Account<'info, WithdrawalQueue>,

    #[account(
        mut,
        seeds = [b"share_mint"],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = requester_share_account.mint == share_mint.key() @ VaultError::ShareMintMismatch,
        constraint = requester_share_account.owner == requester.key() @ VaultError::Unauthorized,
    )]
    pub requester_share_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = requester,
        space = 8 + ClaimableBalance::INIT_SPACE,
        seeds = [b"claimable", requester.key().as_ref()],
        bump,
    )]
    pub claimable: Account<'info, ClaimableBalance>,

    #[account(mut)]
    pub requester: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ─── Accounts: cancel_withdrawal ───────────────────────────────────────────

#[derive(Accounts)]
#[instruction(queue_index: u32)]
pub struct CancelWithdrawal<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = share_mint @ VaultError::ShareMintMismatch,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"withdrawal_queue"],
        bump = withdrawal_queue.bump,
        realloc = 8 + WithdrawalQueue::space_for(
            withdrawal_queue.requests.len().saturating_sub(1)
        ),
        realloc::payer = requester,
        realloc::zero = false,
    )]
    pub withdrawal_queue: Account<'info, WithdrawalQueue>,

    #[account(
        mut,
        seeds = [b"share_mint"],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = requester_share_account.mint == share_mint.key() @ VaultError::ShareMintMismatch,
        constraint = requester_share_account.owner == requester.key() @ VaultError::Unauthorized,
    )]
    pub requester_share_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub requester: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ─── Accounts: collect ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Collect<'info> {
    #[account(
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = vault_token_account @ VaultError::VaultTokenAccountMismatch,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"claimable", collector.key().as_ref()],
        bump = claimable.bump,
        has_one = owner @ VaultError::Unauthorized,
    )]
    pub claimable: Account<'info, ClaimableBalance>,

    /// CHECK: alias for `claimable.owner` constraint via `has_one`. Must
    /// match the signer.
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = collector_usdc_account.mint == vault_state.usdc_mint @ VaultError::UsdcMintMismatch,
        constraint = collector_usdc_account.owner == collector.key() @ VaultError::Unauthorized,
    )]
    pub collector_usdc_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = collector.key() == claimable.owner @ VaultError::Unauthorized,
    )]
    pub collector: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ─── Accounts: controller-only (simple) ───────────────────────────────────

#[derive(Accounts)]
pub struct ControllerOnly<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = controller @ VaultError::Unauthorized,
    )]
    pub vault_state: Account<'info, VaultState>,
    pub controller: Signer<'info>,
}

#[derive(Accounts)]
pub struct SendPayout<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = controller @ VaultError::Unauthorized,
        has_one = vault_token_account @ VaultError::VaultTokenAccountMismatch,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient.mint == vault_state.usdc_mint @ VaultError::UsdcMintMismatch,
    )]
    pub recipient: Account<'info, TokenAccount>,

    pub controller: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ProcessWithdrawalQueue<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = controller @ VaultError::Unauthorized,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"withdrawal_queue"],
        bump = withdrawal_queue.bump,
    )]
    pub withdrawal_queue: Account<'info, WithdrawalQueue>,

    pub controller: Signer<'info>,
    // `ClaimableBalance` accounts come via `ctx.remaining_accounts` in
    // queue order (D5). No share-mint or USDC token-account here — drain
    // is bookkeeping only; the user pulls USDC later via `collect()`.
}

#[derive(Accounts)]
#[instruction(day: u64)]
pub struct Snapshot<'info> {
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.bump,
        has_one = controller @ VaultError::Unauthorized,
        has_one = share_mint @ VaultError::ShareMintMismatch,
    )]
    pub vault_state: Account<'info, VaultState>,

    pub share_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = rent_payer,
        space = 8 + SnapshotRecord::INIT_SPACE,
        seeds = [b"snapshot", &day.to_le_bytes()],
        bump,
    )]
    pub snapshot_record: Account<'info, SnapshotRecord>,

    /// Authority. PDA-signable via the controller PDA in production.
    pub controller: Signer<'info>,

    /// Rent-payer for new `SnapshotRecord` PDAs. Must be a system-owned
    /// signer (PDAs can't pay rent). In production this is the keeper
    /// signer driving `execute_settlements`. See Phase 5 D18.
    #[account(mut)]
    pub rent_payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ─── Account data ──────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub owner: Pubkey,
    pub controller: Pubkey,
    pub usdc_mint: Pubkey,
    pub share_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub total_managed_assets: u64,
    pub locked_capital: u64,
    pub last_snapshot_time: i64,
    pub withdrawal_queue_count: u32,
    pub is_controller_set: bool,
    pub bump: u8,
}

#[account]
pub struct WithdrawalQueue {
    pub requests: Vec<WithdrawalRequest>,
    pub bump: u8,
}

impl WithdrawalQueue {
    /// Base space (8-byte discriminator handled by Anchor) for an empty queue.
    /// Bytes after the discriminator: 4 (Vec len) + N * 80 (entries) + 1 (bump).
    pub const INIT_SPACE: usize = 4 + 0 + 1;

    /// Total space in BYTES (excluding the 8-byte discriminator) for `n` entries.
    pub const fn space_for(n: usize) -> usize {
        4 + n * WithdrawalRequest::SIZE + 1
    }
}

/// `pending_assets` is the USDC owed to the underwriter, snapshotted at
/// `request_withdrawal` time using the virtual-offset formula on the
/// pre-burn supply + TMA. The drain credits the underwriter's
/// `ClaimableBalance` by this exact amount — no re-pricing at drain time —
/// so the value is locked in regardless of inter-request supply/TMA drift.
/// Cancellation re-mints the original `shares` and restores TMA by
/// `pending_assets`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct WithdrawalRequest {
    pub owner: Pubkey,
    pub shares: u64,
    pub pending_assets: u64,
    pub timestamp: i64,
    pub claimable: Pubkey,
}

impl WithdrawalRequest {
    pub const SIZE: usize = 32 + 8 + 8 + 8 + 32; // 88
}

#[account]
#[derive(InitSpace)]
pub struct ClaimableBalance {
    pub owner: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SnapshotRecord {
    pub day: u64,
    pub share_price: u64,
    pub bump: u8,
}

// ─── Errors ───────────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Caller is not authorised for this instruction.")]
    Unauthorized,
    #[msg("Controller has already been set; this is a one-shot wiring.")]
    ControllerAlreadySet,
    #[msg("Free capital is insufficient for the requested redemption.")]
    InsufficientFreeCapital,
    #[msg("Caller does not hold enough shares for this operation.")]
    InsufficientShares,
    #[msg("`decrease_locked` would underflow `locked_capital`.")]
    InsufficientLocked,
    #[msg("Queue index is out of range.")]
    QueueIndexOutOfRange,
    #[msg("Caller does not own the requested withdrawal request.")]
    NotRequestOwner,
    #[msg("Claimable balance is zero — nothing to collect.")]
    NothingToCollect,
    #[msg("Operation amount must be > 0.")]
    ZeroAmount,
    #[msg("Computed share count is zero — deposit too small relative to vault state.")]
    ZeroShares,
    #[msg("Share mint argument does not match the configured share mint.")]
    ShareMintMismatch,
    #[msg("Vault token account argument does not match the configured token account.")]
    VaultTokenAccountMismatch,
    #[msg("Token mint does not match the configured USDC mint.")]
    UsdcMintMismatch,
    #[msg("Snapshot day argument does not match the current day.")]
    SnapshotDayMismatch,
    #[msg("Claimable account passed in remaining_accounts does not match queue request.")]
    ClaimableAccountMismatch,
    #[msg("Claimable account is not owned by this program.")]
    InvalidClaimableOwner,
    #[msg("Claimable account is not writable.")]
    ClaimableNotWritable,
    #[msg("Failed to deserialize ClaimableBalance.")]
    ClaimableDeserializeFailed,
    #[msg("ClaimableBalance owner does not match the request owner.")]
    ClaimableOwnerMismatch,
    #[msg("Arithmetic overflow.")]
    Overflow,
}
