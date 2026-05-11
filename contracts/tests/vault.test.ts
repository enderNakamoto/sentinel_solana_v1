/**
 * Phase 2 — vault program unit tests.
 *
 * Coverage map (subtask numbers from spec/phases/phase-02-vault-program.md §4):
 *   4.1  initialize: state, mint, ATA wired correctly
 *   4.2  set_controller: owner-only + once-only
 *   4.3  deposit math + virtual offset
 *   4.4  direct USDC transfer no-op vs share price
 *   4.5  redeem happy path
 *   4.6  redeem reverts when free_capital insufficient
 *   4.7  request_withdrawal enqueues correctly + burns shares
 *   4.8  request_withdrawal reverts on insufficient shares
 *   4.9  cancel_withdrawal: auth + FIFO preservation + share re-mint
 *   4.10 controller-only revert paths (parameterised)
 *   4.11 increase_locked / decrease_locked
 *   4.12 record_premium_income
 *   4.13 send_payout
 *   4.14 process_withdrawal_queue: FIFO drain via remaining_accounts
 *   4.15 collect: drain + nothing-to-collect revert
 *   4.16 snapshot: per-day idempotency + advanceClock
 *   4.17 inflation attack defense
 *
 * All tests use Codama-generated typed Kit instruction builders from
 * `tests/clients/vault/`. No hand-rolled discriminators.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccountRole,
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

import {
  advanceClock,
  bootstrapVault,
  createMockPusdMint,
  getAtaAddress,
  getTokenAccountAmount,
  makeClient,
  mintMockPusdTo,
  setTokenAccount,
  TOKEN_2022_PROGRAM_ID_KIT,
  type VaultBootstrap,
} from './setup.ts';

import {
  VAULT_PROGRAM_ADDRESS,
  // Account decoders
  getVaultStateDecoder,
  getWithdrawalQueueDecoder,
  getClaimableBalanceDecoder,
  getSnapshotRecordDecoder,
  // PDA helpers
  findClaimablePda,
  findSnapshotRecordPda,
  // Instruction builders
  getCancelWithdrawalInstructionAsync,
  getCollectInstructionAsync,
  getDecreaseLockedInstruction,
  getDepositInstructionAsync,
  getIncreaseLockedInstruction,
  getProcessWithdrawalQueueInstructionAsync,
  getRecordPremiumIncomeInstruction,
  getRedeemInstructionAsync,
  getRequestWithdrawalInstructionAsync,
  getSendPayoutInstructionAsync,
  getSetControllerInstruction,
  getSnapshotInstructionAsync,
} from './clients/vault/src/generated/index.ts';

// ─── Per-test fixture builder ────────────────────────────────────────────

type Client = Awaited<ReturnType<typeof makeClient>>;

interface Fixture {
  client: Client;
  vault: VaultBootstrap;
}

async function freshFixture(): Promise<Fixture> {
  const client = await makeClient();
  createMockPusdMint(client);
  const vault = await bootstrapVault(client);
  return { client, vault };
}

async function fundedSigner(client: Client): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  await client.airdrop(signer.address, lamports(2_000_000_000n)); // 2 SOL
  return signer;
}

function readAccount(client: Client, addr: Address): Uint8Array {
  const acc = client.svm.getAccount(addr);
  if (!acc.exists) throw new Error(`account ${addr} missing`);
  return acc.data;
}

/**
 * Set up a fully-prepared underwriter: airdropped, has a USDC ATA with
 * `usdc` units of mock-USDC, and a pre-created share-mint ATA (empty).
 * Returns the signer + both ATAs.
 */
async function makeUnderwriter(
  client: Client,
  vault: VaultBootstrap,
  usdc: bigint,
): Promise<{ signer: KeyPairSigner; usdcAta: Address; shareAta: Address }> {
  const signer = await fundedSigner(client);
  const { ata: usdcAta } = mintMockPusdTo(client, signer.address, usdc);
  const { ata: shareAta } = setTokenAccount(client, {
    mint: vault.shareMintPda,
    owner: signer.address,
    amount: 0n,
  });
  return { signer, usdcAta, shareAta };
}

