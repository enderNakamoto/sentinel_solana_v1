//! Sentinel — oracle_aggregator program.
//!
//! The flight-data feed. Owns `FlightData` accounts and is the only program
//! the `authorized_oracle` keypair can sign for. Holds zero funds — no SPL
//! Token CPIs anywhere. Three authority types govern access:
//!
//!   - `owner`: initialize + rotate oracle + one-shot wire consumer
//!   - `authorized_oracle` (FlightDataFetcher cron): set_estimated_arrival
//!     / set_landed / set_cancelled — reads off-chain flight status
//!   - `authorized_consumer` (controller_program's `ControllerConfig` PDA,
//!     set once via `set_authorized_consumer`): init_flight_data /
//!     set_to_be_settled / set_settled — drives the settlement pipeline
//!
//! Forward-only state machine on `FlightStatus`:
//!
//!   ```text
//!   NotInitiated → Active → Landed ──► ToBeSettledOnTime ──► Settled
//!                     │                 ToBeSettledDelayed ──► Settled
//!                     └──► Cancelled ► ToBeSettledCancelled ► Settled
//!   ```
//!
//! `set_to_be_settled` enforces strict (current → new) pairing per Phase 4
//! D5: Landed may only become OnTime/Delayed; Cancelled may only become
//! Cancelled. Reverse transitions revert with `InvalidStateTransition`.
//!
//! See `spec/architecture.md` §oracle_aggregator_program and
//! `spec/phases/phase-04-oracle-aggregator-program.md` for locked decisions
//! D1–D13.

use anchor_lang::prelude::*;

declare_id!("EmTfS5EjPRABDuDrM5AW5TWi73eCCJnejpLAcwaxMCr6");

// ─── Constants ────────────────────────────────────────────────────────────
// Match Phase 1 governance D1 + Phase 3 flight_pool D1: a route whitelisted
// with up to 16 bytes of `flight_id` must round-trip cleanly through the
// oracle's `init_flight_data` and the per-flight setters.
pub const MAX_FLIGHT_ID_LEN: usize = 16;

#[program]
pub mod oracle_aggregator {
    use super::*;

    // ─── Initialization (owner-only) ───────────────────────────────

    pub fn initialize(ctx: Context<Initialize>, authorized_oracle: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.owner = ctx.accounts.owner.key();
        config.authorized_oracle = authorized_oracle;
        // `Pubkey::default()` is the unset sentinel for `authorized_consumer`.
        // No real PDA / signer would have that pubkey, and the
        // `is_consumer_set` flag is the canonical "is the consumer wired?"
        // check (see D8).
        config.authorized_consumer = Pubkey::default();
        config.is_consumer_set = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Owner rotates the authorized oracle. No `is_oracle_set` flag —
    /// the oracle is freely rotatable for hot-key rotation flows.
    pub fn set_authorized_oracle(
        ctx: Context<SetAuthorizedOracle>,
        new_oracle: Pubkey,
    ) -> Result<()> {
        ctx.accounts.config.authorized_oracle = new_oracle;
        Ok(())
    }

    /// Owner wires the controller's `ControllerConfig` PDA as the
    /// authorized consumer. Settable once — subsequent calls revert.
    /// Mirrors Phase 2/3 `set_controller`.
    pub fn set_authorized_consumer(
        ctx: Context<SetAuthorizedConsumer>,
        consumer: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.is_consumer_set, OracleError::ConsumerAlreadySet);
        config.authorized_consumer = consumer;
        config.is_consumer_set = true;
        Ok(())
    }

    // ─── Consumer-only (controller PDA) ────────────────────────────

    /// Creates a new `FlightData` PDA in `NotInitiated`. Strict `init` —
    /// re-initialisation reverts via PDA collision (D6).
    pub fn init_flight_data(
        ctx: Context<InitFlightData>,
        flight_id: String,
        date: u64,
    ) -> Result<()> {
        validate_flight_id(&flight_id)?;
        require!(
            ctx.accounts.config.is_consumer_set,
            OracleError::ConsumerNotSet
        );

        let fd = &mut ctx.accounts.flight_data;
        fd.flight_id = flight_id;
        fd.date = date;
        fd.status = FlightStatus::NotInitiated;
        fd.estimated_arrival_time = 0;
        fd.actual_arrival_time = 0;
        fd.bump = ctx.bumps.flight_data;
        Ok(())
    }

    /// `Landed`/`Cancelled → ToBeSettled*`. Strict (current → new) pairing
    /// per D5: a Landed flight cannot be classified as cancelled, and a
    /// cancelled flight cannot be classified as flown.
    pub fn set_to_be_settled(
        ctx: Context<SetFlightStatus>,
        flight_id: String,
        date: u64,
        new_status: FlightStatus,
    ) -> Result<()> {
        let _ = (flight_id, date);
        require!(
            ctx.accounts.config.is_consumer_set,
            OracleError::ConsumerNotSet
        );
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authorized_consumer,
            OracleError::UnauthorizedConsumer
        );

