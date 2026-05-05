//! Sentinel — flight_pool program.
//!
//! Per-flight pool registry, shared pool treasury, buyer records, claim/sweep
//! paths, and recovery accounting. All in-flight USDC sits in a single
//! program-owned token account (the pool treasury). Per-flight money state
//! lives in `FlightPool` PDA fields — there are no per-flight token accounts.
//!
//! Authority model:
//!   - Owner: initialize, set_controller, withdraw_recovered.
//!   - Controller (`has_one = controller` on config + Signer): register_pool,
//!     add_buyer, settle_on_time, settle_delayed, settle_cancelled. Wired in
//!     Phase 5 to the controller_program's PDA via `invoke_signed`.
//!   - Traveler: claim (Signer + BuyerRecord existence + status/expiry).
//!   - Anyone: sweep_expired (Signer for tx fee + post-expiry checks).
//!
//! See `spec/architecture.md` §flight_pool_program and
//! `spec/phases/phase-03-flight-pool-program.md` for locked decisions D1–D15.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GW1yq7rswXBect6yR1RWtU7Q7AmY5wWMnq58a1JGcwVq");

// ─── Constants ────────────────────────────────────────────────────────────
// Match Phase 1 governance D1: a route whitelisted with up to 16 bytes of
// `flight_id` must round-trip cleanly through flight_pool's `add_buyer`.
pub const MAX_FLIGHT_ID_LEN: usize = 16;

#[program]
pub mod flight_pool {
    use super::*;

    // ─── Initialization ─────────────────────────────────────────────

    pub fn initialize(ctx: Context<Initialize>, usdc_mint: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.usdc_mint.key(),
            usdc_mint,
            FlightPoolError::UsdcMintMismatch
        );

