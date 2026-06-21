# Oracle ↔ External Data Source: Architecture Report

Companion to `agent_governance_report.md`. Where that document covers an **AI agent** writing to an Anchor program, this one covers an **off-chain data feed** (FlightAware AeroAPI) pushing factual data into an on-chain oracle program via a forward-only state machine. Written so another AI agent (or engineer) can replicate the pattern for any "external truth → Solana" pipeline (price feeds, weather, sports scores, IoT, etc.).

The system has three pieces meeting at one on-chain authority:

```
┌─────────────────────────┐    GET     ┌──────────────────────────┐
│ FlightAware AeroAPI     │  /flights  │ FlightDataFetcher Cron   │
│ (external HTTPS API)    │ ◄────────  │ (TypeScript, every 2h)   │
│ x-apikey header         │            │  ── readActiveFlightList │
│ 4xx envelope or 5xx     │            │  ── per-flight decide    │
└─────────────────────────┘            │  ── Codama ix builder    │
                                       │  ── sign as oracle key   │
                                       └────────────┬─────────────┘
                                                    │ signed tx
                                                    ▼
                                       ┌──────────────────────────┐
                                       │ oracle_aggregator_program│
                                       │  init_flight_data        │ (consumer-only)
                                       │  set_estimated_arrival   │ ◄── oracle-only
                                       │  set_landed              │ ◄── oracle-only
                                       │  set_cancelled           │ ◄── oracle-only
                                       │  set_to_be_settled       │ (consumer-only)
                                       │  set_settled             │ (consumer-only)
                                       └──────────────────────────┘
```

The defining characteristic of an oracle pipeline (vs. the agent pipeline) is that **the on-chain program enforces a state machine** the off-chain feed must walk through. The cron's job is "translate the external data source into the right sequence of state transitions" — not "compute and push a value."

---

## 1. The on-chain authority model — split oracle vs. consumer

`contracts/programs/oracle_aggregator/src/lib.rs` carries `OracleConfig` with **three** authority slots:

| Slot | Who | Which ixs |
|---|---|---|
| `owner` | Deployer keypair | `set_authorized_oracle`, `set_authorized_consumer`, init |
| `authorized_oracle` | Fetcher cron keypair (rotatable) | `set_estimated_arrival`, `set_landed`, `set_cancelled` |
| `authorized_consumer` | Controller program's PDA (set once) | `init_flight_data`, `set_to_be_settled`, `set_settled` |

Two principles to copy:

1. **The oracle keypair can ONLY change "external truth" fields.** It cannot create new accounts (consumer does that during user `buy_insurance`), it cannot trigger payouts (controller does that during `execute_settlements`), and it cannot rotate itself (owner does that). An attacker who steals the oracle key can write false flight data — bad — but cannot drain funds or create unauthorized payouts.
2. **The consumer slot is a PDA, set once.** The controller program signs as `[b"controller_config"]` PDA via `invoke_signed`. There is no off-chain keypair for the consumer — it's literally another program. `is_consumer_set: bool` is the "wired up yet?" flag; the slot can never be unset.

### Code sample — oracle config + three authority slots

```rust
// contracts/programs/oracle_aggregator/src/lib.rs
#[account]
#[derive(InitSpace)]
pub struct OracleConfig {
    pub owner:                Pubkey,   // can rotate oracle, set consumer once
    pub authorized_oracle:    Pubkey,   // freely rotatable (hot-key rotation)
    pub authorized_consumer:  Pubkey,   // set ONCE — controller PDA in production
    pub is_consumer_set:      bool,
    pub bump:                 u8,
}

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
```

### Code sample — single accounts struct, per-handler auth check

The oracle uses **one** `SetFlightStatus<'info>` accounts struct for all five status-mutator ixs, and inlines the authority check inside each handler. This keeps the IDL surface (and the Codama-generated client) uniform across both authority classes.

