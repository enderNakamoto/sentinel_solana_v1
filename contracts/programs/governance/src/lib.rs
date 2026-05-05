//! Sentinel — governance program.
//!
//! Owns the route registry, global default terms, per-route overrides, and
//! the admin whitelist. The controller program (Phase 5) reads
//! `is_route_whitelisted` and `get_route_terms` via CPI on every
//! `buy_insurance` call. This program holds zero funds and CPIs nothing.
//!
//! See `spec/architecture.md` §governance_program for the canonical interface
//! and `spec/phases/phase-01-governance-program.md` for locked design
//! decisions D1–D9.

use anchor_lang::prelude::*;

declare_id!("6d6QXsZRQ1fXp8wEXFTm4uXAbLWarPKX6XJLcNUY8rcT");

// ─── Length caps for PDA seed components (D1) ────────────────────────────
// Solana enforces ≤32 bytes per PDA seed component. Each route is identified
// by `(flight_id, origin, destination)` and hashed into a PDA via these
// strings, so we cap each at a value comfortably under 32 bytes.
pub const MAX_FLIGHT_ID_LEN: usize = 16; // e.g. "AA100", "UA1532"
pub const MAX_ORIGIN_LEN: usize = 8; //    IATA-friendly: 3 chars + slack
pub const MAX_DEST_LEN: usize = 8;

// Sane upper bound for `delay_hours` — multi-day delays beyond a week are not
// a realistic insurance trigger and would silently break time arithmetic.
pub const MAX_DELAY_HOURS: u32 = 168; // 7 days

#[program]
pub mod governance {
    use super::*;

    // ─── Initialization ─────────────────────────────────────────────