        let config = &mut ctx.accounts.config;
        config.owner = ctx.accounts.owner.key();
        config.controller = Pubkey::default();
        config.usdc_mint = usdc_mint;
        config.pool_treasury = ctx.accounts.pool_treasury.key();
        config.recovered_balance = 0;
        config.is_controller_set = false;
        config.bump = ctx.bumps.config;
        config.treasury_authority_bump = ctx.bumps.treasury_authority;
        Ok(())
    }

    pub fn set_controller(ctx: Context<SetController>, controller: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.is_controller_set, FlightPoolError::ControllerAlreadySet);
        config.controller = controller;
        config.is_controller_set = true;
        Ok(())
    }

    // ─── Controller-only mutators ───────────────────────────────────

    pub fn register_pool(
        ctx: Context<RegisterPool>,
        flight_id: String,
        date: u64,
        premium: u64,
        payoff: u64,
        delay_hours: u32,
    ) -> Result<()> {
        validate_flight_id(&flight_id)?;
        let pool = &mut ctx.accounts.pool;
        pool.flight_id = flight_id;
        pool.date = date;
        pool.premium = premium;
        pool.payoff = payoff;
        pool.delay_hours = delay_hours;
        pool.buyer_count = 0;
        pool.claimed_count = 0;
        pool.status = SettlementStatus::Active;
        pool.claim_expiry = 0;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    pub fn add_buyer(ctx: Context<AddBuyer>, flight_id: String, date: u64) -> Result<()> {
        let _ = (flight_id, date); // bound by `#[instruction(...)]`, used in seeds.

        require!(
            ctx.accounts.pool.status == SettlementStatus::Active,
            FlightPoolError::PoolNotActive
        );

        // BuyerRecord init-time fields. Strict `init` in the accounts
        // struct already guarantees this is a fresh PDA — re-purchase by
        // the same buyer reverts before reaching here (PDA collision).
        let buyer_pubkey = ctx.accounts.buyer.key();
        let pool_key = ctx.accounts.pool.key();
        let buyer_record = &mut ctx.accounts.buyer_record;
        buyer_record.buyer = buyer_pubkey;
        buyer_record.pool = pool_key;
        buyer_record.has_policy = true;
        buyer_record.claimed = false;
        buyer_record.bump = ctx.bumps.buyer_record;

        // Transfer the premium from the buyer's USDC ATA into the shared
        // pool treasury. Signed by the buyer (they're a `Signer` here);
        // in Phase 5 the controller's CPI passes the buyer's signature
        // through transitively (architecture §Buying Insurance).
        let premium = ctx.accounts.pool.premium;
        let cpi_accounts = Transfer {
            from: ctx.accounts.buyer_usdc_account.to_account_info(),
            to: ctx.accounts.pool_treasury.to_account_info(),
            authority: ctx.accounts.buyer.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts),
            premium,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.buyer_count = pool
            .buyer_count
            .checked_add(1)
            .ok_or(FlightPoolError::Overflow)?;

        Ok(())
    }

    pub fn settle_on_time(
        ctx: Context<SettleOnTime>,
        flight_id: String,
        date: u64,
    ) -> Result<()> {
        let _ = (flight_id, date);
        require!(
            ctx.accounts.pool.status == SettlementStatus::Active,
            FlightPoolError::PoolNotActive
        );

        // Forward `premium * buyer_count` from the pool treasury to the
        // recipient (vault token account in production; mock account in
        // unit tests). D7: trust the controller — `has_one = controller`
        // gates this ix; controller is honest by construction in Phase 5.
        let amount = (ctx.accounts.pool.premium as u128)
            .checked_mul(ctx.accounts.pool.buyer_count as u128)
            .ok_or(FlightPoolError::Overflow)?;
        let amount = u64::try_from(amount).map_err(|_| FlightPoolError::Overflow)?;

        if amount > 0 {
            let bump = ctx.accounts.config.treasury_authority_bump;
            let signer_seeds: &[&[&[u8]]] = &[&[b"pool_treasury", &[bump]]];
            let cpi_accounts = Transfer {
                from: ctx.accounts.pool_treasury.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
                authority: ctx.accounts.treasury_authority.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    cpi_accounts,
                    signer_seeds,
                ),
                amount,
            )?;
        }

        let pool = &mut ctx.accounts.pool;
        pool.status = SettlementStatus::SettledOnTime;
        Ok(())
    }

    pub fn settle_delayed(
        ctx: Context<SettleStatusOnly>,
        flight_id: String,
        date: u64,
        claim_expiry: i64,
    ) -> Result<()> {
        let _ = (flight_id, date);
        require!(
            ctx.accounts.pool.status == SettlementStatus::Active,
            FlightPoolError::PoolNotActive
        );
        let pool = &mut ctx.accounts.pool;
        pool.status = SettlementStatus::SettledDelayed;
        pool.claim_expiry = claim_expiry;
        Ok(())
    }

    pub fn settle_cancelled(
        ctx: Context<SettleStatusOnly>,
        flight_id: String,
        date: u64,
        claim_expiry: i64,
    ) -> Result<()> {
        let _ = (flight_id, date);
        require!(
            ctx.accounts.pool.status == SettlementStatus::Active,
            FlightPoolError::PoolNotActive
        );
        let pool = &mut ctx.accounts.pool;
        pool.status = SettlementStatus::SettledCancelled;
        pool.claim_expiry = claim_expiry;
        Ok(())
    }

    // ─── Traveler / public ───────────────────────────────────────────

    pub fn claim(ctx: Context<Claim>, flight_id: String, date: u64) -> Result<()> {
        let _ = (flight_id, date);

        require!(
            matches!(
                ctx.accounts.pool.status,
                SettlementStatus::SettledDelayed | SettlementStatus::SettledCancelled
            ),
            FlightPoolError::PoolNotSettled
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now <= ctx.accounts.pool.claim_expiry, FlightPoolError::ClaimExpired);

        require!(
            ctx.accounts.buyer_record.has_policy,
            FlightPoolError::NotPolicyHolder
        );
        require!(
            !ctx.accounts.buyer_record.claimed,
            FlightPoolError::AlreadyClaimed
        );

        // Mark claimed BEFORE transfer (defence-in-depth — Anchor's
        // execution model is single-threaded, but the early write is a
        // belt-and-braces guard against any reentrancy regression).
        let payoff = ctx.accounts.pool.payoff;
        let buyer_record = &mut ctx.accounts.buyer_record;
        buyer_record.claimed = true;
        let pool = &mut ctx.accounts.pool;
        pool.claimed_count = pool
            .claimed_count
            .checked_add(1)
            .ok_or(FlightPoolError::Overflow)?;

        let bump = ctx.accounts.config.treasury_authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"pool_treasury", &[bump]]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.pool_treasury.to_account_info(),
            to: ctx.accounts.traveler_usdc_account.to_account_info(),
            authority: ctx.accounts.treasury_authority.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                cpi_accounts,
                signer_seeds,
            ),
            payoff,
        )?;

        Ok(())
    }

    pub fn sweep_expired(
        ctx: Context<SweepExpired>,
        flight_id: String,
        date: u64,
    ) -> Result<()> {
        let _ = (flight_id, date);

        require!(
            matches!(
                ctx.accounts.pool.status,
                SettlementStatus::SettledDelayed | SettlementStatus::SettledCancelled
            ),
            FlightPoolError::PoolNotSettled
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now > ctx.accounts.pool.claim_expiry, FlightPoolError::NotYetExpired);

        let unclaimed = (ctx.accounts.pool.buyer_count as u64)
            .checked_sub(ctx.accounts.pool.claimed_count as u64)
            .ok_or(FlightPoolError::Overflow)?;
        if unclaimed == 0 {
            // Idempotent — already swept (or no unclaimed payouts to recover).
            return Ok(());
        }
        let amount = unclaimed
            .checked_mul(ctx.accounts.pool.payoff)
            .ok_or(FlightPoolError::Overflow)?;

        let pool = &mut ctx.accounts.pool;
        pool.claimed_count = pool.buyer_count;

        let config = &mut ctx.accounts.config;
        config.recovered_balance = config
            .recovered_balance
            .checked_add(amount)
            .ok_or(FlightPoolError::Overflow)?;

        Ok(())
    }

    pub fn withdraw_recovered(ctx: Context<WithdrawRecovered>, amount: u64) -> Result<()> {
        require!(amount > 0, FlightPoolError::ZeroAmount);
        require!(
            amount <= ctx.accounts.config.recovered_balance,
            FlightPoolError::InsufficientRecovered
        );

        let bump = ctx.accounts.config.treasury_authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"pool_treasury", &[bump]]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.pool_treasury.to_account_info(),
            to: ctx.accounts.owner_usdc_account.to_account_info(),
            authority: ctx.accounts.treasury_authority.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                cpi_accounts,
                signer_seeds,
            ),
            amount,
        )?;

        let config = &mut ctx.accounts.config;
        config.recovered_balance = config
            .recovered_balance
            .checked_sub(amount)
            .ok_or(FlightPoolError::Overflow)?;

        Ok(())
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

