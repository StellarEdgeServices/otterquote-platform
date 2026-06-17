/**
 * Unit + parity tests for Admin Commission Payouts pure logic (D-211 Phase 10).
 *
 * Pins PAYOUT_FILTERS, filterPayouts, summaryCards, formatMoneyWhole,
 * formatMoneyCents, payoutTypeLabel, triggerText, autoApproveLabel,
 * statusBadge, isRejectReasonValid, approvePayload, and rejectPayload
 * against admin-payouts.html @ main behavior.
 *
 * No network / supabase calls — all helpers are side-effect-free.
 */

import { describe, it, expect } from 'vitest';
import {
  type PayoutApproval,
  PAYOUT_FILTERS,
  filterPayouts,
  summaryCards,
  formatMoneyWhole,
  formatMoneyCents,
  formatPayoutDate,
  payoutTypeLabel,
  triggerText,
  autoApproveLabel,
  statusBadge,
  isRejectReasonValid,
  approvePayload,
  rejectPayload,
} from '../utils';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function mkPayout(over: Partial<PayoutApproval> = {}): PayoutApproval {
  return {
    id: over.id ?? 'p-1',
    partner_name: over.partner_name ?? 'Acme Partner',
    payout_type: over.payout_type ?? 'recruit_bonus',
    amount: over.amount ?? 100,
    trigger_event: over.trigger_event ?? null,
    created_at: over.created_at ?? '2026-06-17T12:00:00Z',
    auto_approve_at: over.auto_approve_at ?? null,
    status: over.status ?? 'pending_approval',
    approved_at: over.approved_at ?? null,
    rejected_at: over.rejected_at ?? null,
    rejection_reason: over.rejection_reason ?? null,
    ...over,
  };
}

// ── PAYOUT_FILTERS ────────────────────────────────────────────────────────────

describe('PAYOUT_FILTERS', () => {
  it('exposes exactly 6 keys in the correct order', () => {
    expect(PAYOUT_FILTERS.map((f) => f.key)).toEqual([
      'all',
      'pending_approval',
      'approved',
      'auto_approved',
      'rejected',
      'pre_approved',
    ]);
  });
});

// ── filterPayouts ─────────────────────────────────────────────────────────────

describe('filterPayouts', () => {
  const rows: PayoutApproval[] = [
    mkPayout({ id: 'p-pend', status: 'pending_approval' }),
    mkPayout({ id: 'p-appr', status: 'approved' }),
    mkPayout({ id: 'p-auto', status: 'auto_approved' }),
    mkPayout({ id: 'p-rej',  status: 'rejected' }),
    mkPayout({ id: 'p-pre',  status: 'pre_approved' }),
  ];

  it('"all" returns all rows', () => {
    expect(filterPayouts(rows, 'all')).toHaveLength(5);
    expect(filterPayouts(rows, 'all')).toEqual(rows);
  });

  it('"pending_approval" returns only pending rows', () => {
    const result = filterPayouts(rows, 'pending_approval');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-pend');
  });

  it('"approved" returns only approved rows', () => {
    const result = filterPayouts(rows, 'approved');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-appr');
  });

  it('"auto_approved" returns only auto_approved rows', () => {
    const result = filterPayouts(rows, 'auto_approved');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-auto');
  });

  it('"rejected" returns only rejected rows', () => {
    const result = filterPayouts(rows, 'rejected');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-rej');
  });

  it('"pre_approved" returns only pre_approved rows', () => {
    const result = filterPayouts(rows, 'pre_approved');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-pre');
  });

  it('empty input returns empty array for any filter', () => {
    expect(filterPayouts([], 'all')).toEqual([]);
    expect(filterPayouts([], 'pending_approval')).toEqual([]);
    expect(filterPayouts([], 'approved')).toEqual([]);
  });
});

// ── summaryCards ──────────────────────────────────────────────────────────────