/**
 * Wire a fresh test "controller" — a regular keypair that the vault's
 * `set_controller` accepts, used to authorise controller-only ix in
 * Phase 2 unit tests. (Phase 5 wires a real ControllerConfig PDA.)
 */
async function setMockController(
  f: Fixture,
): Promise<{ controller: KeyPairSigner }> {
  const controller = await fundedSigner(f.client);
  const ix = getSetControllerInstruction({
    vaultState: f.vault.vaultStatePda,
    owner: f.client.payer,
    controller: controller.address,
  });
  await f.client.sendTransaction([ix]);
  return { controller };
}

// ─── 4.1 initialize ──────────────────────────────────────────────────────

describe('Phase 2 — vault: initialize', () => {
  it('4.1 state, share mint, vault token account, and queue all wired', async () => {
    const { client, vault } = await freshFixture();

    const state = getVaultStateDecoder().decode(readAccount(client, vault.vaultStatePda));
    expect(state.owner).toBe(client.payer.address);
    expect(state.controller).toBe('11111111111111111111111111111111');
    expect(state.stableMint).toBe(vault.stableMint);
    expect(state.shareMint).toBe(vault.shareMintPda);
    expect(state.vaultTokenAccount).toBe(vault.vaultTokenAccount);
    expect(state.totalManagedAssets).toBe(0n);
    expect(state.lockedCapital).toBe(0n);
    expect(state.lastSnapshotTime).toBe(-1n); // never-snapshotted sentinel
    expect(state.withdrawalQueueCount).toBe(0);
    expect(state.isControllerSet).toBe(false);

    const queue = getWithdrawalQueueDecoder().decode(
      readAccount(client, vault.withdrawalQueuePda),
    );
    expect(queue.requests.length).toBe(0);

    // Share mint exists and is owned by the SPL Token program.
    const shareMintAcc = client.svm.getAccount(vault.shareMintPda);
    expect(shareMintAcc.exists).toBe(true);

    // Vault USDC token account exists at the canonical ATA.
    const vaultUsdcAcc = client.svm.getAccount(vault.vaultTokenAccount);
    expect(vaultUsdcAcc.exists).toBe(true);
  });
});

// ─── 4.2 set_controller ──────────────────────────────────────────────────