```rust
// contracts/programs/oracle_aggregator/src/lib.rs
#[derive(Accounts)]
#[instruction(flight_id: String, date: u64)]
pub struct SetFlightStatus<'info> {
    #[account(seeds = [b"oracle_config_v2"], bump = config.bump)]
    pub config: Account<'info, OracleConfig>,

    #[account(
        mut,
        seeds = [b"flight", flight_id.as_bytes(), &date.to_le_bytes()],
        bump = flight_data.bump,
    )]
    pub flight_data: Account<'info, FlightData>,

    /// Identity-checked inside each handler — see require_keys_eq! below.
    pub authority: Signer<'info>,
}

pub fn set_estimated_arrival(
    ctx: Context<SetFlightStatus>,
    flight_id: String,
    date: u64,
    eta: i64,
) -> Result<()> {
    let _ = (flight_id, date);
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.config.authorized_oracle,        // oracle-keyed ix
        OracleError::UnauthorizedOracle
    );
    let fd = &mut ctx.accounts.flight_data;
    require!(fd.status == FlightStatus::NotInitiated, OracleError::InvalidStateTransition);
    fd.status = FlightStatus::Active;
    fd.estimated_arrival_time = eta;
    Ok(())
}
```

---

## 2. The forward-only state machine

This is the load-bearing safety property. Once `FlightData` exists, its `status` can only advance:

```
NotInitiated ──set_estimated_arrival──▶ Active ──┬─set_landed────▶ Landed   ─────set_to_be_settled──▶ ToBeSettledOnTime ┐
                                                 │                                                       ToBeSettledDelayed ├──set_settled──▶ Settled
                                                 └─set_cancelled─▶ Cancelled ──set_to_be_settled──▶ ToBeSettledCancelled ┘
```

Every transition is enforced by a `require!(fd.status == EXPECTED, OracleError::InvalidStateTransition)` inside the handler. The cron *cannot* push `Landed` directly from `NotInitiated`; it must walk through `Active` first. This is what lets you sleep at night — even if the cron pushes garbage, the program rejects illegal transitions.

### Code sample — enum mirroring (Rust ↔ TypeScript)

The TS enum must match Anchor's Borsh discriminants 0..7 exactly. Get this wrong once and you silently misclassify every flight.

```rust
// contracts/programs/oracle_aggregator/src/lib.rs
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum FlightStatus {
    NotInitiated,            // 0
    Active,                  // 1
    Landed,                  // 2
    Cancelled,               // 3
    ToBeSettledOnTime,       // 4
    ToBeSettledDelayed,      // 5
    ToBeSettledCancelled,    // 6
    Settled,                 // 7
}
```

```ts
// executor/src/core/types.ts — mirror of the Borsh discriminants.
export enum FlightStatus {
  NotInitiated         = 0,
  Active               = 1,
  Landed               = 2,
  Cancelled            = 3,
  ToBeSettledOnTime    = 4,
  ToBeSettledDelayed   = 5,
  ToBeSettledCancelled = 6,
  Settled              = 7,
}
```

### Strict (current → new) pairing on the consumer side

The classifier's `set_to_be_settled` is the trickiest transition: a Landed flight cannot be classified as `ToBeSettledCancelled`, and a Cancelled flight cannot be classified as `ToBeSettledOnTime`. The contract enforces this with explicit pair matching:

```rust
// contracts/programs/oracle_aggregator/src/lib.rs
let allowed = match current {
    FlightStatus::Landed => matches!(
        new_status,
        FlightStatus::ToBeSettledOnTime | FlightStatus::ToBeSettledDelayed
    ),
    FlightStatus::Cancelled => matches!(new_status, FlightStatus::ToBeSettledCancelled),
    _ => false,
};
require!(allowed, OracleError::InvalidStateTransition);
```

This is the principle to copy: when one transition has multiple targets (here: Landed → either On-Time or Delayed), enumerate every (current, new) pair explicitly. Don't infer it.

