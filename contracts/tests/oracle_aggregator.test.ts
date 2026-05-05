/**
 * Phase 4 — oracle_aggregator program unit tests.
 *
 * Coverage map (subtask numbers from spec/phases/phase-04-oracle-aggregator-program.md §4):
 *   4.1  initialize: owner, authorized_oracle, default consumer, is_consumer_set=false
 *   4.2  set_authorized_oracle: owner-only, rotatable
 *   4.3  set_authorized_consumer: owner-only, once-only
 *   4.4  init_flight_data: consumer-signed; collision; length cap
 *   4.5  set_estimated_arrival: NotInitiated → Active; ETA stored
 *   4.6  set_landed: Active → Landed; actual_arrival_time stored
 *   4.7  set_cancelled: Active → Cancelled
 *   4.8  set_to_be_settled: 3 happy-path pairings (Landed→OnTime/Delayed; Cancelled→Cancelled)
 *   4.9  set_settled: each ToBeSettled* → Settled
 *   4.10 oracle-only revert (non-oracle caller)
 *   4.11 consumer-only revert (non-consumer caller)
 *   4.12 ConsumerNotSet (consumer ix called before set_authorized_consumer)
 *   4.13 set_estimated_arrival reverts when status != NotInitiated
 *   4.14 set_landed reverts when status != Active
 *   4.15 set_cancelled reverts when status != Active
 *   4.16 set_to_be_settled strict pairing (4 mismatches)
 *   4.17 set_to_be_settled with non-ToBeSettled* new_status → InvalidToBeSettledVariant
 *   4.18 set_settled reverts when status not in ToBeSettled*
 *   4.19 reverse-transition invariant — Settled is terminal
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

import {
  bootstrapOracleAggregator,
  makeClient,
  type OracleBootstrap,
} from './setup.ts';

import {
  ORACLE_AGGREGATOR_PROGRAM_ADDRESS,
  // Account decoders
  getOracleConfigDecoder,
  getFlightDataDecoder,
  // PDA helpers
  findFlightDataPda,
  // Instruction builders
  getInitFlightDataInstructionAsync,
  getSetAuthorizedConsumerInstruction,
  getSetAuthorizedOracleInstruction,
  getSetCancelledInstructionAsync,
  getSetEstimatedArrivalInstructionAsync,
  getSetLandedInstructionAsync,
  getSetSettledInstructionAsync,
  getSetToBeSettledInstructionAsync,
  // Enums
  FlightStatus,
} from './clients/oracle_aggregator/src/generated/index.ts';

// ─── Per-test fixture builder ────────────────────────────────────────────

type Client = Awaited<ReturnType<typeof makeClient>>;

interface Fixture {
  client: Client;
  oracle: OracleBootstrap;
}

const FLIGHT = { flightId: 'AA100', date: 20260101n } as const;

async function freshFixture(): Promise<Fixture> {
  const client = await makeClient();
  const oracle = await bootstrapOracleAggregator(client);
  return { client, oracle };
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

/** Wire a mock consumer via `set_authorized_consumer`. Returns the consumer signer. */
async function setMockConsumer(f: Fixture): Promise<KeyPairSigner> {
  const consumer = await fundedSigner(f.client);
  await f.client.sendTransaction([
    getSetAuthorizedConsumerInstruction({
      config: f.oracle.configPda,
      owner: f.client.payer,
      consumer: consumer.address,
    }),
  ]);
  return consumer;
}

/** Init a fresh FlightData PDA in NotInitiated. Returns its address. */
async function initFlight(f: Fixture, consumer: KeyPairSigner): Promise<Address> {
  await f.client.sendTransaction([
    await getInitFlightDataInstructionAsync({
      config: f.oracle.configPda,
      authorizedConsumer: consumer,
      rentPayer: consumer, // same-keypair pattern in unit tests; D18
      flightId: FLIGHT.flightId,
      date: FLIGHT.date,
    }),
  ]);
  const [pda] = await findFlightDataPda({ flightId: FLIGHT.flightId, date: FLIGHT.date });
  return pda;
}

/** Drive the state machine to a specific target. Each step expires the blockhash to
 * keep tx signatures distinct from any prior bytes-identical tx. */