fn validate_flight_id(flight_id: &str) -> Result<()> {
    require!(
        !flight_id.is_empty(),
        FlightPoolError::FlightIdEmpty
    );
    require!(
        flight_id.len() <= MAX_FLIGHT_ID_LEN,
        FlightPoolError::FlightIdTooLong
    );
    Ok(())
}

// ─── Accounts: initialize ──────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(usdc_mint: Pubkey)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + FlightPoolConfig::INIT_SPACE,
        seeds = [b"flight_pool_config"],
        bump,
    )]
    pub config: Account<'info, FlightPoolConfig>,

    /// CHECK: validated against the `usdc_mint` arg via `require_keys_eq!`.
    pub usdc_mint: Account<'info, Mint>,

    /// PDA whose seeds (`[b"pool_treasury"]`) authorise treasury outflows.
    /// Not a stored Anchor account — just a signer-seed source.
    /// CHECK: derived via seeds + bump constraint.
    #[account(
        seeds = [b"pool_treasury"],
        bump,
    )]
    pub treasury_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = treasury_authority,
    )]
    pub pool_treasury: Account<'info, TokenAccount>,

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
        seeds = [b"flight_pool_config"],
        bump = config.bump,
        has_one = owner @ FlightPoolError::Unauthorized,
    )]
    pub config: Account<'info, FlightPoolConfig>,
    pub owner: Signer<'info>,
}

// ─── Accounts: register_pool (controller-only) ─────────────────────────────

#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct RegisterPool<'info> {
    #[account(
        seeds = [b"flight_pool_config"],
        bump = config.bump,
        has_one = controller @ FlightPoolError::Unauthorized,
    )]
    pub config: Account<'info, FlightPoolConfig>,

    #[account(
        init,
        payer = rent_payer,
        space = 8 + FlightPool::INIT_SPACE,
        seeds = [b"pool", flight_id.as_bytes(), &date.to_le_bytes()],
        bump,
    )]
    pub pool: Account<'info, FlightPool>,

    /// Authority. In production this is the controller_program's
    /// `ControllerConfig` PDA (signed via `invoke_signed`). In Phase 3 unit
    /// tests it's just a regular keypair set by `set_controller`.
    pub controller: Signer<'info>,

    /// Rent-payer for the new `FlightPool` PDA. Must be a system-owned
    /// signer (a PDA cannot be a system_program::create_account payer).
    /// In production this is the traveler making the first-buy. In Phase 3
    /// unit tests it can be the same keypair as `controller`.
    /// See Phase 5 D18.
    #[account(mut)]
    pub rent_payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ─── Accounts: add_buyer (controller-only, traveler signs transitively) ────