---

## 3. The AeroAPI client — the "external truth" boundary

`executor/src/core/aeroapi_client.ts` wraps a single endpoint:

```
GET https://aeroapi.flightaware.com/aeroapi/flights/{ident}?start={date}T00:00:00Z&end={date}T23:59:59Z
  Header: x-apikey: <AEROAPI_KEY>
  Returns: 200 → { flights: AeroFlight[] }
           4xx → { title, reason, detail, status }   (envelope schema)
           5xx → unstructured
```

**Three contract rules that keep the oracle safe:**

1. **Never throw.** Every error path (network, 4xx envelope, 5xx, JSON parse, missing field) returns `null`. The cron's per-flight loop then `continue`s. A dropped fetch never causes incorrect on-chain state — it just defers the update to the next 2h tick.
2. **Decode the 4xx envelope structurally**, log it as a tagged line, and still return null. Operators triage from the log; the cron keeps going.
3. **Validate the URL shape before fetching.** `dateIso` must match `YYYY-MM-DD` exactly. Otherwise you waste a quota call on a malformed URL.

### Code sample — never-throws AeroAPI client

```ts
// executor/src/core/aeroapi_client.ts
const AEROAPI_BASE = 'https://aeroapi.flightaware.com/aeroapi';

export function createAeroApiClient(opts: AeroApiClientOptions): AeroApiClient {
  const baseUrl   = opts.baseUrl   ?? AEROAPI_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const logger    = opts.logger    ?? ((m) => console.error(m));
  const apiKey    = opts.apiKey;
  if (!apiKey) throw new Error('AeroAPI client: apiKey is required');

  return {
    async fetchFlightsForDay(ident, dateIso) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
        throw new Error(`dateIso must be YYYY-MM-DD; got ${dateIso}`);
      }
      const url = `${baseUrl}/flights/${encodeURIComponent(ident)}` +
                  `?start=${dateIso}T00:00:00Z&end=${dateIso}T23:59:59Z`;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { 'x-apikey': apiKey, accept: 'application/json' },
        });
      } catch (err) {
        logger(`[aero] network error: ${(err as Error)?.message ?? String(err)}`);
        return null;       // network down → defer, do not throw
      }

      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) {
          let raw: unknown = null;
          try { raw = await res.json(); } catch { /* fallthrough */ }
          const envelope = parseAeroApiError(raw);
          if (envelope) {
            logger(`[aero] 4xx envelope: status=${envelope.status} title="${envelope.title}" ` +
                   `reason="${envelope.reason}" detail="${envelope.detail}"`);
            return null;
          }
        }
        logger(`[aero] HTTP ${res.status}`);
        return null;
      }

      let body: AeroFlightsResponse;
      try { body = await res.json() as AeroFlightsResponse; }
      catch { logger(`[aero] JSON parse failed on 2xx response`); return null; }

      if (!body || !Array.isArray(body.flights)) {
        logger(`[aero] response missing 'flights' field`);
        return null;
      }
      return body.flights;
    },
  };
}
```

### Code sample — structural 4xx envelope decode

```ts
// executor/src/core/aeroapi_client.ts
export interface AeroApiError {
  title:  string;
  reason: string;
  detail: string;
  status: number;
}

export function parseAeroApiError(raw: unknown): AeroApiError | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.title  === 'string' &&
    typeof obj.reason === 'string' &&
    typeof obj.detail === 'string' &&
    typeof obj.status === 'number'
  ) {
    return { title: obj.title, reason: obj.reason, detail: obj.detail, status: obj.status };
  }
  return null;
}
```

### Operator error table (one place, kept in the source comment)

| HTTP | Meaning | Operator action |
|---|---|---|
| 401 | bad/expired API key | rotate `AEROAPI_KEY` env |
| 403 | endpoint not on your plan tier | upgrade or change endpoint |
| 404 | flight not found | benign — flight ident may be wrong |
| 429 | rate limit | back off; consider caching active list |
| 5xx | FlightAware-side issue | wait; retries are automatic next tick |

