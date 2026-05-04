//! Sentinel — flight_pool program (Phase 0 no-op skeleton).
//!
//! Phase 3 will implement:
//!   - FlightPoolConfig + FlightPool + BuyerRecord + pool_treasury (token account)
//!   - controller-gated: register_pool / add_buyer / settle_on_time /
//!     settle_delayed / settle_cancelled
//!   - traveler: claim
//!   - anyone: sweep_expired
//!   - owner: withdraw_recovered

use anchor_lang::prelude::*;

declare_id!("GRQgy7DqWRmMSJbxRPrPdZ8NTqamwVtzEtfFgcC2b4kS");

#[program]
pub mod flight_pool {
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
        space = 8 + FlightPoolConfig::INIT_SPACE,
        seeds = [b"flight_pool_config"],
        bump,
    )]
    pub state: Account<'info, FlightPoolConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct FlightPoolConfig {
    pub bump: u8,
}