describe('Phase 2 — vault: set_controller', () => {
  let f: Fixture;
  beforeEach(async () => { f = await freshFixture(); });

  it('owner sets controller; second call reverts; non-owner reverts', async () => {
    const ctl1 = (await fundedSigner(f.client)).address;
    const ctl2 = (await fundedSigner(f.client)).address;

    // First call succeeds.
    await f.client.sendTransaction([
      getSetControllerInstruction({
        vaultState: f.vault.vaultStatePda,
        owner: f.client.payer,
        controller: ctl1,
      }),
    ]);
    const state1 = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(state1.controller).toBe(ctl1);
    expect(state1.isControllerSet).toBe(true);

    // Second call reverts.
    await expect(
      f.client.sendTransaction([
        getSetControllerInstruction({
          vaultState: f.vault.vaultStatePda,
          owner: f.client.payer,
          controller: ctl2,
        }),
      ]),
    ).rejects.toThrow();

    // Non-owner reverts (fresh fixture).
    const f2 = await freshFixture();
    const stranger = await fundedSigner(f2.client);
    await expect(
      f2.client.sendTransaction([
        getSetControllerInstruction({
          vaultState: f2.vault.vaultStatePda,
          owner: stranger,
          controller: ctl1,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.3 / 4.4 / 4.17 deposit math + virtual offset + inflation defense ─

describe('Phase 2 — vault: deposit math + inflation defense', () => {
  it('4.3 1 USDC → 1 share when supply=0/TMA=0; TMA & supply increment', async () => {
    const f = await freshFixture();
    const { signer, usdcAta, shareAta } = await makeUnderwriter(f.client, f.vault, 1n);

    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: usdcAta,
        depositorShareAccount: shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: signer,
        stableAmount: 1n,
      }),
    ]);

    const state = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(state.totalManagedAssets).toBe(1n);
    expect(getTokenAccountAmount(f.client, shareAta)).toBe(1n);
    expect(getTokenAccountAmount(f.client, usdcAta)).toBe(0n);
    expect(getTokenAccountAmount(f.client, f.vault.vaultTokenAccount)).toBe(1n);
  });

  it('4.4 direct USDC transfer to vault token account does NOT change TMA', async () => {
    const f = await freshFixture();
    const { signer, usdcAta, shareAta } = await makeUnderwriter(f.client, f.vault, 100n);

    // Honest first deposit: 1 USDC → 1 share.
    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: usdcAta,
        depositorShareAccount: shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: signer,
        stableAmount: 1n,
      }),
    ]);

    // "Donate" 1,000,000 USDC straight to the vault token account by
    // overwriting the packed Account state. TMA must NOT change.
    setTokenAccount(f.client, {
      mint: f.vault.stableMint,
      owner: f.vault.vaultStatePda,
      amount: 1_000_000n + 1n, // existing 1 + donation
    });

    const state = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(state.totalManagedAssets).toBe(1n); // unchanged
  });

  it('4.17 inflation attack: Bob still gets ~100 shares after Mallory inflates the vault', async () => {
    const f = await freshFixture();

    // Mallory deposits 1 unit USDC → 1 share.
    const mallory = await makeUnderwriter(f.client, f.vault, 1n);
    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: mallory.usdcAta,
        depositorShareAccount: mallory.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: mallory.signer,
        stableAmount: 1n,
      }),
    ]);
    expect(getTokenAccountAmount(f.client, mallory.shareAta)).toBe(1n);

    // Mallory pumps the vault token account directly with 1,000,000 USDC.
    setTokenAccount(f.client, {
      mint: f.vault.stableMint,
      owner: f.vault.vaultStatePda,
      amount: 1n + 1_000_000n,
    });

    // Bob deposits 100 USDC.
    const bob = await makeUnderwriter(f.client, f.vault, 100n);
    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: bob.usdcAta,
        depositorShareAccount: bob.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: bob.signer,
        stableAmount: 100n,
      }),
    ]);

    // floor(100 * (1 + 1000) / (1 + 1000)) = 100. Bob is NOT diluted.
    expect(getTokenAccountAmount(f.client, bob.shareAta)).toBe(100n);
  });
});

// ─── 4.5 / 4.6 redeem ────────────────────────────────────────────────────

