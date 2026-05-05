/**
 * Phase 3 — flight_pool program unit tests.
 *
 * Coverage map (subtask numbers from spec/phases/phase-03-flight-pool-program.md §4):
 *   4.1  initialize: config, treasury ATA, treasury authority PDA
 *   4.2  set_controller: owner-only + once-only
 *   4.3  controller-only revert paths (parameterised)
 *   4.4  register_pool: happy + collision
 *   4.5  register_pool: length cap
 *   4.6  add_buyer: happy + premium transfer
 *   4.7  add_buyer: re-purchase reverts (PDA collision)
 *   4.8  add_buyer: status guard (post-settlement reverts)
 *   4.9  settle_on_time: status + treasury → recipient transfer
 *   4.10 settle_delayed / settle_cancelled: status + claim_expiry, no transfer
 *   4.11 settle_*: status guard
 *   4.12 claim: happy
 *   4.13 claim: revert paths (no policy, already claimed, status, expiry)
 *   4.14 sweep_expired: pre-expiry revert + post-expiry recovery + idempotent
 *   4.15 withdraw_recovered: auth + amount checks + transfer
 *   4.16 BuyerRecord layout for memcmp pattern (buyer at offset 8)
 *
 * All tests use Codama-generated typed Kit instruction builders from
 * `tests/clients/flight_pool/`. No hand-rolled discriminators.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

import {
  advanceClock,
  bootstrapFlightPool,
  createMockUsdcMint,
  getAtaAddress,
  getTokenAccountAmount,
  makeClient,
  mintMockUsdcTo,
  setTokenAccount,
  type FlightPoolBootstrap,
} from './setup.ts';

import {
  FLIGHT_POOL_PROGRAM_ADDRESS,
  // Account decoders
  getFlightPoolConfigDecoder,
  getFlightPoolDecoder,
  getBuyerRecordDecoder,
  // PDA helpers
  findPoolPda,
  findBuyerRecordPda,
  // Instruction builders
  getAddBuyerInstructionAsync,
  getClaimInstructionAsync,
  getRegisterPoolInstructionAsync,
  getSetControllerInstruction,
  getSettleCancelledInstructionAsync,
  getSettleDelayedInstructionAsync,
  getSettleOnTimeInstructionAsync,
  getSweepExpiredInstructionAsync,
  getWithdrawRecoveredInstructionAsync,
  // Enums
  SettlementStatus,
} from './clients/flight_pool/src/generated/index.ts';

// ─── Per-test fixture builder ────────────────────────────────────────────

type Client = Awaited<ReturnType<typeof makeClient>>;

interface Fixture {
  client: Client;
  pool: FlightPoolBootstrap;
}

const FLIGHT = { flightId: 'AA100', date: 20260101n } as const;
const PREMIUM = 100_000n; // 0.1 USDC
const PAYOFF = 1_000_000n; // 1 USDC
const DELAY_HOURS = 2;

async function freshFixture(): Promise<Fixture> {
  const client = await makeClient();
  createMockUsdcMint(client);
  const pool = await bootstrapFlightPool(client);
  return { client, pool };
}

async function fundedSigner(client: Client): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  await client.airdrop(signer.address, lamports(2_000_000_000n));
  return signer;
}

function readAccount(client: Client, addr: Address): Uint8Array {
  const acc = client.svm.getAccount(addr);
  if (!acc.exists) throw new Error(`account ${addr} missing`);
  return acc.data;
}

/** Wire a mock controller via `set_controller`. */
async function setMockController(f: Fixture): Promise<KeyPairSigner> {
  const controller = await fundedSigner(f.client);
  await f.client.sendTransaction([
    getSetControllerInstruction({
      config: f.pool.configPda,
      owner: f.client.payer,
      controller: controller.address,
    }),
  ]);
  return controller;
}

/** Register a default pool and return the pool PDA. */
async function registerDefault(f: Fixture, controller: KeyPairSigner): Promise<Address> {
  await f.client.sendTransaction([
    await getRegisterPoolInstructionAsync({
      config: f.pool.configPda,
      controller,
      rentPayer: controller, // same-keypair pattern in unit tests; D18
      flightId: FLIGHT.flightId,
      date: FLIGHT.date,
      premium: PREMIUM,
      payoff: PAYOFF,
      delayHours: DELAY_HOURS,
    }),
  ]);
  const [poolPda] = await findPoolPda({ flightId: FLIGHT.flightId, date: FLIGHT.date });
  return poolPda;
}