    pub fn initialize(
        ctx: Context<Initialize>,
        default_premium: u64,
        default_payoff: u64,
        default_delay_hours: u32,
    ) -> Result<()> {
        require!(
            default_delay_hours > 0 && default_delay_hours <= MAX_DELAY_HOURS,
            GovernanceError::InvalidDelayHours
        );

        let config = &mut ctx.accounts.config;
        config.owner = ctx.accounts.owner.key();
        config.default_premium = default_premium;
        config.default_payoff = default_payoff;
        config.default_delay_hours = default_delay_hours;
        config.route_count = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    // ─── Global defaults ────────────────────────────────────────────

    pub fn set_defaults(
        ctx: Context<OwnerOnly>,
        premium: u64,
        payoff: u64,
        delay_hours: u32,
    ) -> Result<()> {
        require!(
            delay_hours > 0 && delay_hours <= MAX_DELAY_HOURS,
            GovernanceError::InvalidDelayHours
        );
        let config = &mut ctx.accounts.config;
        config.default_premium = premium;
        config.default_payoff = payoff;
        config.default_delay_hours = delay_hours;
        Ok(())
    }

    // ─── Route management ───────────────────────────────────────────

    /// Whitelist a route. Idempotent (D4): creates the `RouteAccount` PDA on
    /// first call, or re-activates an already-existing (possibly disabled)
    /// route on subsequent calls. The PDA seeds bind `(flight_id, origin,
    /// destination)` — re-init cannot change identity. Authorization is the
    /// owner OR an active admin.
    pub fn whitelist_route(
        ctx: Context<RouteWrite>,
        flight_id: String,
        origin: String,
        destination: String,
        premium: Option<u64>,
        payoff: Option<u64>,
        delay_hours: Option<u32>,
    ) -> Result<()> {
        validate_route_lengths(&flight_id, &origin, &destination)?;
        if let Some(d) = delay_hours {
            require!(
                d > 0 && d <= MAX_DELAY_HOURS,
                GovernanceError::InvalidDelayHours
            );
        }
        require_owner_or_active_admin(&ctx.accounts.config, &ctx.accounts.caller, &ctx.accounts.admin_record)?;

        let route = &mut ctx.accounts.route;
        let is_new = route.flight_id.is_empty();

        route.flight_id = flight_id;
        route.origin = origin;
        route.destination = destination;
        route.premium = premium;
        route.payoff = payoff;
        route.delay_hours = delay_hours;
        route.approved = true;
        route.bump = ctx.bumps.route;

        if is_new {
            ctx.accounts.config.route_count = ctx
                .accounts
                .config
                .route_count
                .checked_add(1)
                .ok_or(GovernanceError::Overflow)?;
        }
        Ok(())
    }

    pub fn disable_route(
        ctx: Context<RouteMutate>,
        flight_id: String,
        origin: String,
        destination: String,
    ) -> Result<()> {
        let _ = (flight_id, origin, destination); // bound by `#[instruction(...)]`, used in seeds.
        require_owner_or_active_admin(&ctx.accounts.config, &ctx.accounts.caller, &ctx.accounts.admin_record)?;
        ctx.accounts.route.approved = false;
        Ok(())
    }

    /// Update a route's per-field overrides using the tri-state enum (D2).
    /// `Keep` leaves the field unchanged; `Set(v)` writes a new override;
    /// `RevertToDefault` clears the override so future reads fall back to
    /// the global defaults stored on `GovernanceConfig`.
    pub fn update_route_terms(
        ctx: Context<RouteMutate>,
        flight_id: String,
        origin: String,
        destination: String,
        premium: U64Update,
        payoff: U64Update,
        delay_hours: U32Update,
    ) -> Result<()> {
        let _ = (flight_id, origin, destination);
        require_owner_or_active_admin(&ctx.accounts.config, &ctx.accounts.caller, &ctx.accounts.admin_record)?;
        if let U32Update::Set(d) = delay_hours {
            require!(
                d > 0 && d <= MAX_DELAY_HOURS,
                GovernanceError::InvalidDelayHours
            );
        }

        let route = &mut ctx.accounts.route;
        route.premium = premium.apply(route.premium);
        route.payoff = payoff.apply(route.payoff);
        route.delay_hours = delay_hours.apply(route.delay_hours);
        Ok(())
    }

    // ─── Admin management ───────────────────────────────────────────

    /// Add (or re-activate) an admin. Idempotent (D4): if the `AdminRecord`
    /// PDA already exists (e.g. previously removed), `is_active` is flipped
    /// back to `true`. The `admin` pubkey is bound by the PDA seeds, so
    /// re-init cannot change which admin is active.
    pub fn add_admin(ctx: Context<AddAdmin>, admin: Pubkey) -> Result<()> {
        let record = &mut ctx.accounts.admin_record;
        record.admin = admin;
        record.is_active = true;
        record.bump = ctx.bumps.admin_record;
        Ok(())
    }

    pub fn remove_admin(ctx: Context<RemoveAdmin>, admin: Pubkey) -> Result<()> {
        let _ = admin; // bound by `#[instruction(...)]`, used in seeds.
        ctx.accounts.admin_record.is_active = false;
        Ok(())
    }

    // ─── Reader instructions (D3) ───────────────────────────────────

    /// Resolve and return the effective terms for a route. Anchor encodes
    /// the returned `ResolvedTerms` via `set_return_data` so callers
    /// (controller program in Phase 5, or off-chain simulators) can decode
    /// it from the transaction's return-data slot. Reverts if the route is
    /// disabled.
    pub fn get_route_terms(
        ctx: Context<GetRouteTerms>,
        flight_id: String,
        origin: String,
        destination: String,
    ) -> Result<ResolvedTerms> {
        let _ = (flight_id, origin, destination);
        let config = &ctx.accounts.config;
        let route = &ctx.accounts.route;
        require!(route.approved, GovernanceError::RouteDisabled);

        Ok(ResolvedTerms {
            premium: route.premium.unwrap_or(config.default_premium),
            payoff: route.payoff.unwrap_or(config.default_payoff),
            delay_hours: route.delay_hours.unwrap_or(config.default_delay_hours),
        })
    }

    /// Returns whether a route exists AND is approved. Never reverts on a
    /// missing PDA — this is the "is the route a thing yet" probe (D3). The
    /// caller passes the candidate `RouteAccount` PDA as an
    /// `UncheckedAccount`; we verify the address derives from the seeds and
    /// its owner is this program before reading.
    pub fn is_route_whitelisted(
        ctx: Context<IsRouteWhitelisted>,
        flight_id: String,
        origin: String,
        destination: String,
    ) -> Result<bool> {
        validate_route_lengths(&flight_id, &origin, &destination)?;

        let route_info = &ctx.accounts.route;
        let (expected, _bump) = Pubkey::find_program_address(
            &[
                b"route",
                flight_id.as_bytes(),
                origin.as_bytes(),
                destination.as_bytes(),
            ],
            &crate::ID,
        );
        if route_info.key() != expected {
            return err!(GovernanceError::RoutePdaMismatch);
        }

        // Missing or system-owned account → not whitelisted. The
        // `lamports() == 0` + system-program-owner pair is the canonical
        // "does not exist" check for an uninitialised PDA.
        if route_info.lamports() == 0 || route_info.owner == &system_program::ID {
            return Ok(false);
        }
        if route_info.owner != &crate::ID {
            // PDA exists but owned by a different program — refuse to read.
            return err!(GovernanceError::InvalidRouteOwner);
        }
        let data = route_info.try_borrow_data()?;
        // Anchor account layout: [8-byte discriminator | borsh(struct)].
        // Borsh-decoding the whole struct is safer than hand-counted
        // offsets that would drift if `RouteAccount` ever changes.
        let route = RouteAccount::try_deserialize(&mut &data[..])
            .map_err(|_| GovernanceError::RouteDeserializeFailed)?;
        Ok(route.approved)
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

fn validate_route_lengths(flight_id: &str, origin: &str, destination: &str) -> Result<()> {
    require!(
        flight_id.len() <= MAX_FLIGHT_ID_LEN
            && origin.len() <= MAX_ORIGIN_LEN
            && destination.len() <= MAX_DEST_LEN,
        GovernanceError::RouteFieldTooLong
    );
    require!(
        !flight_id.is_empty() && !origin.is_empty() && !destination.is_empty(),
        GovernanceError::RouteFieldEmpty
    );
    Ok(())
}

fn require_owner_or_active_admin<'info>(
    config: &Account<'info, GovernanceConfig>,
    caller: &Signer<'info>,
    admin_record: &Option<Account<'info, AdminRecord>>,
) -> Result<()> {
    if caller.key() == config.owner {
        return Ok(());
    }
    let record = admin_record
        .as_ref()
        .ok_or(GovernanceError::UnauthorizedAdmin)?;
    require!(
        record.admin == caller.key() && record.is_active,
        GovernanceError::UnauthorizedAdmin
    );
    Ok(())
}

// ─── Accounts: initialize ──────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + GovernanceConfig::INIT_SPACE,
        seeds = [b"governance_config"],
        bump,
    )]
    pub config: Account<'info, GovernanceConfig>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ─── Accounts: owner-only mutations ────────────────────────────────────────

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(
        mut,
        seeds = [b"governance_config"],
        bump = config.bump,
        has_one = owner @ GovernanceError::UnauthorizedAdmin,
    )]
    pub config: Account<'info, GovernanceConfig>,

    pub owner: Signer<'info>,
}