describe('Phase 2 — vault: redeem', () => {
  it('4.5 redeem happy path — burns shares, transfers USDC, decrements TMA', async () => {
    const f = await freshFixture();
    const u = await makeUnderwriter(f.client, f.vault, 1000n);

    // Deposit 1000 USDC → ~1000 shares.
    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: u.usdcAta,
        depositorShareAccount: u.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: u.signer,
        stableAmount: 1000n,
      }),
    ]);

    // Redeem half.
    await f.client.sendTransaction([
      await getRedeemInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        redeemerShareAccount: u.shareAta,
        redeemerStableAccount: u.usdcAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        redeemer: u.signer,
        shares: 500n,
      }),
    ]);

    const state = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    // ceil(500 * (1000 + 1000) / (1000 + 1000)) = 500
    expect(state.totalManagedAssets).toBe(500n);
    expect(getTokenAccountAmount(f.client, u.shareAta)).toBe(500n);
    expect(getTokenAccountAmount(f.client, u.usdcAta)).toBe(500n);
  });

  it('4.6 redeem reverts when locked > free', async () => {
    const f = await freshFixture();
    const u = await makeUnderwriter(f.client, f.vault, 1000n);

    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: u.usdcAta,
        depositorShareAccount: u.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: u.signer,
        stableAmount: 1000n,
      }),
    ]);

    // Wire a controller and lock 950 USDC.
    const { controller } = await setMockController(f);
    await f.client.sendTransaction([
      getIncreaseLockedInstruction({
        vaultState: f.vault.vaultStatePda,
        controller,
        amount: 950n,
      }),
    ]);

    // Try to redeem 600 shares (≈600 USDC). Free is only 50 → revert.
    await expect(
      f.client.sendTransaction([
        await getRedeemInstructionAsync({
          vaultState: f.vault.vaultStatePda,
          shareMint: f.vault.shareMintPda,
          vaultTokenAccount: f.vault.vaultTokenAccount,
          redeemerShareAccount: u.shareAta,
          redeemerStableAccount: u.usdcAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
          redeemer: u.signer,
          shares: 600n,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.7 / 4.8 request_withdrawal ────────────────────────────────────────

describe('Phase 2 — vault: request_withdrawal', () => {
  it('4.7 enqueues, burns shares, debits TMA, pre-inits ClaimableBalance', async () => {
    const f = await freshFixture();
    const u = await makeUnderwriter(f.client, f.vault, 1000n);

    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: u.usdcAta,
        depositorShareAccount: u.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: u.signer,
        stableAmount: 1000n,
      }),
    ]);

    await f.client.sendTransaction([
      await getRequestWithdrawalInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        withdrawalQueue: f.vault.withdrawalQueuePda,
        shareMint: f.vault.shareMintPda,
        requesterShareAccount: u.shareAta,
        requester: u.signer,
        shares: 200n,
      }),
    ]);

    const state = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(state.withdrawalQueueCount).toBe(1);
    expect(state.totalManagedAssets).toBe(800n); // 1000 - 200 pending
    expect(getTokenAccountAmount(f.client, u.shareAta)).toBe(800n); // burned 200

    const queue = getWithdrawalQueueDecoder().decode(
      readAccount(f.client, f.vault.withdrawalQueuePda),
    );
    expect(queue.requests.length).toBe(1);
    expect(queue.requests[0].owner).toBe(u.signer.address);
    expect(queue.requests[0].shares).toBe(200n);
    expect(queue.requests[0].pendingAssets).toBe(200n);

    // ClaimableBalance PDA was pre-init'd with amount = 0.
    const [claimablePda] = await findClaimablePda({ collector: u.signer.address });
    expect(queue.requests[0].claimable).toBe(claimablePda);
    const claimable = getClaimableBalanceDecoder().decode(readAccount(f.client, claimablePda));
    expect(claimable.owner).toBe(u.signer.address);
    expect(claimable.amount).toBe(0n);
  });

  it('4.8 reverts when caller share balance < shares', async () => {
    const f = await freshFixture();
    const u = await makeUnderwriter(f.client, f.vault, 100n);

    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: u.usdcAta,
        depositorShareAccount: u.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: u.signer,
        stableAmount: 100n,
      }),
    ]);

    // Try to request 1000 shares — we only have ~100.
    await expect(
      f.client.sendTransaction([
        await getRequestWithdrawalInstructionAsync({
          vaultState: f.vault.vaultStatePda,
          withdrawalQueue: f.vault.withdrawalQueuePda,
          shareMint: f.vault.shareMintPda,
          requesterShareAccount: u.shareAta,
          requester: u.signer,
          shares: 1000n,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.9 cancel_withdrawal ───────────────────────────────────────────────

describe('Phase 2 — vault: cancel_withdrawal', () => {
  it('4.9 only owner can cancel; FIFO order preserved; shares re-minted', async () => {
    const f = await freshFixture();

    // Three underwriters each deposit and queue a withdrawal.
    const a = await makeUnderwriter(f.client, f.vault, 100n);
    const b = await makeUnderwriter(f.client, f.vault, 100n);
    const c = await makeUnderwriter(f.client, f.vault, 100n);

    for (const u of [a, b, c]) {
      await f.client.sendTransaction([
        await getDepositInstructionAsync({
          vaultState: f.vault.vaultStatePda,
          shareMint: f.vault.shareMintPda,
          vaultTokenAccount: f.vault.vaultTokenAccount,
          depositorStableAccount: u.usdcAta,
          depositorShareAccount: u.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
          depositor: u.signer,
          stableAmount: 100n,
        }),
      ]);
      await f.client.sendTransaction([
        await getRequestWithdrawalInstructionAsync({
          vaultState: f.vault.vaultStatePda,
          withdrawalQueue: f.vault.withdrawalQueuePda,
          shareMint: f.vault.shareMintPda,
          requesterShareAccount: u.shareAta,
          requester: u.signer,
          shares: 50n,
        }),
      ]);
    }

    // Stranger tries to cancel index 1 — reverts.
    const stranger = await fundedSigner(f.client);
    await expect(
      f.client.sendTransaction([
        await getCancelWithdrawalInstructionAsync({
          vaultState: f.vault.vaultStatePda,
          withdrawalQueue: f.vault.withdrawalQueuePda,
          shareMint: f.vault.shareMintPda,
          requesterShareAccount: b.shareAta,
          requester: stranger,
          queueIndex: 1,
        }),
      ]),
    ).rejects.toThrow();

    // B cancels index 1 (their own request). Ok.
    const sharesBefore = getTokenAccountAmount(f.client, b.shareAta)!;
    await f.client.sendTransaction([
      await getCancelWithdrawalInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        withdrawalQueue: f.vault.withdrawalQueuePda,
        shareMint: f.vault.shareMintPda,
        requesterShareAccount: b.shareAta,
        requester: b.signer,
        queueIndex: 1,
      }),
    ]);
    const sharesAfter = getTokenAccountAmount(f.client, b.shareAta)!;
    expect(sharesAfter - sharesBefore).toBe(50n); // 50 shares re-minted

    const queue = getWithdrawalQueueDecoder().decode(
      readAccount(f.client, f.vault.withdrawalQueuePda),
    );
    expect(queue.requests.length).toBe(2);
    expect(queue.requests[0].owner).toBe(a.signer.address);
    expect(queue.requests[1].owner).toBe(c.signer.address);
  });
});

// ─── 4.10 / 4.11 / 4.12 / 4.13 controller-only paths ────────────────────

describe('Phase 2 — vault: controller-only mutators', () => {
  let f: Fixture;
  let controller: KeyPairSigner;
  beforeEach(async () => {
    f = await freshFixture();
    ({ controller } = await setMockController(f));
  });

  it('4.10/4.11 increase/decrease_locked tracks correctly; non-controller reverts', async () => {
    // Deposit so TMA is 1000.
    const u = await makeUnderwriter(f.client, f.vault, 1000n);
    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: u.usdcAta,
        depositorShareAccount: u.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: u.signer,
        stableAmount: 1000n,
      }),
    ]);

    await f.client.sendTransaction([
      getIncreaseLockedInstruction({
        vaultState: f.vault.vaultStatePda,
        controller,
        amount: 400n,
      }),
    ]);
    let state = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(state.lockedCapital).toBe(400n);

    await f.client.sendTransaction([
      getDecreaseLockedInstruction({
        vaultState: f.vault.vaultStatePda,
        controller,
        amount: 300n,
      }),
    ]);
    state = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(state.lockedCapital).toBe(100n);

    // decrease_locked > locked reverts.
    await expect(
      f.client.sendTransaction([
        getDecreaseLockedInstruction({
          vaultState: f.vault.vaultStatePda,
          controller,
          amount: 999n,
        }),
      ]),
    ).rejects.toThrow();

    // Non-controller reverts.
    const stranger = await fundedSigner(f.client);
    await expect(
      f.client.sendTransaction([
        getIncreaseLockedInstruction({
          vaultState: f.vault.vaultStatePda,
          controller: stranger,
          amount: 1n,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('4.12 record_premium_income increases TMA without moving tokens', async () => {
    const before = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    const vaultUsdcBefore = getTokenAccountAmount(f.client, f.vault.vaultTokenAccount) ?? 0n;

    await f.client.sendTransaction([
      getRecordPremiumIncomeInstruction({
        vaultState: f.vault.vaultStatePda,
        controller,
        amount: 250n,
      }),
    ]);

    const after = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(after.totalManagedAssets - before.totalManagedAssets).toBe(250n);
    expect(getTokenAccountAmount(f.client, f.vault.vaultTokenAccount) ?? 0n).toBe(vaultUsdcBefore);
  });

  it('4.13 send_payout transfers from vault → recipient + decrements TMA', async () => {
    // Deposit 1000 so vault has USDC.
    const u = await makeUnderwriter(f.client, f.vault, 1000n);
    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: u.usdcAta,
        depositorShareAccount: u.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: u.signer,
        stableAmount: 1000n,
      }),
    ]);

    // Recipient is a fresh underwriter's USDC ATA.
    const recipient = await fundedSigner(f.client);
    const { ata: recipientAta } = mintMockPusdTo(f.client, recipient.address, 0n);

    await f.client.sendTransaction([
      await getSendPayoutInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        recipient: recipientAta,
        stableMint: f.vault.stableMint,
        controller,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        amount: 300n,
      }),
    ]);

    expect(getTokenAccountAmount(f.client, recipientAta)).toBe(300n);
    const state = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(state.totalManagedAssets).toBe(700n);
  });
});