---

## 4. AeroAPI response shape — what to read, what to ignore

The most important design rule for any oracle: **read boolean/null-checkable fields, never branch on human-readable strings.**

```ts
// executor/src/core/types.ts
export interface AeroFlight {
  ident: string;

  /** PRIMARY cancel signal. Boolean — no string parsing. */
  cancelled: boolean;

  /** Out of scope here. Treat as in-progress. */
  diverted?: boolean;

  /**
   * Original published gate-arrival (ISO 8601 UTC).
   * Cron writes this as `estimated_arrival_time` on-chain — the
   * passenger-experience delay reference, NOT the airline's running estimate.
   */
  scheduled_in: string | null;

  /** Airline's running estimate — read for sanity, NEVER written on-chain. */
  estimated_in?: string | null;

  /**
   * PRIMARY landed signal — `actual_in !== null` means arrived.
   * Null = still in progress or never arrived.
   */
  actual_in: string | null;

  /** Anything else passes through — schema additions don't break the cron. */
  [key: string]: unknown;
}
```

**Three design choices to replicate:**

1. **Open-ended interface (`[key: string]: unknown`)**, two-three required fields. The cron stays resilient to upstream schema additions. You never need to update the type when AeroAPI adds a field.
2. **`scheduled_in` is the reference**, not `estimated_in`. The contract treats the value the oracle wrote as ground truth for the delay calculation; using the running estimate would let the airline silently re-define "on time."
3. **`pickLatestFlight` = `flights[flights.length - 1]`**. AeroAPI returns multiple operations on a callsign across the day window; the last entry is the most recent operation. Document this assumption in code:

```ts
// executor/src/core/aeroapi_client.ts
export function pickLatestFlight(flights: AeroFlight[]): AeroFlight | null {
  if (!flights || flights.length === 0) return null;
  return flights[flights.length - 1];
}
```

---

## 5. The pure decision function — the cron's brain

`executor/src/core/flight_data_fetcher.ts → decideFetcherActions()` is the *only* place where "what should we do with this flight" logic lives. Inputs: latest AeroAPI flight + current on-chain status. Output: one of seven action variants. No RPC, no fetch, no signer. Trivial to unit-test.

### Code sample — the action ADT

```ts
// executor/src/core/types.ts
export type FetcherAction =
  | { kind: 'skip'; reason: string }
  | { kind: 'set_estimated_arrival'; etaUnixSec: number }
  | { kind: 'set_landed'; actualArrivalUnixSec: number }
  | { kind: 'set_cancelled' }
  /** Atomic NotInitiated → Active → Cancelled (cancel-before-ETA edge case). */
  | { kind: 'set_estimated_arrival_then_cancelled'; etaUnixSec: number }
  /** Atomic NotInitiated → Active → Landed (land-before-ETA edge case). */
  | { kind: 'set_estimated_arrival_then_landed'; etaUnixSec: number; actualArrivalUnixSec: number };
```

### Code sample — boolean-only decision tree