        // (1) `new_status` must be a `ToBeSettled*` variant.
        require!(
            matches!(
                new_status,
                FlightStatus::ToBeSettledOnTime
                    | FlightStatus::ToBeSettledDelayed
                    | FlightStatus::ToBeSettledCancelled
            ),
            OracleError::InvalidToBeSettledVariant
        );

        // (2) Strict (current → new) pairing.
        let current = ctx.accounts.flight_data.status;
        let allowed = match current {
            FlightStatus::Landed => matches!(
                new_status,
                FlightStatus::ToBeSettledOnTime | FlightStatus::ToBeSettledDelayed
            ),
            FlightStatus::Cancelled => matches!(new_status, FlightStatus::ToBeSettledCancelled),
            _ => false,
        };
        require!(allowed, OracleError::InvalidStateTransition);

        ctx.accounts.flight_data.status = new_status;
        Ok(())
    }

    /// `ToBeSettled* → Settled`. Terminal transition — no instruction has
    /// `Settled` as the expected current.
    pub fn set_settled(
        ctx: Context<SetFlightStatus>,
        flight_id: String,
        date: u64,
    ) -> Result<()> {
        let _ = (flight_id, date);
        require!(
            ctx.accounts.config.is_consumer_set,
            OracleError::ConsumerNotSet
        );
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authorized_consumer,
            OracleError::UnauthorizedConsumer
        );

        let current = ctx.accounts.flight_data.status;
        require!(
            matches!(
                current,
                FlightStatus::ToBeSettledOnTime
                    | FlightStatus::ToBeSettledDelayed
                    | FlightStatus::ToBeSettledCancelled
            ),
            OracleError::InvalidStateTransition
        );

        ctx.accounts.flight_data.status = FlightStatus::Settled;
        Ok(())
    }

    // ─── Oracle-only (FlightDataFetcher cron) ──────────────────────

    /// `NotInitiated → Active`. Records the off-chain estimated arrival
    /// time (unix seconds). Stores it raw without bounds-checking — the
    /// cron is trusted to submit sane values; D13 keeps stale-ETA
    /// rejection out of scope.
    pub fn set_estimated_arrival(
        ctx: Context<SetFlightStatus>,
        flight_id: String,
        date: u64,
        eta: i64,
    ) -> Result<()> {
        let _ = (flight_id, date);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authorized_oracle,
            OracleError::UnauthorizedOracle
        );
        let fd = &mut ctx.accounts.flight_data;
        require!(
            fd.status == FlightStatus::NotInitiated,
            OracleError::InvalidStateTransition
        );
        fd.status = FlightStatus::Active;
        fd.estimated_arrival_time = eta;
        Ok(())
    }

    /// `Active → Landed`. Records actual arrival time.
    pub fn set_landed(
        ctx: Context<SetFlightStatus>,
        flight_id: String,
        date: u64,
        actual_arrival: i64,
    ) -> Result<()> {
        let _ = (flight_id, date);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authorized_oracle,
            OracleError::UnauthorizedOracle
        );
        let fd = &mut ctx.accounts.flight_data;
        require!(
            fd.status == FlightStatus::Active,
            OracleError::InvalidStateTransition
        );
        fd.status = FlightStatus::Landed;
        fd.actual_arrival_time = actual_arrival;
        Ok(())
    }

    /// `Active → Cancelled`. No `actual_arrival_time` write — the flight
    /// never landed.
    pub fn set_cancelled(
        ctx: Context<SetFlightStatus>,
        flight_id: String,
        date: u64,
    ) -> Result<()> {
        let _ = (flight_id, date);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authorized_oracle,
            OracleError::UnauthorizedOracle
        );
        let fd = &mut ctx.accounts.flight_data;
        require!(
            fd.status == FlightStatus::Active,
            OracleError::InvalidStateTransition
        );
        fd.status = FlightStatus::Cancelled;
        Ok(())
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

fn validate_flight_id(flight_id: &str) -> Result<()> {
    require!(!flight_id.is_empty(), OracleError::FlightIdEmpty);
    require!(
        flight_id.len() <= MAX_FLIGHT_ID_LEN,
        OracleError::FlightIdTooLong
    );
    Ok(())
}

// ─── Accounts: initialize ──────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + OracleConfig::INIT_SPACE,
        seeds = [b"oracle_config_v2"],
        bump,
    )]
    pub config: Account<'info, OracleConfig>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ─── Accounts: owner-only setters ──────────────────────────────────────────

#[derive(Accounts)]
pub struct SetAuthorizedOracle<'info> {
    #[account(
        mut,
        seeds = [b"oracle_config_v2"],
        bump = config.bump,
        has_one = owner @ OracleError::UnauthorizedOwner,
    )]
    pub config: Account<'info, OracleConfig>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetAuthorizedConsumer<'info> {
    #[account(
        mut,
        seeds = [b"oracle_config_v2"],
        bump = config.bump,
        has_one = owner @ OracleError::UnauthorizedOwner,
    )]
    pub config: Account<'info, OracleConfig>,
    pub owner: Signer<'info>,
}

// ─── Accounts: consumer-only setters that write FlightData ─────────────────

