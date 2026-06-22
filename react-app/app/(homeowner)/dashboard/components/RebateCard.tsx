'use client';

/**
 * D-181 Hover measurement payment + rebate status — DISPLAY ONLY.
 *
 * These "$" values (homeowner_charge_amount, rebate_*, the payment intent id) are
 * surfaced for the homeowner's awareness only. No charge / payment logic lives on
 * this page — the real money movement happens downstream in
 * docusign-webhook/stripe-webhook (D-127). Mirrors dashboard.html:2171-2222.
 */

import { buildRebateCard, shouldShowRebateCard } from '../utils';
import type { HoverRebateOrder } from '../types';

const BADGE: Record<string, string> = {
  rebated: '#10B981',
  pending: 'var(--amber, #E07B00)',
  on_file: '#64748B',
};

export function RebateCard({ order }: { order: HoverRebateOrder | null }) {
  if (!shouldShowRebateCard(order)) return null;
  const model = buildRebateCard(order);

  return (
    <div
      style={{
        marginTop: '1.25rem',
        background: 'var(--navy-2, #0f2942)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '0.875rem',
        padding: '1.25rem 1.5rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
        <div style={{ fontSize: '1.75rem', flexShrink: 0, lineHeight: 1 }} aria-hidden="true">
          💳
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontWeight: 700,
              color: BADGE[model.variant],
              fontSize: '1rem',
              marginBottom: '0.5rem',
            }}
          >
            {model.header}
          </div>
          <div
            style={{
              fontSize: '0.875rem',
              color: 'rgba(255,255,255,0.85)',
              lineHeight: 1.55,
            }}
          >
            {model.body}
          </div>
        </div>
      </div>
    </div>
  );
}
