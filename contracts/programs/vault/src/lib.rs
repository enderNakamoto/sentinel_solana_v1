//! Sentinel — vault program (Phase 0 no-op skeleton).
//!
//! Phase 2 will implement:
//!   - VaultState + WithdrawalQueue + ClaimableBalance + SnapshotRecord
//!   - RVS share mint owned by vault PDA
//!   - deposit / redeem / request_withdrawal / cancel_withdrawal / collect
//!   - controller-gated: increase_locked / decrease_locked / send_payout /
//!     record_premium_income / process_withdrawal_queue / snapshot

use anchor_lang::prelude::*;

declare_id!("72r2c1RA5xsd9SgCquJLnNom11R7jMaaMTGbcdi26L9U");

#[program]
pub mod vault {
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
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vault_state"],
        bump,
    )]
    pub state: Account<'info, VaultState>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub bump: u8,
}