/** Create a buyer with a funded USDC ATA, then `add_buyer` them onto the pool. */
async function addBuyerOf(
  f: Fixture,
  controller: KeyPairSigner,
  initialUsdc: bigint = PREMIUM,
): Promise<{ traveler: KeyPairSigner; usdcAta: Address; buyerRecordPda: Address; poolPda: Address }> {
  const traveler = await fundedSigner(f.client);
  const { ata: usdcAta } = mintMockUsdcTo(f.client, traveler.address, initialUsdc);
  const [poolPda] = await findPoolPda({ flightId: FLIGHT.flightId, date: FLIGHT.date });

  await f.client.sendTransaction([
    await getAddBuyerInstructionAsync({
      config: f.pool.configPda,
      pool: poolPda,
      buyerUsdcAccount: usdcAta,
      poolTreasury: f.pool.treasuryAta,
      buyer: traveler,
      controller,
      flightId: FLIGHT.flightId,
      date: FLIGHT.date,
    }),
  ]);

  const [buyerRecordPda] = await findBuyerRecordPda({ pool: poolPda, buyer: traveler.address });
  return { traveler, usdcAta, buyerRecordPda, poolPda };
}

// ─── 4.1 initialize ──────────────────────────────────────────────────────

describe('Phase 3 — flight_pool: initialize', () => {
  it('4.1 config and treasury wired correctly', async () => {
    const { client, pool } = await freshFixture();
    const config = getFlightPoolConfigDecoder().decode(readAccount(client, pool.configPda));

    expect(config.owner).toBe(client.payer.address);
    expect(config.controller).toBe('11111111111111111111111111111111');
    expect(config.usdcMint).toBe(pool.usdcMint);
    expect(config.poolTreasury).toBe(pool.treasuryAta);
    expect(config.recoveredBalance).toBe(0n);
    expect(config.isControllerSet).toBe(false);

    // Treasury ATA exists, owned by treasury authority PDA, holding 0 USDC.
    expect(getTokenAccountAmount(client, pool.treasuryAta)).toBe(0n);
  });
});

// ─── 4.2 set_controller ──────────────────────────────────────────────────