async function reachStatus(
  f: Fixture,
  consumer: KeyPairSigner,
  target: FlightStatus,
): Promise<Address> {
  const pda = await initFlight(f, consumer);
  if (target === FlightStatus.NotInitiated) return pda;

  await f.client.sendTransaction([
    await getSetEstimatedArrivalInstructionAsync({
      config: f.oracle.configPda,
      authority: f.oracle.oracleSigner,
      flightId: FLIGHT.flightId,
      date: FLIGHT.date,
      eta: 1_700_000_000n,
    }),
  ]);
  if (target === FlightStatus.Active) return pda;

  if (target === FlightStatus.Landed
    || target === FlightStatus.ToBeSettledOnTime
    || target === FlightStatus.ToBeSettledDelayed) {
    await f.client.sendTransaction([
      await getSetLandedInstructionAsync({
        config: f.oracle.configPda,
        authority: f.oracle.oracleSigner,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        actualArrival: 1_700_010_000n,
      }),
    ]);
    if (target === FlightStatus.Landed) return pda;
    await f.client.sendTransaction([
      await getSetToBeSettledInstructionAsync({
        config: f.oracle.configPda,
        authority: consumer,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        newStatus: target,
      }),
    ]);
    return pda;
  }

  if (target === FlightStatus.Cancelled || target === FlightStatus.ToBeSettledCancelled) {
    await f.client.sendTransaction([
      await getSetCancelledInstructionAsync({
        config: f.oracle.configPda,
        authority: f.oracle.oracleSigner,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);
    if (target === FlightStatus.Cancelled) return pda;
    await f.client.sendTransaction([
      await getSetToBeSettledInstructionAsync({
        config: f.oracle.configPda,
        authority: consumer,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        newStatus: FlightStatus.ToBeSettledCancelled,
      }),
    ]);
    return pda;
  }

  if (target === FlightStatus.Settled) {
    // Reach via Landed → ToBeSettledOnTime → Settled (one of three valid paths).
    await f.client.sendTransaction([
      await getSetLandedInstructionAsync({
        config: f.oracle.configPda,
        authority: f.oracle.oracleSigner,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        actualArrival: 1_700_010_000n,
      }),
    ]);
    await f.client.sendTransaction([
      await getSetToBeSettledInstructionAsync({
        config: f.oracle.configPda,
        authority: consumer,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        newStatus: FlightStatus.ToBeSettledOnTime,
      }),
    ]);
    await f.client.sendTransaction([
      await getSetSettledInstructionAsync({
        config: f.oracle.configPda,
        authority: consumer,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);
    return pda;
  }

  throw new Error(`reachStatus: unsupported target ${target}`);
}

// ─── 4.1 initialize ──────────────────────────────────────────────────────

describe('Phase 4 — oracle_aggregator: initialize', () => {
  it('4.1 stores owner, authorized_oracle; consumer is default sentinel; is_consumer_set=false', async () => {
    const { client, oracle } = await freshFixture();
    const config = getOracleConfigDecoder().decode(readAccount(client, oracle.configPda));
    expect(config.owner).toBe(client.payer.address);
    expect(config.authorizedOracle).toBe(oracle.oracleSigner.address);
    expect(config.authorizedConsumer).toBe('11111111111111111111111111111111');
    expect(config.isConsumerSet).toBe(false);
  });
});

// ─── 4.2 set_authorized_oracle ──────────────────────────────────────────

describe('Phase 4 — oracle_aggregator: set_authorized_oracle', () => {
  it('4.2 owner can rotate the oracle freely; non-owner reverts', async () => {
    const f = await freshFixture();
    const newOracle1 = (await fundedSigner(f.client)).address;
    const newOracle2 = (await fundedSigner(f.client)).address;

    await f.client.sendTransaction([
      getSetAuthorizedOracleInstruction({
        config: f.oracle.configPda,
        owner: f.client.payer,
        newOracle: newOracle1,
      }),
    ]);
    let cfg = getOracleConfigDecoder().decode(readAccount(f.client, f.oracle.configPda));
    expect(cfg.authorizedOracle).toBe(newOracle1);

    // Rotate again.
    await f.client.sendTransaction([
      getSetAuthorizedOracleInstruction({
        config: f.oracle.configPda,
        owner: f.client.payer,
        newOracle: newOracle2,
      }),
    ]);
    cfg = getOracleConfigDecoder().decode(readAccount(f.client, f.oracle.configPda));
    expect(cfg.authorizedOracle).toBe(newOracle2);

    // Non-owner reverts.
    const stranger = await fundedSigner(f.client);
    await expect(
      f.client.sendTransaction([
        getSetAuthorizedOracleInstruction({
          config: f.oracle.configPda,
          owner: stranger,
          newOracle: newOracle1,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.3 set_authorized_consumer ────────────────────────────────────────

describe('Phase 4 — oracle_aggregator: set_authorized_consumer', () => {
  it('4.3 owner sets once; second call reverts; non-owner reverts', async () => {
    const f = await freshFixture();
    const consumer1 = (await fundedSigner(f.client)).address;
    const consumer2 = (await fundedSigner(f.client)).address;

    await f.client.sendTransaction([
      getSetAuthorizedConsumerInstruction({
        config: f.oracle.configPda,
        owner: f.client.payer,
        consumer: consumer1,
      }),
    ]);
    const cfg = getOracleConfigDecoder().decode(readAccount(f.client, f.oracle.configPda));
    expect(cfg.authorizedConsumer).toBe(consumer1);
    expect(cfg.isConsumerSet).toBe(true);

    // Second call → ConsumerAlreadySet.
    await expect(
      f.client.sendTransaction([
        getSetAuthorizedConsumerInstruction({
          config: f.oracle.configPda,
          owner: f.client.payer,
          consumer: consumer2,
        }),
      ]),
    ).rejects.toThrow();

    // Non-owner — fresh fixture.
    const f2 = await freshFixture();
    const stranger = await fundedSigner(f2.client);
    await expect(
      f2.client.sendTransaction([
        getSetAuthorizedConsumerInstruction({
          config: f2.oracle.configPda,
          owner: stranger,
          consumer: consumer1,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.4 init_flight_data ───────────────────────────────────────────────

describe('Phase 4 — oracle_aggregator: init_flight_data', () => {
  it('4.4 consumer-signed creates FlightData in NotInitiated; collision + length-cap revert', async () => {
    const f = await freshFixture();
    const consumer = await setMockConsumer(f);

    const pda = await initFlight(f, consumer);
    const fd = getFlightDataDecoder().decode(readAccount(f.client, pda));
    expect(fd.flightId).toBe(FLIGHT.flightId);
    expect(fd.date).toBe(FLIGHT.date);
    expect(fd.status).toBe(FlightStatus.NotInitiated);
    expect(fd.estimatedArrivalTime).toBe(0n);
    expect(fd.actualArrivalTime).toBe(0n);

    // Collision: re-init same (flight_id, date) reverts.
    await expect(
      f.client.sendTransaction([
        await getInitFlightDataInstructionAsync({
          config: f.oracle.configPda,
          authorizedConsumer: consumer,
          rentPayer: consumer,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
        }),
      ]),
    ).rejects.toThrow();

    // Length cap.
    await expect(
      f.client.sendTransaction([
        await getInitFlightDataInstructionAsync({
          config: f.oracle.configPda,
          authorizedConsumer: consumer,
          rentPayer: consumer,
          flightId: 'X'.repeat(20),
          date: FLIGHT.date,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.5 / 4.6 / 4.7 oracle-keyed happy paths ───────────────────────────

describe('Phase 4 — oracle_aggregator: oracle-keyed transitions', () => {
  let f: Fixture;
  let consumer: KeyPairSigner;
  beforeEach(async () => { f = await freshFixture(); consumer = await setMockConsumer(f); });

  it('4.5 set_estimated_arrival: NotInitiated → Active; ETA stored', async () => {
    const pda = await initFlight(f, consumer);
    await f.client.sendTransaction([
      await getSetEstimatedArrivalInstructionAsync({
        config: f.oracle.configPda,
        authority: f.oracle.oracleSigner,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        eta: 1_700_000_000n,
      }),
    ]);
    const fd = getFlightDataDecoder().decode(readAccount(f.client, pda));
    expect(fd.status).toBe(FlightStatus.Active);
    expect(fd.estimatedArrivalTime).toBe(1_700_000_000n);
  });

  it('4.6 set_landed: Active → Landed; actual_arrival_time stored', async () => {
    const pda = await reachStatus(f, consumer, FlightStatus.Active);
    await f.client.sendTransaction([
      await getSetLandedInstructionAsync({
        config: f.oracle.configPda,
        authority: f.oracle.oracleSigner,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
        actualArrival: 1_700_010_000n,
      }),
    ]);
    const fd = getFlightDataDecoder().decode(readAccount(f.client, pda));
    expect(fd.status).toBe(FlightStatus.Landed);
    expect(fd.actualArrivalTime).toBe(1_700_010_000n);
  });

  it('4.7 set_cancelled: Active → Cancelled', async () => {
    const pda = await reachStatus(f, consumer, FlightStatus.Active);
    await f.client.sendTransaction([
      await getSetCancelledInstructionAsync({
        config: f.oracle.configPda,
        authority: f.oracle.oracleSigner,
        flightId: FLIGHT.flightId,
        date: FLIGHT.date,
      }),
    ]);
    const fd = getFlightDataDecoder().decode(readAccount(f.client, pda));
    expect(fd.status).toBe(FlightStatus.Cancelled);
  });
});

// ─── 4.8 / 4.9 consumer-keyed happy paths ───────────────────────────────

describe('Phase 4 — oracle_aggregator: consumer-keyed transitions', () => {
  it('4.8 set_to_be_settled: Landed → OnTime; Landed → Delayed; Cancelled → Cancelled', async () => {
    // Landed → ToBeSettledOnTime
    {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      const pda = await reachStatus(f, consumer, FlightStatus.Landed);
      await f.client.sendTransaction([
        await getSetToBeSettledInstructionAsync({
          config: f.oracle.configPda,
          authority: consumer,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          newStatus: FlightStatus.ToBeSettledOnTime,
        }),
      ]);
      expect(getFlightDataDecoder().decode(readAccount(f.client, pda)).status)
        .toBe(FlightStatus.ToBeSettledOnTime);
    }
    // Landed → ToBeSettledDelayed
    {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      const pda = await reachStatus(f, consumer, FlightStatus.Landed);
      await f.client.sendTransaction([
        await getSetToBeSettledInstructionAsync({
          config: f.oracle.configPda,
          authority: consumer,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          newStatus: FlightStatus.ToBeSettledDelayed,
        }),
      ]);
      expect(getFlightDataDecoder().decode(readAccount(f.client, pda)).status)
        .toBe(FlightStatus.ToBeSettledDelayed);
    }
    // Cancelled → ToBeSettledCancelled
    {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      const pda = await reachStatus(f, consumer, FlightStatus.Cancelled);
      await f.client.sendTransaction([
        await getSetToBeSettledInstructionAsync({
          config: f.oracle.configPda,
          authority: consumer,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          newStatus: FlightStatus.ToBeSettledCancelled,
        }),
      ]);
      expect(getFlightDataDecoder().decode(readAccount(f.client, pda)).status)
        .toBe(FlightStatus.ToBeSettledCancelled);
    }
  });

  it('4.9 set_settled: each ToBeSettled* → Settled', async () => {
    for (const tbs of [
      FlightStatus.ToBeSettledOnTime,
      FlightStatus.ToBeSettledDelayed,
      FlightStatus.ToBeSettledCancelled,
    ]) {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      const pda = await reachStatus(f, consumer, tbs);
      await f.client.sendTransaction([
        await getSetSettledInstructionAsync({
          config: f.oracle.configPda,
          authority: consumer,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
        }),
      ]);
      expect(getFlightDataDecoder().decode(readAccount(f.client, pda)).status)
        .toBe(FlightStatus.Settled);
    }
  });
});

// ─── 4.10 / 4.11 / 4.12 authorisation reverts ──────────────────────────

describe('Phase 4 — oracle_aggregator: authority reverts', () => {
  it('4.10 oracle-only ix revert when called by non-oracle', async () => {
    const f = await freshFixture();
    const consumer = await setMockConsumer(f);
    await initFlight(f, consumer);
    const stranger = await fundedSigner(f.client);

    // set_estimated_arrival
    await expect(
      f.client.sendTransaction([
        await getSetEstimatedArrivalInstructionAsync({
          config: f.oracle.configPda,
          authority: stranger,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          eta: 1_700_000_000n,
        }),
      ]),
    ).rejects.toThrow();

    // set_landed (status doesn't matter since auth check runs first)
    await expect(
      f.client.sendTransaction([
        await getSetLandedInstructionAsync({
          config: f.oracle.configPda,
          authority: stranger,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          actualArrival: 1_700_010_000n,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('4.11 consumer-only ix revert when called by non-consumer', async () => {
    const f = await freshFixture();
    const consumer = await setMockConsumer(f);
    const pda = await reachStatus(f, consumer, FlightStatus.Landed);
    const _ = pda;
    const stranger = await fundedSigner(f.client);

    await expect(
      f.client.sendTransaction([
        await getSetToBeSettledInstructionAsync({
          config: f.oracle.configPda,
          authority: stranger,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          newStatus: FlightStatus.ToBeSettledOnTime,
        }),
      ]),
    ).rejects.toThrow();

    // init_flight_data with stranger as consumer also reverts (different flight to avoid PDA collision).
    await expect(
      f.client.sendTransaction([
        await getInitFlightDataInstructionAsync({
          config: f.oracle.configPda,
          authorizedConsumer: stranger,
          rentPayer: stranger,
          flightId: 'BB200',
          date: FLIGHT.date,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('4.12 ConsumerNotSet — consumer ix called before set_authorized_consumer', async () => {
    const f = await freshFixture();
    const wouldBeConsumer = await fundedSigner(f.client);
    // No setMockConsumer call → is_consumer_set == false.

    await expect(
      f.client.sendTransaction([
        await getInitFlightDataInstructionAsync({
          config: f.oracle.configPda,
          authorizedConsumer: wouldBeConsumer,
          rentPayer: wouldBeConsumer,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.13 / 4.14 / 4.15 forward-only state-machine guards (oracle ix) ──

describe('Phase 4 — oracle_aggregator: state-machine guards (oracle ix)', () => {
  it('4.13 set_estimated_arrival reverts when status != NotInitiated', async () => {
    const f = await freshFixture();
    const consumer = await setMockConsumer(f);
    await reachStatus(f, consumer, FlightStatus.Active);
    f.client.svm.expireBlockhash();
    await expect(
      f.client.sendTransaction([
        await getSetEstimatedArrivalInstructionAsync({
          config: f.oracle.configPda,
          authority: f.oracle.oracleSigner,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          eta: 1_700_000_000n,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('4.14 set_landed reverts when status != Active', async () => {
    const f = await freshFixture();
    const consumer = await setMockConsumer(f);
    await initFlight(f, consumer); // status = NotInitiated
    await expect(
      f.client.sendTransaction([
        await getSetLandedInstructionAsync({
          config: f.oracle.configPda,
          authority: f.oracle.oracleSigner,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          actualArrival: 1_700_010_000n,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('4.15 set_cancelled reverts when status != Active', async () => {
    const f = await freshFixture();
    const consumer = await setMockConsumer(f);
    await reachStatus(f, consumer, FlightStatus.Landed);
    await expect(
      f.client.sendTransaction([
        await getSetCancelledInstructionAsync({
          config: f.oracle.configPda,
          authority: f.oracle.oracleSigner,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.16 set_to_be_settled strict pairing ──────────────────────────────

describe('Phase 4 — oracle_aggregator: set_to_be_settled strict pairing', () => {
  it('4.16 mismatched (current → new) pairs revert', async () => {
    // Landed → ToBeSettledCancelled (forbidden)
    {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      await reachStatus(f, consumer, FlightStatus.Landed);
      await expect(
        f.client.sendTransaction([
          await getSetToBeSettledInstructionAsync({
            config: f.oracle.configPda,
            authority: consumer,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
            newStatus: FlightStatus.ToBeSettledCancelled,
          }),
        ]),
      ).rejects.toThrow();
    }
    // Cancelled → ToBeSettledOnTime (forbidden)
    {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      await reachStatus(f, consumer, FlightStatus.Cancelled);
      await expect(
        f.client.sendTransaction([
          await getSetToBeSettledInstructionAsync({
            config: f.oracle.configPda,
            authority: consumer,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
            newStatus: FlightStatus.ToBeSettledOnTime,
          }),
        ]),
      ).rejects.toThrow();
    }
    // Cancelled → ToBeSettledDelayed (forbidden)
    {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      await reachStatus(f, consumer, FlightStatus.Cancelled);
      await expect(
        f.client.sendTransaction([
          await getSetToBeSettledInstructionAsync({
            config: f.oracle.configPda,
            authority: consumer,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
            newStatus: FlightStatus.ToBeSettledDelayed,
          }),
        ]),
      ).rejects.toThrow();
    }
    // Active → ToBeSettledOnTime (current ∉ {Landed, Cancelled})
    {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      await reachStatus(f, consumer, FlightStatus.Active);
      await expect(
        f.client.sendTransaction([
          await getSetToBeSettledInstructionAsync({
            config: f.oracle.configPda,
            authority: consumer,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
            newStatus: FlightStatus.ToBeSettledOnTime,
          }),
        ]),
      ).rejects.toThrow();
    }
  });
});

// ─── 4.17 set_to_be_settled with non-ToBeSettled* new_status ───────────

describe('Phase 4 — oracle_aggregator: set_to_be_settled new_status validation', () => {
  it('4.17 reverts with InvalidToBeSettledVariant for non-ToBeSettled* new_status', async () => {
    const f = await freshFixture();
    const consumer = await setMockConsumer(f);
    await reachStatus(f, consumer, FlightStatus.Landed);

    // FlightStatus.Active is not a ToBeSettled* variant.
    await expect(
      f.client.sendTransaction([
        await getSetToBeSettledInstructionAsync({
          config: f.oracle.configPda,
          authority: consumer,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          newStatus: FlightStatus.Active,
        }),
      ]),
    ).rejects.toThrow();

    // FlightStatus.Settled is also not a ToBeSettled*.
    f.client.svm.expireBlockhash();
    await expect(
      f.client.sendTransaction([
        await getSetToBeSettledInstructionAsync({
          config: f.oracle.configPda,
          authority: consumer,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
          newStatus: FlightStatus.Settled,
        }),
      ]),
    ).rejects.toThrow();
  });
});

// ─── 4.18 set_settled forward-only guard ───────────────────────────────

describe('Phase 4 — oracle_aggregator: set_settled guard', () => {
  it('4.18 reverts when status not in ToBeSettled*', async () => {
    // Active
    {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      await reachStatus(f, consumer, FlightStatus.Active);
      await expect(
        f.client.sendTransaction([
          await getSetSettledInstructionAsync({
            config: f.oracle.configPda,
            authority: consumer,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
          }),
        ]),
      ).rejects.toThrow();
    }
    // Already Settled
    {
      const f = await freshFixture();
      const consumer = await setMockConsumer(f);
      await reachStatus(f, consumer, FlightStatus.Settled);
      f.client.svm.expireBlockhash();
      await expect(
        f.client.sendTransaction([
          await getSetSettledInstructionAsync({
            config: f.oracle.configPda,
            authority: consumer,
            flightId: FLIGHT.flightId,
            date: FLIGHT.date,
          }),
        ]),
      ).rejects.toThrow();
    }
  });
});

// ─── 4.19 reverse-transition invariant ─────────────────────────────────

describe('Phase 4 — oracle_aggregator: forward-only invariant', () => {
  it('4.19 Settled is terminal — set_settled on a Settled flight reverts', async () => {
    const f = await freshFixture();
    const consumer = await setMockConsumer(f);
    await reachStatus(f, consumer, FlightStatus.Settled);
    f.client.svm.expireBlockhash();
    await expect(
      f.client.sendTransaction([
        await getSetSettledInstructionAsync({
          config: f.oracle.configPda,
          authority: consumer,
          flightId: FLIGHT.flightId,
          date: FLIGHT.date,
        }),
      ]),
    ).rejects.toThrow();
  });
});