// ─── Accounts: route write (whitelist — init_if_needed) ───────────────────

#[derive(Accounts)]
#[instruction(flight_id: String, origin: String, destination: String)]
pub struct RouteWrite<'info> {
    #[account(
        mut,
        seeds = [b"governance_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GovernanceConfig>,

    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + RouteAccount::INIT_SPACE,
        seeds = [b"route", flight_id.as_bytes(), origin.as_bytes(), destination.as_bytes()],
        bump,
    )]
    pub route: Account<'info, RouteAccount>,

    /// Optional admin record — required when caller != config.owner. Anchor
    /// resolves this via the seeds; clients omit it (pass `None`/`null` in
    /// generated TS) when calling as the owner.
    #[account(
        seeds = [b"admin", caller.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Option<Account<'info, AdminRecord>>,

    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ─── Accounts: route mutate (disable / update — must already exist) ───────

#[derive(Accounts)]
#[instruction(flight_id: String, origin: String, destination: String)]
pub struct RouteMutate<'info> {
    #[account(
        seeds = [b"governance_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GovernanceConfig>,

    #[account(
        mut,
        seeds = [b"route", flight_id.as_bytes(), origin.as_bytes(), destination.as_bytes()],
        bump = route.bump,
    )]
    pub route: Account<'info, RouteAccount>,

    #[account(
        seeds = [b"admin", caller.key().as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Option<Account<'info, AdminRecord>>,

    pub caller: Signer<'info>,
}

