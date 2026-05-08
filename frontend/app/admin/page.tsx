'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createNoopSigner, type Address } from '@solana/kit';
import { useWalletSession } from '@solana/react-hooks';
import { findAssociatedTokenPda } from '@solana-program/token';
import { Card } from '@/components/admin/Card';
import { AddressBadge } from '@/components/admin/AddressBadge';
import { useRpc } from '@/lib/rpc';
import { useSendTx } from '@/lib/sendTx';
import { useToast } from '@/components/Toast';
import {
  readGovernanceConfig,
  readFlightPoolConfig,
  readOracleConfig,
  readControllerConfig,
  readAdminRecord,
  resolveRole,
  type AdminRole,
  type RouteSeeds,
} from '@/data';
import { MOCK_USDC_MINT, OWNER, PDAS, TOKEN_PROGRAM } from '@/config/devnet';
import {
  getSetDefaultsInstructionAsync,
  getWhitelistRouteInstructionAsync,
  getAddAdminInstructionAsync,
  getRemoveAdminInstructionAsync,
  type GovernanceConfig,
} from '@/clients/governance/src/generated';
import { getSetAuthorizedOracleInstructionAsync } from '@/clients/oracle_aggregator/src/generated';
import { getSetAuthorizedKeeperInstructionAsync } from '@/clients/controller/src/generated';
import {
  getWithdrawRecoveredInstructionAsync,
  type FlightPoolConfig,
} from '@/clients/flight_pool/src/generated';

import { fmtUsdc, toUsdcUnits } from '@/lib/usdc';