```ts
// executor/src/core/flight_data_fetcher.ts
export function decideFetcherActions(
  flight: AeroFlight,
  currentStatus: FlightStatus,
): FetcherAction {
  // (1) Terminal / post-Landed — nothing to do.
  if (
    currentStatus === FlightStatus.Landed              ||
    currentStatus === FlightStatus.Cancelled           ||
    currentStatus === FlightStatus.ToBeSettledOnTime   ||
    currentStatus === FlightStatus.ToBeSettledDelayed  ||
    currentStatus === FlightStatus.ToBeSettledCancelled||
    currentStatus === FlightStatus.Settled
  ) {
    return { kind: 'skip', reason: `current status ${FlightStatus[currentStatus]} is terminal/past Landed` };
  }

  const etaUnixSec    = isoToUnixSec(flight.scheduled_in);
  const actualUnixSec = isoToUnixSec(flight.actual_in);

  // (2) Cancelled branch — boolean check, not string.
  if (flight.cancelled === true) {
    if (currentStatus === FlightStatus.NotInitiated) {
      if (etaUnixSec === null) return { kind: 'skip', reason: 'cancelled but no scheduled_in to seed ETA' };
      return { kind: 'set_estimated_arrival_then_cancelled', etaUnixSec };
    }
    if (currentStatus === FlightStatus.Active) return { kind: 'set_cancelled' };
    return { kind: 'skip', reason: `cancelled but unhandled current status ${FlightStatus[currentStatus]}` };
  }

  // (3) Landed branch — null-check, not string.
  if (actualUnixSec !== null) {
    if (currentStatus === FlightStatus.NotInitiated) {
      if (etaUnixSec === null) return { kind: 'skip', reason: 'actual_in present but no scheduled_in' };
      return { kind: 'set_estimated_arrival_then_landed', etaUnixSec, actualArrivalUnixSec: actualUnixSec };
    }
    if (currentStatus === FlightStatus.Active) return { kind: 'set_landed', actualArrivalUnixSec: actualUnixSec };
    return { kind: 'skip', reason: `actual_in present but unhandled current status ${FlightStatus[currentStatus]}` };
  }

  // (4) In-flight — only useful work is seeding ETA on first tick.
  if (currentStatus === FlightStatus.NotInitiated) {
    if (etaUnixSec === null) return { kind: 'skip', reason: 'NotInitiated and no scheduled_in available yet' };
    return { kind: 'set_estimated_arrival', etaUnixSec };
  }
  return { kind: 'skip', reason: 'in-flight (Active) and no resolution yet' };
}
```

**Why the two-ix-in-one-tx variants matter.** AeroAPI can return `cancelled=true` before the cron has ever seen the flight (status is still `NotInitiated`). The on-chain state machine requires `Active` before `Cancelled`. Without atomic bundling, the cron would push `set_estimated_arrival` in tick N and `set_cancelled` in tick N+1 — and during that 2h window, the flight is on-chain `Active` even though it's already cancelled in reality. Bundling both ixs into one tx means the on-chain state is *never* misleading.

---

## 6. The orchestrator — `runFetcherOnce()`

`executor/src/core/flight_data_fetcher.ts` is the cron body. Same `applyAction`-callback pattern as the repricer: orchestrator is Codama-import-free; the runner script owns all Codama imports.

```ts
// executor/src/core/flight_data_fetcher.ts
export async function runFetcherOnce(opts: RunFetcherOnceOpts): Promise<RunFetcherOnceResult> {
  const log = opts.log ?? ((m) => console.log(m));
  const flights = await opts.solana.readActiveFlightList();
  log(`[fetcher] tick: ${flights.length} active flight(s) on chain`);

  let acted = 0, skipped = 0;

  for (const entry of flights) {
    const dateIso     = unixDayToIso(entry.date);
    const aeroFlights = await opts.aero.fetchFlightsForDay(entry.flightId, dateIso);
    if (aeroFlights === null || aeroFlights.length === 0) {
      log(`[fetcher] ${entry.flightId} ${dateIso}: AeroAPI null/empty — skip`);
      skipped++; continue;
    }
    const latest = aeroFlights[aeroFlights.length - 1];

    const onChain = await opts.solana.readFlightDataStatus(entry.flightId, entry.date);
    if (onChain === null) {
      log(`[fetcher] ${entry.flightId} ${dateIso}: FlightData PDA missing — skip`);
      skipped++; continue;
    }

    const action = decideFetcherActions(latest, onChain);
    if (action.kind === 'skip') {
      log(`[fetcher] ${entry.flightId} ${dateIso}: skip (${action.reason})`);
      skipped++; continue;
    }

    try {
      await opts.applyAction(entry, action);
      log(`[fetcher] ${entry.flightId} ${dateIso}: ${action.kind} ✓`);
      acted++;
    } catch (err) {
      log(`[fetcher] ${entry.flightId} ${dateIso}: ${action.kind} FAILED: ${(err as Error).message ?? err}`);
      skipped++;
    }
  }

  log(`[fetcher] tick complete: ${acted} acted, ${skipped} skipped, ${flights.length} total`);
  return { totalFlights: flights.length, acted, skipped };
}
```