// ─── Accounts: admin management ────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(admin: Pubkey)]
pub struct AddAdmin<'info> {
    #[account(
        seeds = [b"governance_config"],
        bump = config.bump,
        has_one = owner @ GovernanceError::UnauthorizedAdmin,
    )]
    pub config: Account<'info, GovernanceConfig>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + AdminRecord::INIT_SPACE,
        seeds = [b"admin", admin.as_ref()],
        bump,
    )]
    pub admin_record: Account<'info, AdminRecord>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(admin: Pubkey)]
pub struct RemoveAdmin<'info> {
    #[account(
        seeds = [b"governance_config"],
        bump = config.bump,
        has_one = owner @ GovernanceError::UnauthorizedAdmin,
    )]
    pub config: Account<'info, GovernanceConfig>,

    #[account(
        mut,
        seeds = [b"admin", admin.as_ref()],
        bump = admin_record.bump,
    )]
    pub admin_record: Account<'info, AdminRecord>,

    pub owner: Signer<'info>,
}

// ─── Accounts: reader instructions ────────────────────────────────────────

#[derive(Accounts)]
#[instruction(flight_id: String, origin: String, destination: String)]
pub struct GetRouteTerms<'info> {
    #[account(
        seeds = [b"governance_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GovernanceConfig>,

    #[account(
        seeds = [b"route", flight_id.as_bytes(), origin.as_bytes(), destination.as_bytes()],
        bump = route.bump,
    )]
    pub route: Account<'info, RouteAccount>,
}

#[derive(Accounts)]
pub struct IsRouteWhitelisted<'info> {
    /// Untyped — the route may not exist. The handler verifies the address
    /// derives from the seeds and the owner is this program before reading.
    /// CHECK: seed + owner validation performed in handler body.
    pub route: UncheckedAccount<'info>,
}

// ─── Account data ──────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct GovernanceConfig {
    pub owner: Pubkey,
    pub default_premium: u64,
    pub default_payoff: u64,
    pub default_delay_hours: u32,
    pub route_count: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RouteAccount {
    #[max_len(MAX_FLIGHT_ID_LEN)]
    pub flight_id: String,
    #[max_len(MAX_ORIGIN_LEN)]
    pub origin: String,
    #[max_len(MAX_DEST_LEN)]
    pub destination: String,
    pub premium: Option<u64>,
    pub payoff: Option<u64>,
    pub delay_hours: Option<u32>,
    pub approved: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AdminRecord {
    pub admin: Pubkey,
    pub is_active: bool,
    pub bump: u8,
}

// ─── Return type for `get_route_terms` ────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ResolvedTerms {
    pub premium: u64,
    pub payoff: u64,
    pub delay_hours: u32,
}

// ─── Tri-state field updates (D2) ─────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum U64Update {
    Keep,
    Set(u64),
    RevertToDefault,
}

impl U64Update {
    fn apply(&self, current: Option<u64>) -> Option<u64> {
        match self {
            U64Update::Keep => current,
            U64Update::Set(v) => Some(*v),
            U64Update::RevertToDefault => None,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum U32Update {
    Keep,
    Set(u32),
    RevertToDefault,
}

impl U32Update {
    fn apply(&self, current: Option<u32>) -> Option<u32> {
        match self {
            U32Update::Keep => current,
            U32Update::Set(v) => Some(*v),
            U32Update::RevertToDefault => None,
        }
    }
}

// ─── Errors ───────────────────────────────────────────────────────────────

#[error_code]
pub enum GovernanceError {
    #[msg("Caller is neither the owner nor an active admin.")]
    UnauthorizedAdmin,
    #[msg("Route does not exist.")]
    RouteNotFound,
    #[msg("Route exists but is disabled.")]
    RouteDisabled,
    #[msg("Route field exceeds the configured length cap.")]
    RouteFieldTooLong,
    #[msg("Route field is empty.")]
    RouteFieldEmpty,
    #[msg("AdminRecord PDA not found.")]
    AdminNotFound,
    #[msg("delay_hours must be > 0 and ≤ 168.")]
    InvalidDelayHours,
    #[msg("Route account address does not match the expected PDA.")]
    RoutePdaMismatch,
    #[msg("Route account is owned by a different program.")]
    InvalidRouteOwner,
    #[msg("Failed to deserialize RouteAccount.")]
    RouteDeserializeFailed,
    #[msg("Arithmetic overflow.")]
    Overflow,
}