#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct AddBuyer<'info> {
    #[account(
        seeds = [b"flight_pool_config"],
        bump = config.bump,
        has_one = controller @ FlightPoolError::Unauthorized,
        has_one = pool_treasury @ FlightPoolError::TreasuryMismatch,
    )]
    pub config: Account<'info, FlightPoolConfig>,

    #[account(
        mut,
        seeds = [b"pool", flight_id.as_bytes(), &date.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, FlightPool>,

    /// `BuyerRecord` PDA — strict `init`. Re-purchase by the same buyer
    /// for the same pool reverts via PDA collision (D6).
    #[account(
        init,
        payer = buyer,
        space = 8 + BuyerRecord::INIT_SPACE,
        seeds = [b"buyer", pool.key().as_ref(), buyer.key().as_ref()],
        bump,
    )]
    pub buyer_record: Account<'info, BuyerRecord>,

    /// Buyer's USDC ATA. Validated to match the configured mint and to
    /// be owned by the buyer signer (pre-emptive auth, beyond Anchor's
    /// transfer authority check).
    #[account(
        mut,
        constraint = buyer_usdc_account.mint == config.usdc_mint @ FlightPoolError::UsdcMintMismatch,
        constraint = buyer_usdc_account.owner == buyer.key() @ FlightPoolError::Unauthorized,
    )]
    pub buyer_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool_treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    pub controller: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ─── Accounts: settle_on_time ──────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct SettleOnTime<'info> {
    #[account(
        seeds = [b"flight_pool_config"],
        bump = config.bump,
        has_one = controller @ FlightPoolError::Unauthorized,
        has_one = pool_treasury @ FlightPoolError::TreasuryMismatch,
    )]
    pub config: Account<'info, FlightPoolConfig>,

    #[account(
        mut,
        seeds = [b"pool", flight_id.as_bytes(), &date.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, FlightPool>,

    #[account(mut)]
    pub pool_treasury: Account<'info, TokenAccount>,

    /// CHECK: derived via `seeds = [b"pool_treasury"]` constraint.
    #[account(
        seeds = [b"pool_treasury"],
        bump = config.treasury_authority_bump,
    )]
    pub treasury_authority: UncheckedAccount<'info>,

    /// Recipient is trusted (D7) — controller is `has_one`-gated. We
    /// constrain the mint to prevent accidental wrong-mint transfers.
    #[account(
        mut,
        constraint = recipient.mint == config.usdc_mint @ FlightPoolError::UsdcMintMismatch,
    )]
    pub recipient: Account<'info, TokenAccount>,

    pub controller: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ─── Accounts: settle_delayed / settle_cancelled (status-only) ─────────────

#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct SettleStatusOnly<'info> {
    #[account(
        seeds = [b"flight_pool_config"],
        bump = config.bump,
        has_one = controller @ FlightPoolError::Unauthorized,
    )]
    pub config: Account<'info, FlightPoolConfig>,

    #[account(
        mut,
        seeds = [b"pool", flight_id.as_bytes(), &date.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, FlightPool>,

    pub controller: Signer<'info>,
}

// ─── Accounts: claim ───────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct Claim<'info> {
    #[account(
        seeds = [b"flight_pool_config"],
        bump = config.bump,
        has_one = pool_treasury @ FlightPoolError::TreasuryMismatch,
    )]
    pub config: Account<'info, FlightPoolConfig>,

    #[account(
        mut,
        seeds = [b"pool", flight_id.as_bytes(), &date.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, FlightPool>,

    #[account(
        mut,
        seeds = [b"buyer", pool.key().as_ref(), traveler.key().as_ref()],
        bump = buyer_record.bump,
        has_one = buyer @ FlightPoolError::Unauthorized,
    )]
    pub buyer_record: Account<'info, BuyerRecord>,

    /// CHECK: alias for `buyer_record.buyer` constraint via `has_one = buyer`.
    pub buyer: UncheckedAccount<'info>,

    #[account(mut)]
    pub pool_treasury: Account<'info, TokenAccount>,

    /// CHECK: derived via `seeds = [b"pool_treasury"]` constraint.
    #[account(
        seeds = [b"pool_treasury"],
        bump = config.treasury_authority_bump,
    )]
    pub treasury_authority: UncheckedAccount<'info>,

    /// Strict `ATA(traveler, usdc_mint)` (D8).
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = traveler,
    )]
    pub traveler_usdc_account: Account<'info, TokenAccount>,

    #[account(
        constraint = usdc_mint.key() == config.usdc_mint @ FlightPoolError::UsdcMintMismatch,
    )]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = traveler.key() == buyer_record.buyer @ FlightPoolError::Unauthorized,
    )]
    pub traveler: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ─── Accounts: sweep_expired (anyone-callable) ─────────────────────────────