Three patterns from this loop to copy:

1. **Active-set discovery is on-chain, not API-driven.** The cron reads the controller's `ActiveFlightList` (a `Vec<{ flightId, date }>` PDA) and only queries AeroAPI for those flights. You never poll the API for "all flights" — you poll only for flights the protocol currently cares about. This caps your API quota by the protocol's active count, not by airline volume.
2. **Snapshot the on-chain status BEFORE deciding.** `decideFetcherActions` takes the current status as input, not a fetched value mid-decision. The decision and the snapshot are then on the same tick — if the snapshot is stale by tx-send time, the on-chain state-machine check rejects the tx and the next tick recovers.
3. **Per-flight try/catch, never abort the loop.** One failing tx doesn't block the other 100 flights. The histogram tracks per-outcome counts for the activity feed.

---

## 7. Action → instruction translator — Codama re-enters here

`executor/src/scripts/run-fetcher.ts → actionToIxs()` is the only file that imports Codama-generated builders for the oracle program. The core decision module stays generator-free.

### Code sample — action → instruction translation

```ts
// executor/src/scripts/run-fetcher.ts
import {
  getSetCancelledInstructionAsync,
  getSetEstimatedArrivalInstructionAsync,
  getSetLandedInstructionAsync,
} from '../clients/oracle_aggregator/src/generated/index.ts';

async function actionToIxs(solana: SolanaClient, entry: ActiveFlightEntry, action: FetcherAction) {
  switch (action.kind) {
    case 'skip': return [];

    case 'set_estimated_arrival':
      return [await getSetEstimatedArrivalInstructionAsync({
        flightData: await deriveFlightDataPdaAddr(solana.deployment, entry),
        authority:  solana.signer,                  // the authorized_oracle keypair
        flightId:   entry.flightId,
        date:       entry.date,
        eta:        BigInt(action.etaUnixSec),      // i64 on-chain — pass as BigInt
      })];

    case 'set_landed':
      return [await getSetLandedInstructionAsync({
        flightData: await deriveFlightDataPdaAddr(solana.deployment, entry),
        authority:  solana.signer,
        flightId:   entry.flightId,
        date:       entry.date,
        actualArrival: BigInt(action.actualArrivalUnixSec),
      })];

    case 'set_cancelled':
      return [await getSetCancelledInstructionAsync({
        flightData: await deriveFlightDataPdaAddr(solana.deployment, entry),
        authority:  solana.signer,
        flightId:   entry.flightId,
        date:       entry.date,
      })];

    case 'set_estimated_arrival_then_cancelled': {
      // Same PDA, two ixs in one tx — bundling pushes NotInitiated → Active → Cancelled atomically.
      const fdPda = await deriveFlightDataPdaAddr(solana.deployment, entry);
      return [
        await getSetEstimatedArrivalInstructionAsync({
          flightData: fdPda, authority: solana.signer,
          flightId: entry.flightId, date: entry.date,
          eta: BigInt(action.etaUnixSec),
        }),
        await getSetCancelledInstructionAsync({
          flightData: fdPda, authority: solana.signer,
          flightId: entry.flightId, date: entry.date,
        }),
      ];
    }

    case 'set_estimated_arrival_then_landed': {
      const fdPda = await deriveFlightDataPdaAddr(solana.deployment, entry);
      return [
        await getSetEstimatedArrivalInstructionAsync({
          flightData: fdPda, authority: solana.signer,
          flightId: entry.flightId, date: entry.date,
          eta: BigInt(action.etaUnixSec),
        }),
        await getSetLandedInstructionAsync({
          flightData: fdPda, authority: solana.signer,
          flightId: entry.flightId, date: entry.date,
          actualArrival: BigInt(action.actualArrivalUnixSec),
        }),
      ];
    }
  }
}
```

