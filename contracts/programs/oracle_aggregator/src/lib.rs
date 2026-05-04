//! Sentinel — oracle_aggregator program (Phase 0 no-op skeleton).
//!
//! Phase 4 will implement:
//!   - OracleConfig (owner, authorized_oracle, authorized_consumer)
//!   - FlightData accounts (NotInitiated → Active → Landed/Cancelled →
//!     ToBeSettled* → Settled)
//!   - Oracle-keyed: set_estimated_arrival / set_landed / set_cancelled
//!   - Consumer-keyed (controller PDA): init_flight_data / set_to_be_settled /
//!     set_settled
//!   - Owner-keyed: set_authorized_oracle / set_authorized_consumer

use anchor_lang::prelude::*;

declare_id!("GLSr6Ve5a34e5Pw1kS8cWX3EbjdDYkQ9eim2CvvbWgdD");

#[program]
pub mod oracle_aggregator {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.bump = ctx.bumps.state;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + OracleConfig::INIT_SPACE,
        seeds = [b"oracle_config"],
        bump,
    )]
    pub state: Account<'info, OracleConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct OracleConfig {
    pub bump: u8,
}
