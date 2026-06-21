'use client';

import type { ReactNode } from 'react';

interface CardProps {
  title: string;
  hint?: string;
  ownerOnly?: boolean;
  ownerOnlyVisible?: boolean;
  children: ReactNode;
}

/**
 * Glass-panel admin card with a title row + optional owner-only badge.
 * Hides write-row children when `ownerOnlyVisible` is false (the consumer
 * decides what's a write row vs a read row by composition).
 */
export function Card({ title, hint, ownerOnly, ownerOnlyVisible = true, children }: CardProps) {
  return (
    <section className="panel" style={{ padding: 18 }}>
      <header className="row between" style={{ marginBottom: 14 }}>
        <div>
          <div className="card-title">{title}</div>
          {hint && (
            <div className="muted mono" style={{ fontSize: 10, marginTop: 4 }}>
              {hint}
            </div>
          )}
        </div>
        {ownerOnly && (
          <span
            className="badge violet"
            style={{ fontSize: 9 }}
          >
            OWNER-ONLY
          </span>
        )}
      </header>
      <div style={{ opacity: ownerOnlyVisible ? 1 : 0.5 }}>{children}</div>
    </section>
  );
}