### Code sample — PDA derivation matches the Rust seed bytes

```ts
// executor/src/scripts/run-fetcher.ts
async function deriveFlightDataPdaAddr(deployment: DeploymentArtifact, entry: ActiveFlightEntry) {
  const { PublicKey } = await import('@solana/web3.js');
  // Rust:   seeds = [b"flight", flight_id.as_bytes(), &date.to_le_bytes()]
  const dateBytes = Buffer.alloc(8);
  dateBytes.writeBigUInt64LE(entry.date);          // u64 LE — must match Rust
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('flight'), Buffer.from(entry.flightId, 'utf-8'), dateBytes],
    new PublicKey(deployment.programs.oracle_aggregator),
  );
  return kitAddress(pda.toBase58());
}
```

This is the one place where a Solana oracle pipeline most often breaks: byte-for-byte seed mismatch between Rust (`flight_id.as_bytes()`, `date.to_le_bytes()`) and TS (`Buffer.from(flight_id, 'utf-8')`, `writeBigUInt64LE`). The Codama builders for ixs *with* declared seeds in the IDL auto-derive correctly; ixs that take the PDA as an `Account<'info, T>` without declared seeds (or where the cron derives the address outside the builder) need this hand-derivation. Match endianness, match string encoding (`utf-8` for both), match seed order.

### Code sample — the runner wiring

```ts
// executor/src/scripts/run-fetcher.ts
async function main() {
  const cluster        = requireEnv('CLUSTER');
  const oracleKeypair  = requireEnv('ORACLE_KEYPAIR');      // path on disk
  const aeroApiKey     = requireEnv('AEROAPI_KEY');

  const repoRoot = findRepoRoot();
  const solana   = await createSolanaClient({ cluster, repoRoot, keypairPath: oracleKeypair });
  const aero     = createAeroApiClient({ apiKey: aeroApiKey });

  await runFetcherOnce({
    solana,
    aero,
    applyAction: async (entry, action) => {
      const ixs = await actionToIxs(solana, entry, action);
      if (ixs.length > 0) await solana.sendIxs(ixs);
    },
  });
}
```

---

## 8. Replication checklist for an "external truth → Solana oracle" pipeline

If you're building a price feed, weather oracle, sports-score feed, etc., here's the minimal skeleton, in order:

1. **Design the forward-only state machine first.** Even if you only have two real states ("not seen yet" → "seen"), encoding it as a state-machine in the program means a buggy off-chain cron cannot retroactively rewrite history. Add `_ToBeSettled*` middle states only if downstream programs need to gate on "we know the truth but haven't acted on it yet."
2. **Split owner / oracle / consumer authorities.** Owner manages config. Oracle pushes facts. Consumer (usually another program PDA) reads facts and triggers payouts. One key per role. Stolen oracle key = wrong data; stolen oracle key ≠ drained funds.
3. **One accounts struct, per-handler `require_keys_eq!`.** Keeps the IDL surface (and the Codama client) uniform across multiple authority classes. Document the authority-class table in the source comment.
4. **Strict pair-matching on multi-target transitions.** When `Landed → ToBeSettledOnTime | ToBeSettledDelayed`, enumerate both pairs. Don't infer.
5. **Wrap the external API in a never-throws client.** Network → null. 4xx envelope → structured log + null. 5xx → generic log + null. JSON parse fail → log + null. Always null. The cron's retry semantics must be uniform across error classes.
6. **Decode the API's documented error envelope structurally.** Operators triage from the log; the cron keeps going. Put the operator-action table in a source comment, not just the runbook.
7. **Read boolean/null-checkable fields, never branch on display strings.** API providers sometimes change the wording ("Cancelled" → "Cancelled — see remarks") and your cron silently breaks. Use the boolean `cancelled` field, the `actual_in !== null` check, etc.
8. **Open-ended interface, two-three required fields.** `[key: string]: unknown` keeps the cron resilient to upstream schema additions.
9. **Active-set discovery is on-chain.** The cron reads "what does the protocol care about right now?" from a controller PDA, then queries the external API only for those items. Caps your API quota by protocol activity, not by external-source volume.
10. **Pure decision module** that takes (external snapshot, on-chain status) → closed-set action ADT. Then a runner that translates ADT → ixs. Test the module, mock the runner.
11. **Atomic multi-ix bundles for state-machine edge cases** (cancel-before-ETA, land-before-ETA). The on-chain state is never *briefly misleading* — it transitions in one tx or not at all.
12. **PDA seed bytes must match exactly.** `flight_id.as_bytes()` ↔ `Buffer.from(flightId, 'utf-8')`. `date.to_le_bytes()` ↔ `Buffer.alloc(8); writeBigUInt64LE(date)`. Get this wrong and every tx fails with "AccountNotInitialized" — and you blame the API.

---

## 9. Files to mirror

| Purpose | File |
|---|---|
| On-chain oracle with split authority + forward-only state machine | `contracts/programs/oracle_aggregator/src/lib.rs` |
| External-API client (never-throws, structured error decode) | `executor/src/core/aeroapi_client.ts` |
| Open-ended response types (boolean + null fields only) | `executor/src/core/types.ts` (`AeroFlight`, `AeroApiError`, `FlightStatus`) |
| Pure decision module | `executor/src/core/flight_data_fetcher.ts` (`decideFetcherActions`) |
| Cron orchestrator | `executor/src/core/flight_data_fetcher.ts` (`runFetcherOnce`) |
| Action → ix translator + CLI runner | `executor/src/scripts/run-fetcher.ts` |
| HTTP trigger (Express) | `executor/src/server.ts` (`tickFetcher`) |

The orchestrator + decision module are Codama-import-free. The runner is the only file that imports `getSetEstimatedArrivalInstructionAsync` / `getSetLandedInstructionAsync` / `getSetCancelledInstructionAsync`. Same boundary as the repricer cron — replicate it.

---

## 10. What I would change if starting over

- **Webhook + poll hybrid.** AeroAPI offers a flight-status webhook (`Aero Alerts`) for confirmed events. Subscribing for "actual_in set" + "cancelled" would let the cron react in seconds instead of 2h windows, with the 2h poll as a backstop for missed pushes. The state machine + decision module wouldn't change — just an additional caller of `applyAction`.
- **Cache `readActiveFlightList`.** Heavy `getAccountInfo` on every tick. Either subscribe to changes via websocket, or cache for 1 minute on the cron host.
- **Move PDA derivation into Codama-generated helpers.** Hand-derived PDAs in `deriveFlightDataPdaAddr` are the most-likely source of bugs. If you re-declare the `flight_data` account in the IDL with seeds, Codama generates the derivation for you — fewer hand-typed bytes, fewer mistakes.
- **Add an `actual_in` sanity bound.** `i64` can hold any value; the contract trusts it. A `require!(actual_arrival > 1_000_000_000_000 && actual_arrival < 4_000_000_000_000)` (year 2001 to year 2096 in millis, or seconds-range equivalent) would catch a typo'd 0 or a bogus 2099 timestamp.
- **Surface the per-tick histogram on a `/metrics` endpoint.** Today it's only in stdout + the JSONL. Prometheus scrape would let you alert on "0 acted, N skipped" for two ticks in a row.