describe('summaryCards', () => {
  // Fixed "now" = 2026-06-17. Month start = 2026-06-01T00:00:00.000Z
  const NOW = new Date('2026-06-17T12:00:00Z');

  const fixture: PayoutApproval[] = [
    // pending_approval — always counted, amount 200
    mkPayout({ id: 'f-pend1', status: 'pending_approval', amount: 200 }),
    mkPayout({ id: 'f-pend2', status: 'pending_approval', amount: 300 }),
    // approved this month — counted, amount 500
    mkPayout({ id: 'f-appr-this', status: 'approved', amount: 500, approved_at: '2026-06-10T10:00:00Z' }),
    // approved last month — NOT counted (approved_at < monthStart)
    mkPayout({ id: 'f-appr-last', status: 'approved', amount: 999, approved_at: '2026-05-31T23:59:59Z' }),
    // approved but null approved_at — NOT counted (TS guard)
    mkPayout({ id: 'f-appr-null', status: 'approved', amount: 100, approved_at: null }),
    // auto_approved this month — counted, amount 150
    mkPayout({ id: 'f-auto-this', status: 'auto_approved', amount: 150, approved_at: '2026-06-05T08:00:00Z' }),
    // auto_approved with null approved_at — NOT counted
    mkPayout({ id: 'f-auto-null', status: 'auto_approved', amount: 999, approved_at: null }),
    // rejected — all time count
    mkPayout({ id: 'f-rej1', status: 'rejected', amount: 0 }),
    mkPayout({ id: 'f-rej2', status: 'rejected', amount: 0 }),
    // pre_approved — not counted in any card
    mkPayout({ id: 'f-pre', status: 'pre_approved', amount: 9999 }),
  ];

  it('computes all 7 summary fields correctly', () => {
    const result = summaryCards(fixture, NOW);
    expect(result).toEqual({
      pendingCount: 2,
      pendingAmount: 500,   // 200 + 300
      approvedCount: 1,     // only this-month row
      approvedAmount: 500,
      autoCount: 1,         // only this-month row
      autoAmount: 150,
      rejectedCount: 2,
    });
  });

  it('last-month approved row is excluded from approvedCount/approvedAmount', () => {
    const result = summaryCards(fixture, NOW);
    // If the last-month row (amount 999) were included, approvedAmount would be 1499
    expect(result.approvedAmount).not.toBe(1499);
    expect(result.approvedCount).toBe(1);
  });

  it('null approved_at approved row is excluded from approvedCount', () => {
    const result = summaryCards(fixture, NOW);
    // approved rows with null approved_at must not be counted
    expect(result.approvedCount).toBe(1);
  });

  it('null approved_at auto_approved row is excluded from autoCount', () => {
    const result = summaryCards(fixture, NOW);
    expect(result.autoCount).toBe(1);
  });

  it('returns zeros for empty array', () => {
    const result = summaryCards([], NOW);
    expect(result).toEqual({
      pendingCount: 0,
      pendingAmount: 0,
      approvedCount: 0,
      approvedAmount: 0,
      autoCount: 0,
      autoAmount: 0,
      rejectedCount: 0,
    });
  });
});

// ── formatMoneyWhole ──────────────────────────────────────────────────────────

describe('formatMoneyWhole', () => {
  it('1234 → "$1,234"', () => {
    expect(formatMoneyWhole(1234)).toBe('$1,234');
  });

  it('0 → "$0"', () => {
    expect(formatMoneyWhole(0)).toBe('$0');
  });

  it('1234.56 → "$1,235" (rounds to 0 fraction digits)', () => {
    expect(formatMoneyWhole(1234.56)).toBe('$1,235');
  });
});

// ── formatMoneyCents ──────────────────────────────────────────────────────────

describe('formatMoneyCents', () => {
  it('1234.5 → "$1,234.50"', () => {
    expect(formatMoneyCents(1234.5)).toBe('$1,234.50');
  });

  it('"99" (string) → "$99.00"', () => {
    expect(formatMoneyCents('99')).toBe('$99.00');
  });

  it('null → "$0.00" (Number(null) = 0)', () => {
    expect(formatMoneyCents(null)).toBe('$0.00');
  });

  it('1000000 → "$1,000,000.00"', () => {
    expect(formatMoneyCents(1000000)).toBe('$1,000,000.00');
  });
});

// ── payoutTypeLabel ───────────────────────────────────────────────────────────

describe('payoutTypeLabel', () => {
  it('"commission_referral" → "Referral"', () => {
    expect(payoutTypeLabel('commission_referral')).toBe('Referral');
  });

  it('"recruit_bonus" → "Recruit Bonus"', () => {
    expect(payoutTypeLabel('recruit_bonus')).toBe('Recruit Bonus');
  });

  it('null → "Recruit Bonus" (default branch)', () => {
    expect(payoutTypeLabel(null)).toBe('Recruit Bonus');
  });
});