#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct SweepExpired<'info> {
    #[account(
        mut,
        seeds = [b"flight_pool_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, FlightPoolConfig>,

    #[account(
        mut,
        seeds = [b"pool", flight_id.as_bytes(), &date.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, FlightPool>,

    /// CHECK: anyone can call sweep_expired — caller pays tx fee.
    #[account(mut)]
    pub caller: Signer<'info>,
}

// ─── Accounts: withdraw_recovered (owner-only) ─────────────────────────────

#[derive(Accounts)]
pub struct WithdrawRecovered<'info> {
    #[account(
        mut,
        seeds = [b"flight_pool_config"],
        bump = config.bump,
        has_one = owner @ FlightPoolError::Unauthorized,
        has_one = pool_treasury @ FlightPoolError::TreasuryMismatch,
    )]
    pub config: Account<'info, FlightPoolConfig>,

    #[account(mut)]
    pub pool_treasury: Account<'info, TokenAccount>,

    /// CHECK: derived via `seeds = [b"pool_treasury"]` constraint.
    #[account(
        seeds = [b"pool_treasury"],
        bump = config.treasury_authority_bump,
    )]
    pub treasury_authority: UncheckedAccount<'info>,

    /// Strict `ATA(owner, usdc_mint)` (D10).
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner,
    )]
    pub owner_usdc_account: Account<'info, TokenAccount>,

    #[account(
        constraint = usdc_mint.key() == config.usdc_mint @ FlightPoolError::UsdcMintMismatch,
    )]
    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ─── Account data ──────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct FlightPoolConfig {
    pub owner: Pubkey,
    pub controller: Pubkey,
    pub usdc_mint: Pubkey,
    pub pool_treasury: Pubkey,
    pub recovered_balance: u64,
    pub is_controller_set: bool,
    pub bump: u8,
    pub treasury_authority_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FlightPool {
    #[max_len(MAX_FLIGHT_ID_LEN)]
    pub flight_id: String,
    pub date: u64,
    pub premium: u64,
    pub payoff: u64,
    pub delay_hours: u32,
    pub buyer_count: u32,
    pub claimed_count: u32,
    pub status: SettlementStatus,
    pub claim_expiry: i64,
    pub bump: u8,
}

/// Per-buyer record. Field order is **load-bearing** for the architecture's
/// `getProgramAccounts + memcmp` query pattern: `buyer` MUST be the first
/// field (offset 8 after the discriminator) and `pool` MUST be second
/// (offset 40). Frontend filters use `memcmp { offset: 8, bytes: walletAddress }`.
#[account]
#[derive(InitSpace)]
pub struct BuyerRecord {
    pub buyer: Pubkey,    // offset 8 — filterable by traveler wallet
    pub pool: Pubkey,     // offset 40 — filterable by pool PDA
    pub has_policy: bool,
    pub claimed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum SettlementStatus {
    Active,
    SettledOnTime,
    SettledDelayed,
    SettledCancelled,
}

// ─── Errors ───────────────────────────────────────────────────────────────

#[error_code]
pub enum FlightPoolError {
    #[msg("Caller is not authorised for this instruction.")]
    Unauthorized,
    #[msg("Controller has already been set; this is a one-shot wiring.")]
    ControllerAlreadySet,
    #[msg("flight_id is empty.")]
    FlightIdEmpty,
    #[msg("flight_id exceeds MAX_FLIGHT_ID_LEN.")]
    FlightIdTooLong,
    #[msg("Pool is not in `Active` state — cannot register/add/settle.")]
    PoolNotActive,
    #[msg("Pool is not in a `Settled*` state with a payout window.")]
    PoolNotSettled,
    #[msg("Claim window has expired.")]
    ClaimExpired,
    #[msg("Claim window has not yet expired — sweep_expired refused.")]
    NotYetExpired,
    #[msg("Buyer has already claimed.")]
    AlreadyClaimed,
    #[msg("BuyerRecord does not have an active policy.")]
    NotPolicyHolder,
    #[msg("`amount > recovered_balance`.")]
    InsufficientRecovered,
    #[msg("Token account mint does not match the configured USDC mint.")]
    UsdcMintMismatch,
    #[msg("pool_treasury argument does not match the configured treasury.")]
    TreasuryMismatch,
    #[msg("Operation amount must be > 0.")]
    ZeroAmount,
    #[msg("Arithmetic overflow.")]
    Overflow,
}