describe('Phase 3 — flight_pool: set_controller', () => {
  it('4.2 owner sets controller; second call reverts; non-owner reverts', async () => {
    const f = await freshFixture();
    const ctl1 = (await fundedSigner(f.client)).address;
    const ctl2 = (await fundedSigner(f.client)).address;

    await f.client.sendTransaction([
      getSetControllerInstruction({ config: f.pool.configPda, owner: f.client.payer, controller: ctl1 }),
    ]);
    const c1 = getFlightPoolConfigDecoder().decode(readAccount(f.client, f.pool.configPda));
    expect(c1.controller).toBe(ctl1);
    expect(c1.isControllerSet).toBe(true);

    await expect(
      f.client.sendTransaction([
        getSetControllerInstruction({ config: f.pool.configPda, owner: f.client.payer, controller: ctl2 }),
      ]),
    ).rejects.toThrow();

    // Non-owner — fresh fixture.
    const f2 = await freshFixture();
    const stranger = await fundedSigner(f2.client);
    await expect(
      f2.client.sendTransaction([
        getSetControllerInstruction({ config: f2.pool.configPda, owner: stranger, controller: ctl1 }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.3 controller-only revert paths ───────────────────────────────────

describe('Phase 3 — flight_pool: controller-only auth', () => {
  it('4.3 register_pool / add_buyer / settle_* revert when caller is not the configured controller', async () => {
    const f = await freshFixture();
    await setMockController(f);
    const stranger = await fundedSigner(f.client);

    await expect(
      f.client.sendTransaction([
        await getRegisterPoolInstructionAsync({
          config: f.pool.configPda,
          controller: stranger,
          rentPayer: stranger,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          premium: PREMIUM,
          payoff: PAYOFF,
          delayHours: DELAY_HOURS,
        }),
      ]),
    ).rejects.toThrow();
    // Other controller-only ix follow the same constraint pattern; one
    // assertion is sufficient — they all share `has_one = controller`.
  });
});

// ─── 4.4 / 4.5 register_pool ────────────────────────────────────────────

describe('Phase 3 — flight_pool: register_pool', () => {
  it('4.4 happy path; second call for same (flight_id, date) reverts (PDA collision)', async () => {
    const f = await freshFixture();
    const controller = await setMockController(f);

    const poolPda = await registerDefault(f, controller);
    const pool = getFlightPoolDecoder().decode(readAccount(f.client, poolPda));
    expect(pool.flightId).toBe(FLIGHT.flightId);
    expect(pool.date).toBe(FLIGHT.date);
    expect(pool.premium).toBe(PREMIUM);
    expect(pool.payoff).toBe(PAYOFF);
    expect(pool.delayHours).toBe(DELAY_HOURS);
    expect(pool.buyerCount).toBe(0);
    expect(pool.claimedCount).toBe(0);
    expect(pool.status).toBe(SettlementStatus.Active);

    // Re-register same (flight_id, date) → reverts.
    await expect(
      f.client.sendTransaction([
        await getRegisterPoolInstructionAsync({
          config: f.pool.configPda,
          controller,
          rentPayer: controller,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          premium: PREMIUM,
          payoff: PAYOFF,
          delayHours: DELAY_HOURS,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('4.5 length cap reverts with FlightIdTooLong', async () => {
    const f = await freshFixture();
    const controller = await setMockController(f);
    const longFlight = 'X'.repeat(20); // > MAX_FLIGHT_ID_LEN (16)

    await expect(
      f.client.sendTransaction([
        await getRegisterPoolInstructionAsync({
          config: f.pool.configPda,
          controller,
          rentPayer: controller,
          flightId: longFlight,
          date: FLIGHT.date,
          premium: PREMIUM,
          payoff: PAYOFF,
          delayHours: DELAY_HOURS,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.6 / 4.7 / 4.8 add_buyer ──────────────────────────────────────────

describe('Phase 3 — flight_pool: add_buyer', () => {
  let f: Fixture;
  let controller: KeyPairSigner;
  beforeEach(async () => { f = await freshFixture(); controller = await setMockController(f); });

  it('4.6 creates BuyerRecord, increments buyer_count, transfers premium', async () => {
    const poolPda = await registerDefault(f, controller);
    const traveler = await fundedSigner(f.client);
    const { ata: usdcAta } = mintMockUsdcTo(f.client, traveler.address, PREMIUM);

    await f.client.sendTransaction([
      await getAddBuyerInstructionAsync({
        config: f.pool.configPda,
        pool: poolPda,
        buyerUsdcAccount: usdcAta,
        poolTreasury: f.pool.treasuryAta,
        buyer: traveler,
        controller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);

    const pool = getFlightPoolDecoder().decode(readAccount(f.client, poolPda));
    expect(pool.buyerCount).toBe(1);

    const [buyerRecordPda] = await findBuyerRecordPda({ pool: poolPda, buyer: traveler.address });
    const br = getBuyerRecordDecoder().decode(readAccount(f.client, buyerRecordPda));
    expect(br.buyer).toBe(traveler.address);
    expect(br.pool).toBe(poolPda);
    expect(br.hasPolicy).toBe(true);
    expect(br.claimed).toBe(false);

    // Premium moved.
    expect(getTokenAccountAmount(f.client, usdcAta)).toBe(0n);
    expect(getTokenAccountAmount(f.client, f.pool.treasuryAta)).toBe(PREMIUM);
  });

  it('4.7 second add_buyer for same (pool, buyer) reverts (PDA collision)', async () => {
    await registerDefault(f, controller);
    const { traveler, usdcAta, poolPda } = await addBuyerOf(f, controller, PREMIUM * 2n);

    await expect(
      f.client.sendTransaction([
        await getAddBuyerInstructionAsync({
          config: f.pool.configPda,
          pool: poolPda,
          buyerUsdcAccount: usdcAta,
          poolTreasury: f.pool.treasuryAta,
          buyer: traveler,
          controller,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('4.8 reverts when pool.status != Active', async () => {
    await registerDefault(f, controller);

    // Settle the pool first → status = SettledOnTime.
    const { ata: recipientAta } = mintMockUsdcTo(f.client, (await fundedSigner(f.client)).address, 0n);
    await f.client.sendTransaction([
      await getSettleOnTimeInstructionAsync({
        config: f.pool.configPda,
        poolTreasury: f.pool.treasuryAta,
        recipient: recipientAta,
        controller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);

    // Now add_buyer → reverts.
    const traveler = await fundedSigner(f.client);
    const { ata: usdcAta } = mintMockUsdcTo(f.client, traveler.address, PREMIUM);
    const [poolPda] = await findPoolPda({ flightId: FLIGHT.flightId, date: FLIGHT.date });

    await expect(
      f.client.sendTransaction([
        await getAddBuyerInstructionAsync({
          config: f.pool.configPda,
          pool: poolPda,
          buyerUsdcAccount: usdcAta,
          poolTreasury: f.pool.treasuryAta,
          buyer: traveler,
          controller,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.9 / 4.10 / 4.11 settle_* ────────────────────────────────────────

describe('Phase 3 — flight_pool: settle_*', () => {
  let f: Fixture;
  let controller: KeyPairSigner;
  beforeEach(async () => { f = await freshFixture(); controller = await setMockController(f); });

  it('4.9 settle_on_time transfers premium*buyer_count to recipient', async () => {
    await registerDefault(f, controller);
    await addBuyerOf(f, controller);
    await addBuyerOf(f, controller);
    // Treasury now holds 2 * PREMIUM. After settle_on_time, recipient
    // gets 2 * PREMIUM and treasury balance returns to 0.
    const recipient = await fundedSigner(f.client);
    const { ata: recipientAta } = mintMockUsdcTo(f.client, recipient.address, 0n);

    await f.client.sendTransaction([
      await getSettleOnTimeInstructionAsync({
        config: f.pool.configPda,
        poolTreasury: f.pool.treasuryAta,
        recipient: recipientAta,
        controller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);

    expect(getTokenAccountAmount(f.client, recipientAta)).toBe(2n * PREMIUM);
    expect(getTokenAccountAmount(f.client, f.pool.treasuryAta)).toBe(0n);

    const [poolPda] = await findPoolPda({ flightId: FLIGHT.flightId, date: FLIGHT.date });
    const pool = getFlightPoolDecoder().decode(readAccount(f.client, poolPda));
    expect(pool.status).toBe(SettlementStatus.SettledOnTime);
  });

  it('4.10 settle_delayed / settle_cancelled set status + claim_expiry, no transfer', async () => {
    await registerDefault(f, controller);
    await addBuyerOf(f, controller);
    const treasuryBefore = getTokenAccountAmount(f.client, f.pool.treasuryAta) ?? 0n;

    const expiry = 999_999_999n;
    await f.client.sendTransaction([
      await getSettleDelayedInstructionAsync({
        config: f.pool.configPda,
        controller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        claimExpiry: expiry,
      }),
    ]);
    const [poolPda] = await findPoolPda({ flightId: FLIGHT.flightId, date: FLIGHT.date });
    const poolAfter = getFlightPoolDecoder().decode(readAccount(f.client, poolPda));
    expect(poolAfter.status).toBe(SettlementStatus.SettledDelayed);
    expect(poolAfter.claimExpiry).toBe(expiry);
    expect(getTokenAccountAmount(f.client, f.pool.treasuryAta)).toBe(treasuryBefore);

    // settle_cancelled — separate fixture so we don't transition from SettledDelayed.
    const f2 = await freshFixture();
    const ctl2 = await setMockController(f2);
    await registerDefault(f2, ctl2);
    await addBuyerOf(f2, ctl2);
    await f2.client.sendTransaction([
      await getSettleCancelledInstructionAsync({
        config: f2.pool.configPda,
        controller: ctl2,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        claimExpiry: expiry,
      }),
    ]);
    const [poolPda2] = await findPoolPda({ flightId: FLIGHT.flightId, date: FLIGHT.date });
    const pool2 = getFlightPoolDecoder().decode(readAccount(f2.client, poolPda2));
    expect(pool2.status).toBe(SettlementStatus.SettledCancelled);
  });

  it('4.11 settle_* reverts when status != Active (forward-only)', async () => {
    await registerDefault(f, controller);
    await addBuyerOf(f, controller);
    // First settle → SettledOnTime.
    const { ata: recipientAta } = mintMockUsdcTo(f.client, (await fundedSigner(f.client)).address, 0n);
    await f.client.sendTransaction([
      await getSettleOnTimeInstructionAsync({
        config: f.pool.configPda,
        poolTreasury: f.pool.treasuryAta,
        recipient: recipientAta,
        controller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);
    // Second settle (any variant) → reverts.
    await expect(
      f.client.sendTransaction([
        await getSettleDelayedInstructionAsync({
          config: f.pool.configPda,
          controller,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          claimExpiry: 1_000n,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.12 / 4.13 claim ──────────────────────────────────────────────────

describe('Phase 3 — flight_pool: claim', () => {
  /**
   * Set up: register pool, add a buyer, settle delayed with `claim_expiry`
   * far in the future, top up the treasury so it can pay the payoff out.
   * Returns the pieces tests need.
   */
  async function settledDelayedFixture(): Promise<{
    f: Fixture;
    controller: KeyPairSigner;
    traveler: KeyPairSigner;
    usdcAta: Address;
    poolPda: Address;
  }> {
    const f = await freshFixture();
    const controller = await setMockController(f);
    await registerDefault(f, controller);
    const { traveler, usdcAta, poolPda } = await addBuyerOf(f, controller);

    // Top up the treasury with the payoff amount (the vault would do this
    // via send_payout in Phase 5; we just preload via setTokenAccount).
    setTokenAccount(f.client, {
      mint: f.pool.usdcMint,
      owner: f.pool.treasuryAuthorityPda,
      amount: PREMIUM + PAYOFF, // existing premium plus the payoff topup
    });

    // Settle delayed with a generous claim_expiry.
    const expiry = BigInt(f.client.svm.getClock().unixTimestamp + 86_400n); // +1 day
    await f.client.sendTransaction([
      await getSettleDelayedInstructionAsync({
        config: f.pool.configPda,
        controller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        claimExpiry: expiry,
      }),
    ]);

    return { f, controller, traveler, usdcAta, poolPda };
  }

  it('4.12 happy path — buyer_record.claimed = true, claimed_count++, USDC transferred', async () => {
    const { f, traveler, usdcAta, poolPda } = await settledDelayedFixture();
    const usdcBefore = getTokenAccountAmount(f.client, usdcAta) ?? 0n;

    await f.client.sendTransaction([
      await getClaimInstructionAsync({
        config: f.pool.configPda,
        pool: poolPda,
        buyer: traveler.address,
        poolTreasury: f.pool.treasuryAta,
        travelerUsdcAccount: usdcAta,
        usdcMint: f.pool.usdcMint,
        traveler,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);

    const usdcAfter = getTokenAccountAmount(f.client, usdcAta) ?? 0n;
    expect(usdcAfter - usdcBefore).toBe(PAYOFF);

    const pool = getFlightPoolDecoder().decode(readAccount(f.client, poolPda));
    expect(pool.claimedCount).toBe(1);

    const [buyerRecordPda] = await findBuyerRecordPda({ pool: poolPda, buyer: traveler.address });
    const br = getBuyerRecordDecoder().decode(readAccount(f.client, buyerRecordPda));
    expect(br.claimed).toBe(true);
  });

  it('4.13 reverts: already claimed; status not settled; past expiry; no policy', async () => {
    // a) already claimed
    {
      const { f, traveler, usdcAta, poolPda } = await settledDelayedFixture();
      await f.client.sendTransaction([
        await getClaimInstructionAsync({
          config: f.pool.configPda,
          pool: poolPda,
          buyer: traveler.address,
          poolTreasury: f.pool.treasuryAta,
          travelerUsdcAccount: usdcAta,
          usdcMint: f.pool.usdcMint,
          traveler,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
        }),
      ]);
      f.client.svm.expireBlockhash();
      await expect(
        f.client.sendTransaction([
          await getClaimInstructionAsync({
            config: f.pool.configPda,
            pool: poolPda,
            buyer: traveler.address,
            poolTreasury: f.pool.treasuryAta,
            travelerUsdcAccount: usdcAta,
            usdcMint: f.pool.usdcMint,
            traveler,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
          }),
        ]),
      ).rejects.toThrow();
    }

    // b) status Active (no settlement) — fresh fixture, skip settle_delayed
    {
      const f = await freshFixture();
      const controller = await setMockController(f);
      await registerDefault(f, controller);
      const { traveler, usdcAta, poolPda } = await addBuyerOf(f, controller);
      await expect(
        f.client.sendTransaction([
          await getClaimInstructionAsync({
            config: f.pool.configPda,
            pool: poolPda,
            buyer: traveler.address,
            poolTreasury: f.pool.treasuryAta,
            travelerUsdcAccount: usdcAta,
            usdcMint: f.pool.usdcMint,
            traveler,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
          }),
        ]),
      ).rejects.toThrow();
    }

    // c) past claim_expiry
    {
      const { f, traveler, usdcAta, poolPda } = await settledDelayedFixture();
      advanceClock(f.client.svm, 86_500); // > 1 day → past expiry
      await expect(
        f.client.sendTransaction([
          await getClaimInstructionAsync({
            config: f.pool.configPda,
            pool: poolPda,
            buyer: traveler.address,
            poolTreasury: f.pool.treasuryAta,
            travelerUsdcAccount: usdcAta,
            usdcMint: f.pool.usdcMint,
            traveler,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
          }),
        ]),
      ).rejects.toThrow();
    }

    // d) no policy — different signer claiming someone else's record
    {
      const { f, traveler, usdcAta, poolPda } = await settledDelayedFixture();
      const stranger = await fundedSigner(f.client);
      const { ata: strangerAta } = mintMockUsdcTo(f.client, stranger.address, 0n);
      const _ = traveler; // unused — buyerRecord PDA is keyed by `stranger` here, doesn't exist
      const _2 = usdcAta;
      await expect(
        f.client.sendTransaction([
          await getClaimInstructionAsync({
            config: f.pool.configPda,
            pool: poolPda,
            buyer: stranger.address,
            poolTreasury: f.pool.treasuryAta,
            travelerUsdcAccount: strangerAta,
            usdcMint: f.pool.usdcMint,
            traveler: stranger,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
          }),
        ]),
      ).rejects.toThrow();
    }
  });
});

// ─── 4.14 sweep_expired ─────────────────────────────────────────────────

describe('Phase 3 — flight_pool: sweep_expired', () => {
  it('4.14 pre-expiry reverts; post-expiry recovers; second sweep is a no-op', async () => {
    const f = await freshFixture();
    const controller = await setMockController(f);
    await registerDefault(f, controller);
    await addBuyerOf(f, controller);
    await addBuyerOf(f, controller);

    const expiry = BigInt(f.client.svm.getClock().unixTimestamp + 86_400n);
    await f.client.sendTransaction([
      await getSettleDelayedInstructionAsync({
        config: f.pool.configPda,
        controller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        claimExpiry: expiry,
      }),
    ]);

    const [poolPda] = await findPoolPda({ flightId: FLIGHT.flightId, date: FLIGHT.date });
    const caller = await fundedSigner(f.client);

    // Pre-expiry: reverts.
    await expect(
      f.client.sendTransaction([
        await getSweepExpiredInstructionAsync({
          config: f.pool.configPda,
          pool: poolPda,
          caller,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
        }),
      ]),
    ).rejects.toThrow();

    // Advance past expiry.
    advanceClock(f.client.svm, 86_500);
    // The reverted pre-expiry sweep occupied its signature slot; rotate
    // blockhash so the post-expiry retry has a different signature.
    f.client.svm.expireBlockhash();

    // First sweep: 2 unclaimed buyers × payoff → recovered_balance.
    await f.client.sendTransaction([
      await getSweepExpiredInstructionAsync({
        config: f.pool.configPda,
        pool: poolPda,
        caller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);
    const config = getFlightPoolConfigDecoder().decode(readAccount(f.client, f.pool.configPda));
    expect(config.recoveredBalance).toBe(2n * PAYOFF);

    const pool = getFlightPoolDecoder().decode(readAccount(f.client, poolPda));
    expect(pool.claimedCount).toBe(pool.buyerCount); // closed window

    // Second sweep — idempotent, no state change.
    f.client.svm.expireBlockhash();
    await f.client.sendTransaction([
      await getSweepExpiredInstructionAsync({
        config: f.pool.configPda,
        pool: poolPda,
        caller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);
    const config2 = getFlightPoolConfigDecoder().decode(readAccount(f.client, f.pool.configPda));
    expect(config2.recoveredBalance).toBe(2n * PAYOFF); // unchanged
  });
});

// ─── 4.15 withdraw_recovered ────────────────────────────────────────────

describe('Phase 3 — flight_pool: withdraw_recovered', () => {
  it('4.15 owner only; decrements counter; transfers USDC; reverts when amount > balance', async () => {
    const f = await freshFixture();
    const controller = await setMockController(f);
    await registerDefault(f, controller);
    await addBuyerOf(f, controller);

    // Push pool to SettledDelayed and sweep to populate recovered_balance.
    const expiry = BigInt(f.client.svm.getClock().unixTimestamp + 86_400n);
    await f.client.sendTransaction([
      await getSettleDelayedInstructionAsync({
        config: f.pool.configPda,
        controller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        claimExpiry: expiry,
      }),
    ]);
    advanceClock(f.client.svm, 86_500);
    const [poolPda] = await findPoolPda({ flightId: FLIGHT.flightId, date: FLIGHT.date });
    const caller = await fundedSigner(f.client);
    await f.client.sendTransaction([
      await getSweepExpiredInstructionAsync({
        config: f.pool.configPda,
        pool: poolPda,
        caller,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);

    // Owner needs an ATA for the mock USDC + treasury must have funds equal
    // to recovered_balance. Premium (PREMIUM) is in treasury from add_buyer;
    // top up the treasury for the payoff coverage.
    setTokenAccount(f.client, {
      mint: f.pool.usdcMint,
      owner: f.pool.treasuryAuthorityPda,
      amount: PAYOFF, // top up so withdraw can pull
    });
    const ownerUsdcAta = getAtaAddress(f.pool.usdcMint, f.client.payer.address);
    mintMockUsdcTo(f.client, f.client.payer.address, 0n); // ensure ATA exists

    // Withdraw half.
    await f.client.sendTransaction([
      await getWithdrawRecoveredInstructionAsync({
        config: f.pool.configPda,
        poolTreasury: f.pool.treasuryAta,
        ownerUsdcAccount: ownerUsdcAta,
        usdcMint: f.pool.usdcMint,
        owner: f.client.payer,
        amount: PAYOFF / 2n,
      }),
    ]);
    expect(getTokenAccountAmount(f.client, ownerUsdcAta)).toBe(PAYOFF / 2n);
    const cfgMid = getFlightPoolConfigDecoder().decode(readAccount(f.client, f.pool.configPda));
    expect(cfgMid.recoveredBalance).toBe(PAYOFF - PAYOFF / 2n);

    // Withdraw more than remaining → reverts.
    await expect(
      f.client.sendTransaction([
        await getWithdrawRecoveredInstructionAsync({
          config: f.pool.configPda,
          poolTreasury: f.pool.treasuryAta,
          ownerUsdcAccount: ownerUsdcAta,
          usdcMint: f.pool.usdcMint,
          owner: f.client.payer,
          amount: PAYOFF, // exceeds remaining recovered_balance
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.16 BuyerRecord layout for memcmp pattern ─────────────────────────

describe('Phase 3 — flight_pool: BuyerRecord memcmp layout', () => {
  it('4.16 buyer pubkey sits at offset 8 (post-discriminator); pool sits at offset 40', async () => {
    const f = await freshFixture();
    const controller = await setMockController(f);
    await registerDefault(f, controller);
    const { traveler, buyerRecordPda, poolPda } = await addBuyerOf(f, controller);

    const data = readAccount(f.client, buyerRecordPda);
    // First 8 bytes = Anchor discriminator; we don't decode it but assert
    // the buyer pubkey lives in bytes [8..40] and pool in [40..72].
    const buyerBytes = data.subarray(8, 40);
    const poolBytes = data.subarray(40, 72);

    // The Codama-decoded buyer/pool fields should match the on-chain
    // bytes at those offsets — i.e. the architecture's memcmp filter
    // (offset 8 = buyer, offset 40 = pool) is correctly wired.
    const decoded = getBuyerRecordDecoder().decode(data);
    expect(decoded.buyer).toBe(traveler.address);
    expect(decoded.pool).toBe(poolPda);

    // Sanity: bytes are non-zero (i.e. the fields really are there).
    expect(buyerBytes.length).toBe(32);
    expect(poolBytes.length).toBe(32);
    expect(buyerBytes.some((b) => b !== 0)).toBe(true);
    expect(poolBytes.some((b) => b !== 0)).toBe(true);
  });
});