// ── triggerText ───────────────────────────────────────────────────────────────

describe('triggerText', () => {
  it('null → "—"', () => {
    expect(triggerText(null)).toBe('—');
  });

  it('undefined → "—"', () => {
    expect(triggerText(undefined)).toBe('—');
  });

  it('80-char string is truncated to 60 chars', () => {
    const long = 'a'.repeat(80);
    const result = triggerText(long);
    expect(result.length).toBe(60);
  });

  it('string shorter than 60 is returned as-is', () => {
    expect(triggerText('hello')).toBe('hello');
  });
});

// ── autoApproveLabel ──────────────────────────────────────────────────────────

describe('autoApproveLabel', () => {
  it('null → "—"', () => {
    expect(autoApproveLabel(null)).toBe('—');
  });

  it('undefined → "—"', () => {
    expect(autoApproveLabel(undefined)).toBe('—');
  });

  it('a valid date string → formatPayoutDate of it', () => {
    const iso = '2026-06-17T12:00:00Z';
    expect(autoApproveLabel(iso)).toBe(formatPayoutDate(iso));
  });
});

// ── statusBadge ───────────────────────────────────────────────────────────────

describe('statusBadge', () => {
  it('"pending_approval" → { label: "Pending", className: "badge-pending" }', () => {
    expect(statusBadge('pending_approval')).toEqual({ label: 'Pending', className: 'badge-pending' });
  });

  it('"approved" → { label: "Approved", className: "badge-approved" }', () => {
    expect(statusBadge('approved')).toEqual({ label: 'Approved', className: 'badge-approved' });
  });

  it('"auto_approved" → { label: "Auto-Approved", className: "badge-auto" }', () => {
    expect(statusBadge('auto_approved')).toEqual({ label: 'Auto-Approved', className: 'badge-auto' });
  });

  it('"rejected" → { label: "Rejected", className: "badge-rejected" }', () => {
    expect(statusBadge('rejected')).toEqual({ label: 'Rejected', className: 'badge-rejected' });
  });

  it('"pre_approved" → { label: "Pre-Approved", className: "badge-pre" }', () => {
    expect(statusBadge('pre_approved')).toEqual({ label: 'Pre-Approved', className: 'badge-pre' });
  });

  it('unknown status falls back to { label: raw, className: "badge-pre" }', () => {
    expect(statusBadge('weird_status')).toEqual({ label: 'weird_status', className: 'badge-pre' });
  });
});

// ── isRejectReasonValid ───────────────────────────────────────────────────────

describe('isRejectReasonValid', () => {
  it('empty string → false', () => {
    expect(isRejectReasonValid('')).toBe(false);
  });

  it('"abc" (3 chars) → false', () => {
    expect(isRejectReasonValid('abc')).toBe(false);
  });

  it('"    " (whitespace only) → false', () => {
    expect(isRejectReasonValid('    ')).toBe(false);
  });

  it('"abcde" (5 chars) → true', () => {
    expect(isRejectReasonValid('abcde')).toBe(true);
  });

  it('"  abcde  " (trims to 5) → true', () => {
    expect(isRejectReasonValid('  abcde  ')).toBe(true);
  });

  it('"a long reason" → true', () => {
    expect(isRejectReasonValid('a long reason')).toBe(true);
  });

  it('null → false', () => {
    expect(isRejectReasonValid(null)).toBe(false);
  });

  it('undefined → false', () => {
    expect(isRejectReasonValid(undefined)).toBe(false);
  });
});

// ── approvePayload ────────────────────────────────────────────────────────────

describe('approvePayload', () => {
  it('returns exactly { payout_approval_id: "p1" }', () => {
    expect(approvePayload('p1')).toEqual({ payout_approval_id: 'p1' });
  });
});

// ── rejectPayload ─────────────────────────────────────────────────────────────

describe('rejectPayload', () => {
  it('returns exactly { payout_approval_id: "p1", rejection_reason: "too high" }', () => {
    expect(rejectPayload('p1', 'too high')).toEqual({
      payout_approval_id: 'p1',
      rejection_reason: 'too high',
    });
  });
});