// ─── 4.14 process_withdrawal_queue ──────────────────────────────────────

describe('Phase 2 — vault: process_withdrawal_queue', () => {
  it('4.14 walks FIFO, credits ClaimableBalance until free_capital exhausted', async () => {
    const f = await freshFixture();
    const { controller } = await setMockController(f);

    // 3 underwriters deposit 100 each, then queue 50 each.
    const us = await Promise.all(
      [0, 1, 2].map(() => makeUnderwriter(f.client, f.vault, 100n)),
    );
    for (const u of us) {
      await f.client.sendTransaction([
        await getDepositInstructionAsync({
          vaultState: f.vault.vaultStatePda,
          shareMint: f.vault.shareMintPda,
          vaultTokenAccount: f.vault.vaultTokenAccount,
          depositorStableAccount: u.usdcAta,
          depositorShareAccount: u.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
          depositor: u.signer,
          stableAmount: 100n,
        }),
      ]);
      await f.client.sendTransaction([
        await getRequestWithdrawalInstructionAsync({
          vaultState: f.vault.vaultStatePda,
          withdrawalQueue: f.vault.withdrawalQueuePda,
          shareMint: f.vault.shareMintPda,
          requesterShareAccount: u.shareAta,
          requester: u.signer,
          shares: 50n,
        }),
      ]);
    }

    // After all queued: TMA = 300 - 3*50 = 150. Free = TMA - locked = 150.
    // We can fulfil all 3 requests at 50 each.
    const claimablePdas = await Promise.all(
      us.map(async (u) => (await findClaimablePda({ collector: u.signer.address }))[0]),
    );

    // Build the process_withdrawal_queue ix and add the claimables as
    // remaining accounts in queue order (writable, non-signer).
    const baseIx = await getProcessWithdrawalQueueInstructionAsync({
      vaultState: f.vault.vaultStatePda,
      withdrawalQueue: f.vault.withdrawalQueuePda,
      controller,
    });
    const ix = {
      ...baseIx,
      accounts: [
        ...baseIx.accounts,
        ...claimablePdas.map((addr) => ({ address: addr, role: AccountRole.WRITABLE })),
      ],
    };
    await f.client.sendTransaction([ix]);

    const state = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(state.withdrawalQueueCount).toBe(0);

    for (const cp of claimablePdas) {
      const cb = getClaimableBalanceDecoder().decode(readAccount(f.client, cp));
      expect(cb.amount).toBe(50n);
    }
  });
});

