'use client';

import { useEffect, useRef, useState } from 'react';
import { useWalletConnection, useWalletSession } from '@solana/react-hooks';

/**
 * Topbar wallet chip — Wallet Standard via framework-kit.
 *
 * Disconnected: "Connect" button → opens a modal listing all detected
 * connectors. Connected: truncated address + mock balance + dropdown
 * with "Copy address" + "Disconnect".
 *
 * Mock balance is hardcoded for Phase 12 (`412.8 USDC`); Phase 14 wires
 * the real read from the connected wallet's USDC ATA.
 */

const MOCK_BALANCE = '412.8 USDC';

function truncateAddress(address: string): string {
  if (address.length < 9) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function WalletButton() {
  const { connectors, connect, disconnect, connected, connecting } =
    useWalletConnection();
  const session = useWalletSession();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const address = session?.account.address;

  // Close dropdown on outside click.
  useEffect(() => {
    if (!dropdownOpen) return;
    const onClick = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [dropdownOpen]);

  // Close picker after a successful connection.
  useEffect(() => {
    if (connected && pickerOpen) setPickerOpen(false);
  }, [connected, pickerOpen]);

  if (connected && address) {
    return (
      <div ref={dropdownRef} style={{ position: 'relative' }}>
        <button
          type="button"
          className="wallet"
          onClick={() => setDropdownOpen((v) => !v)}
          style={{ cursor: 'pointer' }}
        >
          <span className="chain" />
          <span className="addr">{truncateAddress(address)}</span>
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span className="bal">{MOCK_BALANCE}</span>
        </button>
        {dropdownOpen && (
          <div className="wallet-dropdown">
            <button
              type="button"
              className="wallet-dropdown-item"
              onClick={() => {
                navigator.clipboard?.writeText(address).catch(() => undefined);
                setDropdownOpen(false);
              }}
            >
              Copy address
            </button>
            <button
              type="button"
              className="wallet-dropdown-item"
              onClick={() => {
                void disconnect();
                setDropdownOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="btn primary"
        onClick={() => setPickerOpen(true)}
        disabled={connecting}
        style={{ padding: '6px 14px', fontSize: 12 }}
      >
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
      {pickerOpen && (
        <ConnectorPicker
          connectors={connectors}
          onClose={() => setPickerOpen(false)}
          onSelect={(id) => void connect(id)}
        />
      )}
    </>
  );
}

interface ConnectorPickerProps {
  connectors: ReadonlyArray<{ id: string; name: string }>;
  onClose: () => void;
  onSelect: (id: string) => void;
}

function ConnectorPicker({ connectors, onClose, onSelect }: ConnectorPickerProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-title">Connect a wallet</div>
        {connectors.length === 0 ? (
          <p
            style={{
              color: 'var(--ink-3)',
              fontSize: 13,
              fontFamily: 'var(--mono)',
            }}
          >
            No Wallet Standard wallets detected. Install Phantom or Solflare to continue.
          </p>
        ) : (
          connectors.map((c) => (
            <button
              key={c.id}
              type="button"
              className="modal-connector"
              onClick={() => onSelect(c.id)}
            >
              <span className="icon">◇</span>
              {c.name}
            </button>
          ))
        )}
        <button
          type="button"
          className="btn ghost"
          onClick={onClose}
          style={{ width: '100%', marginTop: 12 }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