export default function AdminPage() {
  const session = useWalletSession();
  const wallet = session?.account.address as Address | undefined;
  const rpc = useRpc();
  const send = useSendTx();
  const { show } = useToast();

  const [govConfig, setGovConfig] = useState<{ data: GovernanceConfig } | null>(null);
  const [poolConfig, setPoolConfig] = useState<{ data: FlightPoolConfig } | null>(null);
  const [oracleAuthority, setOracleAuthority] = useState<Address | undefined>();
  const [keeperAuthority, setKeeperAuthority] = useState<Address | undefined>();
  const [role, setRole] = useState<AdminRole>('visitor');
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  // --- Mount: fetch every read in parallel.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [gov, pool, oracle, ctrl] = await Promise.all([
          readGovernanceConfig(rpc),
          readFlightPoolConfig(rpc),
          readOracleConfig(rpc),
          readControllerConfig(rpc),
        ]);
        if (cancelled) return;
        setGovConfig(gov);
        setPoolConfig(pool);
        setOracleAuthority(oracle.data.authorizedOracle);
        setKeeperAuthority(ctrl.data.authorizedKeeper);
        setRole(await resolveRole(rpc, wallet, gov));
      } catch (e) {
        if (!cancelled) {
          show({
            kind: 'error',
            title: 'Failed to load admin state',
            body: e instanceof Error ? e.message : String(e),
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, wallet, show, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  const isOwner = role === 'owner';
  const canWriteRoutes = role === 'owner' || role === 'admin';
  const noopSigner = useMemo(() => (wallet ? createNoopSigner(wallet) : undefined), [wallet]);

  return (
    <div style={{ padding: '24px 32px', display: 'grid', gap: 18, maxWidth: 1100 }}>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Admin</h1>
          <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
            Manage protocol defaults and routes ·{' '}
            <span style={{ color: roleColor(role) }}>{role.toUpperCase()}</span> wallet
          </div>
        </div>
        <button
          type="button"
          className="btn ghost"
          onClick={refresh}
          style={{ fontSize: 11 }}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {!session && (
        <div
          className="panel"
          style={{ padding: 14, borderColor: 'var(--amber)', color: 'var(--amber)' }}
        >
          Connect your wallet to perform admin actions. Visitors can read every value below.
        </div>
      )}

      <AuthorizedAddressesCard
        owner={govConfig?.data.owner}
        oracle={oracleAuthority}
        keeper={keeperAuthority}
        canWrite={isOwner}
        wallet={wallet}
        signer={noopSigner}
        send={send}
        onSuccess={refresh}
      />

      <DefaultsCard
        config={govConfig?.data}
        canWrite={isOwner}
        signer={noopSigner}
        send={send}
        onSuccess={refresh}
      />

      <RouteManagementCard
        canWrite={canWriteRoutes}
        signer={noopSigner}
        send={send}
        onSuccess={refresh}
      />

      <AdminManagementCard
        canWrite={isOwner}
        signer={noopSigner}
        send={send}
        rpc={rpc}
      />

      <FlightPoolTunablesCard
        config={poolConfig?.data}
        canWrite={isOwner}
        signer={noopSigner}
        send={send}
        wallet={wallet}
        onSuccess={refresh}
      />
    </div>
  );
}

function roleColor(role: AdminRole): string {
  if (role === 'owner') return 'var(--cyan)';
  if (role === 'admin') return 'var(--amber)';
  return 'var(--ink-3)';
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorized Addresses

interface AuthCardProps {
  owner: Address | undefined;
  oracle: Address | undefined;
  keeper: Address | undefined;
  canWrite: boolean;
  wallet: Address | undefined;
  signer: ReturnType<typeof createNoopSigner> | undefined;
  send: ReturnType<typeof useSendTx>;
  onSuccess: () => void;
}

function AuthorizedAddressesCard({
  owner,
  oracle,
  keeper,
  canWrite,
  signer,
  send,
  onSuccess,
}: AuthCardProps) {
  return (
    <Card
      title="Authorized Addresses"
      hint="On-chain authorities for governance + oracle + keeper. Owner-only writes."
      ownerOnly
      ownerOnlyVisible={canWrite}
    >
      <div className="col" style={{ gap: 12 }}>
        <Row label="Governance owner">
          <AddressBadge address={owner} />
        </Row>
        <Row label="Authorized oracle">
          <AddressBadge address={oracle} />
        </Row>
        <Row label="Authorized keeper">
          <AddressBadge address={keeper} />
        </Row>
      </div>

      {canWrite && signer && (
        <div className="col" style={{ gap: 12, marginTop: 18 }}>
          <PubkeyForm
            label="Set Authorized Oracle"
            buttonLabel="Set Oracle"
            initial={oracle}
            onSubmit={async (newPubkey) => {
              const ix = await getSetAuthorizedOracleInstructionAsync({
                owner: signer,
                newOracle: newPubkey,
              });
              const r = await send([ix], { successTitle: 'Oracle authority updated' });
              if (r.ok) onSuccess();
            }}
          />
          <PubkeyForm
            label="Set Authorized Keeper"
            buttonLabel="Set Keeper"
            initial={keeper}
            onSubmit={async (newPubkey) => {
              const ix = await getSetAuthorizedKeeperInstructionAsync({
                owner: signer,
                newKeeper: newPubkey,
              });
              const r = await send([ix], { successTitle: 'Keeper authority updated' });
              if (r.ok) onSuccess();
            }}
          />
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults card

interface DefaultsCardProps {
  config: GovernanceConfig | undefined;
  canWrite: boolean;
  signer: ReturnType<typeof createNoopSigner> | undefined;
  send: ReturnType<typeof useSendTx>;
  onSuccess: () => void;
}

function DefaultsCard({ config, canWrite, signer, send, onSuccess }: DefaultsCardProps) {
  const [premium, setPremium] = useState('');
  const [payoff, setPayoff] = useState('');
  const [delay, setDelay] = useState('');

  useEffect(() => {
    if (!config) return;
    setPremium(fmtUsdc(config.defaultPremium));
    setPayoff(fmtUsdc(config.defaultPayoff));
    setDelay(String(config.defaultDelayHours));
  }, [config]);

  const submit = async () => {
    if (!signer || !config) return;
    try {
      const ix = await getSetDefaultsInstructionAsync({
        owner: signer,
        premium: toUsdcUnits(premium),
        payoff: toUsdcUnits(payoff),
        delayHours: Number(delay),
      });
      const r = await send([ix], { successTitle: 'Defaults updated' });
      if (r.ok) onSuccess();
    } catch (e) {
      // toast handled in send()
      void e;
    }
  };

  return (
    <Card
      title="Defaults"
      hint="Fallback terms applied to any whitelisted route without per-route overrides."
      ownerOnly
      ownerOnlyVisible={canWrite}
    >
      <div className="col" style={{ gap: 8 }}>
        <KvRow k="default_premium" v={config ? `${fmtUsdc(config.defaultPremium)} USDC` : '—'} />
        <KvRow k="default_payoff" v={config ? `${fmtUsdc(config.defaultPayoff)} USDC` : '—'} />
        <KvRow k="default_delay_hours" v={config ? String(config.defaultDelayHours) : '—'} />
        <KvRow k="route_count" v={config ? String(config.routeCount) : '—'} />
      </div>

      {canWrite && signer && config && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="col"
          style={{ gap: 8, marginTop: 18 }}
        >
          <Field label="Premium (USDC)">
            <input
              className="input"
              type="text"
              value={premium}
              onChange={(e) => setPremium(e.target.value)}
            />
          </Field>
          <Field label="Payoff (USDC)">
            <input
              className="input"
              type="text"
              value={payoff}
              onChange={(e) => setPayoff(e.target.value)}
            />
          </Field>
          <Field label="Delay hours">
            <input
              className="input"
              type="number"
              min={0}
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
            />
          </Field>
          <button type="submit" className="btn primary">
            Update Defaults
          </button>
        </form>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Management

interface RouteCardProps {
  canWrite: boolean;
  signer: ReturnType<typeof createNoopSigner> | undefined;
  send: ReturnType<typeof useSendTx>;
  onSuccess: () => void;
}

function RouteManagementCard({ canWrite, signer, send, onSuccess }: RouteCardProps) {
  return (
    <Card
      title="Add Route"
      hint="Whitelist a new route for the controller to accept."
    >
      {canWrite && signer ? (
        <AddRouteForm signer={signer} send={send} onSuccess={onSuccess} />
      ) : (
        <div className="muted mono" style={{ fontSize: 12 }}>
          Connect an owner or admin wallet to whitelist routes.
        </div>
      )}
    </Card>
  );
}

function AddRouteForm({
  signer,
  send,
  onSuccess,
}: {
  signer: ReturnType<typeof createNoopSigner>;
  send: ReturnType<typeof useSendTx>;
  onSuccess: () => void;
}) {
  const [flightId, setFlightId] = useState('');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [premium, setPremium] = useState('');
  const [payoff, setPayoff] = useState('');
  const [delay, setDelay] = useState('');

  const submit = async (seeds: RouteSeeds) => {
    try {
      const ix = await getWhitelistRouteInstructionAsync({
        caller: signer,
        flightId: seeds.flightId,
        origin: seeds.origin,
        destination: seeds.destination,
        premium: premium ? toUsdcUnits(premium) : null,
        payoff: payoff ? toUsdcUnits(payoff) : null,
        delayHours: delay ? Number(delay) : null,
      });
      const r = await send([ix], { successTitle: `Whitelisted ${seeds.flightId}` });
      if (r.ok) {
        setFlightId('');
        setOrigin('');
        setDestination('');
        setPremium('');
        setPayoff('');
        setDelay('');
        onSuccess();
      }
    } catch (e) {
      void e;
    }
  };

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
        ADD ROUTE
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input"
          placeholder="flight_id"
          value={flightId}
          onChange={(e) => setFlightId(e.target.value)}
          style={{ flex: '1 1 130px' }}
        />
        <input
          className="input"
          placeholder="origin"
          value={origin}
          onChange={(e) => setOrigin(e.target.value.toUpperCase())}
          maxLength={3}
          style={{ flex: '0 0 80px' }}
        />
        <input
          className="input"
          placeholder="destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value.toUpperCase())}
          maxLength={3}
          style={{ flex: '0 0 90px' }}
        />
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input"
          placeholder="premium override (blank = default)"
          value={premium}
          onChange={(e) => setPremium(e.target.value)}
          style={{ flex: '1 1 200px' }}
        />
        <input
          className="input"
          placeholder="payoff override (blank = default)"
          value={payoff}
          onChange={(e) => setPayoff(e.target.value)}
          style={{ flex: '1 1 200px' }}
        />
        <input
          className="input"
          placeholder="delay hours override"
          value={delay}
          onChange={(e) => setDelay(e.target.value)}
          style={{ flex: '0 0 140px' }}
        />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn primary"
          disabled={!flightId || !origin || !destination}
          onClick={() => {
            if (!flightId || !origin || !destination) return;
            void submit({ flightId, origin, destination });
          }}
        >
          Whitelist Route
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Management

interface AdminMgmtProps {
  canWrite: boolean;
  signer: ReturnType<typeof createNoopSigner> | undefined;
  send: ReturnType<typeof useSendTx>;
  rpc: ReturnType<typeof useRpc>;
}

function AdminManagementCard({ canWrite, signer, send, rpc }: AdminMgmtProps) {
  const [lookupAddr, setLookupAddr] = useState('');
  const [lookupResult, setLookupResult] = useState<string>('');

  return (
    <Card
      title="Admin Management"
      hint="Owner-only. Adds or removes co-admins (route management actions only)."
      ownerOnly
      ownerOnlyVisible={canWrite}
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="admin pubkey to look up"
            value={lookupAddr}
            onChange={(e) => setLookupAddr(e.target.value)}
            style={{ flex: '1 1 280px' }}
          />
          <button
            type="button"
            className="btn ghost"
            onClick={async () => {
              if (!lookupAddr) return;
              try {
                const m = await readAdminRecord(rpc, lookupAddr as Address);
                setLookupResult(
                  m.exists
                    ? `is_active=${m.data.isActive}`
                    : 'no AdminRecord PDA exists',
                );
              } catch (e) {
                setLookupResult(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Lookup
          </button>
        </div>
        {lookupResult && (
          <div className="muted mono" style={{ fontSize: 11 }}>
            {lookupResult}
          </div>
        )}
      </div>

      {canWrite && signer && (
        <div className="col" style={{ gap: 8, marginTop: 18 }}>
          <PubkeyForm
            label="Add Admin"
            buttonLabel="Add Admin"
            onSubmit={async (admin) => {
              const ix = await getAddAdminInstructionAsync({
                owner: signer,
                admin,
              });
              await send([ix], { successTitle: `Admin added: ${admin.slice(0, 4)}…` });
            }}
          />
          <PubkeyForm
            label="Remove Admin"
            buttonLabel="Remove Admin"
            onSubmit={async (admin) => {
              const ix = await getRemoveAdminInstructionAsync({
                owner: signer,
                admin,
              });
              await send([ix], { successTitle: `Admin removed: ${admin.slice(0, 4)}…` });
            }}
          />
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Flight Pool Tunables

interface FlightPoolTunablesProps {
  config: FlightPoolConfig | undefined;
  canWrite: boolean;
  signer: ReturnType<typeof createNoopSigner> | undefined;
  send: ReturnType<typeof useSendTx>;
  wallet: Address | undefined;
  onSuccess: () => void;
}

function FlightPoolTunablesCard({
  config,
  canWrite,
  signer,
  send,
  wallet,
  onSuccess,
}: FlightPoolTunablesProps) {
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');

  return (
    <Card
      title="Flight Pool Tunables"
      hint="Owner-only. Withdraw recovered USDC (expired claims) from the pool treasury."
      ownerOnly
      ownerOnlyVisible={canWrite}
    >
      <div className="col" style={{ gap: 8 }}>
        <KvRow
          k="recovered_balance"
          v={config ? `${fmtUsdc(config.recoveredBalance)} USDC` : '—'}
        />
        <KvRow k="pool_treasury" v={config?.poolTreasury ?? '—'} mono />
        <KvRow k="treasury_authority" v={PDAS.poolTreasuryAuthority} mono />
      </div>

      {canWrite && signer && wallet && config && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const recipientAddr = (recipient || OWNER) as Address;
            try {
              const [ownerAta] = await findAssociatedTokenPda({
                owner: recipientAddr,
                mint: MOCK_USDC_MINT,
                tokenProgram: TOKEN_PROGRAM,
              });
              const ix = await getWithdrawRecoveredInstructionAsync({
                owner: signer,
                poolTreasury: config.poolTreasury,
                ownerUsdcAccount: ownerAta,
                usdcMint: MOCK_USDC_MINT,
                amount: toUsdcUnits(amount),
              });
              const r = await send([ix], {
                successTitle: `Withdrew ${amount} USDC from recovery pool`,
              });
              if (r.ok) {
                setAmount('');
                onSuccess();
              }
            } catch (e2) {
              void e2;
            }
          }}
          className="col"
          style={{ gap: 8, marginTop: 18 }}
        >
          <Field label="Amount (USDC)">
            <input
              className="input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </Field>
          <Field label="Recipient (optional, default owner)">
            <input
              className="input"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={OWNER}
            />
          </Field>
          <button type="submit" className="btn primary" disabled={!amount}>
            Withdraw Recovered
          </button>
        </form>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny shared bits

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="muted mono" style={{ fontSize: 11, flex: '0 0 160px' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function KvRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="row between">
      <span className="muted mono" style={{ fontSize: 11 }}>
        {k}
      </span>
      <span className={mono ? 'mono' : 'num'} style={{ fontSize: 12 }}>
        {v}
      </span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="col" style={{ gap: 4 }}>
      <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
        {label.toUpperCase()}
      </span>
      {children}
    </label>
  );
}

function PubkeyForm({
  label,
  buttonLabel,
  initial,
  onSubmit,
}: {
  label: string;
  buttonLabel: string;
  initial?: Address;
  onSubmit: (addr: Address) => Promise<void>;
}) {
  const [value, setValue] = useState<string>(initial ?? '');

  // Keep the input synced with the initial when it loads asynchronously.
  useEffect(() => {
    if (initial) setValue(initial);
  }, [initial]);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value) return;
        await onSubmit(value as Address);
      }}
      className="col"
      style={{ gap: 4 }}
    >
      <span className="muted mono" style={{ fontSize: 10, letterSpacing: '.1em' }}>
        {label.toUpperCase()}
      </span>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: 1 }}
          placeholder="pubkey…"
        />
        <button type="submit" className="btn primary" disabled={!value}>
          {buttonLabel}
        </button>
      </div>
    </form>
  );
}
