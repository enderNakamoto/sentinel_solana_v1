'use client';

import { useState } from 'react';
import { explorerLink } from '@/config/devnet';

interface AddressBadgeProps {
  address: string | undefined;
  label?: string;
  /** Optional shorter form — `4...4` instead of full pubkey. */
  truncate?: boolean;
}

function truncate(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function AddressBadge({ address, label, truncate: doTruncate = true }: AddressBadgeProps) {
  const [copied, setCopied] = useState(false);

  if (!address) {
    return (
      <span className="muted mono" style={{ fontSize: 11 }}>
        — not set —
      </span>
    );
  }

  const onCopy = () => {
    navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };

  return (
    <div className="row" style={{ gap: 8 }}>
      {label && (
        <span className="muted mono" style={{ fontSize: 10 }}>
          {label}
        </span>
      )}
      <code
        className="mono"
        style={{
          fontSize: 11,
          padding: '3px 8px',
          background: 'var(--bg-2)',
          borderRadius: 4,
          color: 'var(--ink)',
        }}
      >
        {doTruncate ? truncate(address) : address}
      </code>
      <button
        type="button"
        onClick={onCopy}
        title="Copy"
        className="btn ghost"
        style={{ padding: '2px 8px', fontSize: 10 }}
      >
        {copied ? '✓' : 'Copy'}
      </button>
      <a
        href={explorerLink(address, 'address')}
        target="_blank"
        rel="noreferrer"
        className="btn ghost"
        style={{ padding: '2px 8px', fontSize: 10 }}
      >
        Explorer ↗
      </a>
    </div>
  );
}