// ─── 4.15 collect ───────────────────────────────────────────────────────

describe('Phase 2 — vault: collect', () => {
  it('4.15 transfers claimable amount + reverts when nothing to collect', async () => {
    const f = await freshFixture();
    const { controller } = await setMockController(f);
    const u = await makeUnderwriter(f.client, f.vault, 100n);

    // Deposit + queue + drain so user has claimable.
    await f.client.sendTransaction([
      await getDepositInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        depositorStableAccount: u.usdcAta,
        depositorShareAccount: u.shareAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        depositor: u.signer,
        stableAmount: 100n,
      }),
    ]);
    await f.client.sendTransaction([
      await getRequestWithdrawalInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        withdrawalQueue: f.vault.withdrawalQueuePda,
        shareMint: f.vault.shareMintPda,
        requesterShareAccount: u.shareAta,
        requester: u.signer,
        shares: 30n,
      }),
    ]);
    const [claimablePda] = await findClaimablePda({ collector: u.signer.address });
    const baseIx = await getProcessWithdrawalQueueInstructionAsync({
      vaultState: f.vault.vaultStatePda,
      withdrawalQueue: f.vault.withdrawalQueuePda,
      controller,
    });
    await f.client.sendTransaction([
      {
        ...baseIx,
        accounts: [...baseIx.accounts, { address: claimablePda, role: AccountRole.WRITABLE }],
      },
    ]);

    const before = getTokenAccountAmount(f.client, u.usdcAta) ?? 0n;
    await f.client.sendTransaction([
      await getCollectInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        vaultTokenAccount: f.vault.vaultTokenAccount,
        owner: u.signer.address,
        collectorStableAccount: u.usdcAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
        collector: u.signer,
      }),
    ]);
    const after = getTokenAccountAmount(f.client, u.usdcAta) ?? 0n;
    expect(after - before).toBe(30n);

    const cb = getClaimableBalanceDecoder().decode(readAccount(f.client, claimablePda));
    expect(cb.amount).toBe(0n);

    // Second collect reverts (NothingToCollect).
    await expect(
      f.client.sendTransaction([
        await getCollectInstructionAsync({
          vaultState: f.vault.vaultStatePda,
          vaultTokenAccount: f.vault.vaultTokenAccount,
          owner: u.signer.address,
          collectorStableAccount: u.usdcAta,
        stableMint: f.vault.stableMint,
        stableTokenProgram: TOKEN_2022_PROGRAM_ID_KIT,
          collector: u.signer,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.16 snapshot ──────────────────────────────────────────────────────

describe('Phase 2 — vault: snapshot', () => {
  it('4.16 once per day; second-same-day is no-op; new day creates new record', async () => {
    const f = await freshFixture();
    const { controller } = await setMockController(f);

    const dayOf = (sec: bigint) => sec / 86_400n;
    const today = dayOf(BigInt(f.client.svm.getClock().unixTimestamp));

    const [todayPda] = await findSnapshotRecordPda({ day: today });
    await f.client.sendTransaction([
      await getSnapshotInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        controller,
        rentPayer: controller, // same-keypair pattern in unit tests; D18
        day: today,
      }),
    ]);
    const snap = getSnapshotRecordDecoder().decode(readAccount(f.client, todayPda));
    expect(snap.day).toBe(today);
    const stateAfter = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    const tsAfter = stateAfter.lastSnapshotTime;
    // LiteSVM starts the clock at unix_timestamp = 0, which is a legitimate
    // post-snapshot value. We just assert the never-snapshotted sentinel
    // (`-1`) has been overwritten.
    expect(tsAfter).not.toBe(-1n);

    // Second same-day call: no-op (last_snapshot_time unchanged).
    // Bytes-identical tx to the first call would yield a duplicate
    // signature — rotate the blockhash so it's a different message.
    f.client.svm.expireBlockhash();
    advanceClock(f.client.svm, 60); // 1 minute later, still same day
    await f.client.sendTransaction([
      await getSnapshotInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        controller,
        rentPayer: controller, // same-keypair pattern in unit tests; D18
        day: today,
      }),
    ]);
    const stateNoOp = getVaultStateDecoder().decode(readAccount(f.client, f.vault.vaultStatePda));
    expect(stateNoOp.lastSnapshotTime).toBe(tsAfter);

    // Advance to next day → new record exists, last_snapshot_time advances.
    advanceClock(f.client.svm, 86_500); // a bit over 1 day
    const tomorrow = dayOf(BigInt(f.client.svm.getClock().unixTimestamp));
    expect(tomorrow).toBe(today + 1n);
    const [tomorrowPda] = await findSnapshotRecordPda({ day: tomorrow });
    await f.client.sendTransaction([
      await getSnapshotInstructionAsync({
        vaultState: f.vault.vaultStatePda,
        shareMint: f.vault.shareMintPda,
        controller,
        rentPayer: controller, // same-keypair pattern in unit tests; D18
        day: tomorrow,
      }),
    ]);
    const newSnap = getSnapshotRecordDecoder().decode(readAccount(f.client, tomorrowPda));
    expect(newSnap.day).toBe(tomorrow);
  });
});