#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct InitFlightData<'info> {
    #[account(
        seeds = [b"oracle_config_v2"],
        bump = config.bump,
        has_one = authorized_consumer @ OracleError::UnauthorizedConsumer,
    )]
    pub config: Account<'info, OracleConfig>,

    #[account(
        init,
        payer = rent_payer,
        space = 8 + FlightData::INIT_SPACE,
        seeds = [b"flight", flight_id.as_bytes(), &date.to_le_bytes()],
        bump,
    )]
    pub flight_data: Account<'info, FlightData>,

    /// Authority. In production this is the controller_program's
    /// `ControllerConfig` PDA (signed via `invoke_signed`). In Phase 4
    /// unit tests it's a regular keypair set by `set_authorized_consumer`.
    pub authorized_consumer: Signer<'info>,

    /// Rent-payer for the new `FlightData` PDA. Must be a system-owned
    /// signer (a PDA cannot be a system_program::create_account payer).
    /// In production this is the traveler making the first-buy via the
    /// controller's CPI chain. See Phase 5 D18.
    #[account(mut)]
    pub rent_payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Shared accounts struct for the five status-mutator instructions
/// (`set_estimated_arrival`, `set_landed`, `set_cancelled`,
/// `set_to_be_settled`, `set_settled`). The same set of accounts is
/// validated each time; per-ix authority is enforced inside the handler
/// via the constraints below.
///
/// Authority gating uses Anchor's `has_one` on `OracleConfig`. Each call
/// site declares which authority it expects:
///   - oracle-only ix: `has_one = authorized_oracle`
///   - consumer-only ix: `has_one = authorized_consumer`
///
/// We use TWO concrete accounts structs to make this declarative —
/// `OracleAuthMutate` and `ConsumerAuthMutate` — instead of one generic
/// struct, so the IDL and Codama generated clients are precise about
/// which signer is required.
#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct SetFlightStatus<'info> {
    #[account(
        seeds = [b"oracle_config_v2"],
        bump = config.bump,
    )]
    pub config: Account<'info, OracleConfig>,

    #[account(
        mut,
        seeds = [b"flight", flight_id.as_bytes(), &date.to_le_bytes()],
        bump = flight_data.bump,
    )]
    pub flight_data: Account<'info, FlightData>,

    /// Authority for THIS invocation. The handler enforces oracle-vs-
    /// consumer matching via the constraint expressions below: for
    /// oracle-keyed ix (`set_estimated_arrival`, `set_landed`,
    /// `set_cancelled`) we constrain `authority.key() ==
    /// config.authorized_oracle`; for consumer-keyed ix
    /// (`set_to_be_settled`, `set_settled`) we constrain `authority.key()
    /// == config.authorized_consumer`.
    ///
    /// We can't use Anchor's `has_one` here because the same struct is
    /// reused across both authority classes — the constraint must be
    /// expressed in the handler. Instead, the handler-level checks below
    /// enforce it. This is acceptable for Phase 4 because each instruction
    /// branch knows which authority class it requires.
    pub authority: Signer<'info>,
}

// Each instruction body inlines its own auth check via:
//   - oracle-keyed: `require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.config.authorized_oracle, OracleError::UnauthorizedOracle)`
//   - consumer-keyed: `require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.config.authorized_consumer, OracleError::UnauthorizedConsumer)`
//
// We do this in the handler rather than via `#[derive(Accounts)]` so that
// the SAME accounts struct works across all 5 status-mutator instructions
// — which keeps the IDL surface tight (one Accounts struct vs five) and
// the Codama-generated client uniform.

// ─── Account data ──────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct OracleConfig {
    pub owner: Pubkey,
    pub authorized_oracle: Pubkey,
    pub authorized_consumer: Pubkey,
    pub is_consumer_set: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FlightData {
    #[max_len(MAX_FLIGHT_ID_LEN)]
    pub flight_id: String,
    pub date: u64,
    pub status: FlightStatus,
    /// `0` is the unset sentinel for both arrival times. Real-world ETAs
    /// are far-future timestamps, so `0` is unambiguous in practice.
    pub estimated_arrival_time: i64,
    pub actual_arrival_time: i64,
    pub bump: u8,
}

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

// ─── Errors ───────────────────────────────────────────────────────────────

#[error_code]
pub enum OracleError {
    #[msg("Caller is not the configured owner.")]
    UnauthorizedOwner,
    #[msg("Caller is not the configured authorized oracle.")]
    UnauthorizedOracle,
    #[msg("Caller is not the configured authorized consumer.")]
    UnauthorizedConsumer,
    #[msg("Authorized consumer is already set; this is a one-shot wiring.")]
    ConsumerAlreadySet,
    #[msg("Authorized consumer has not been wired yet — call set_authorized_consumer first.")]
    ConsumerNotSet,
    #[msg("State transition is not allowed by the forward-only state machine.")]
    InvalidStateTransition,
    #[msg("`new_status` is not a ToBeSettled* variant.")]
    InvalidToBeSettledVariant,
    #[msg("flight_id is empty.")]
    FlightIdEmpty,
    #[msg("flight_id exceeds MAX_FLIGHT_ID_LEN.")]
    FlightIdTooLong,
}
