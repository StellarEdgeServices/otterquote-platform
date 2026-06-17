/**
 * Admin Commission Payouts — pure logic (D-211 Phase 10).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing.
 * All network / supabase calls live in page.tsx — never here.
 *
 * Port of admin-payouts.html behavior 1:1.
 *
 * §6.1 XSS note: all values are returned as plain data; JSX rendering
 * in page.tsx is inherently escaped. No HTML strings built here.
 */

// ── Data model ───────────────────────────────────────────────────────────────

export interface PayoutApproval {
  id: string;
  partner_name?: string | null;
  payout_type?: string | null;
  amount?: number | string | null;
  trigger_event?: string | null;
  created_at: string;
  auto_approve_at?: string | null;
  status: string;
  approved_at?: string | null;
  rejected_at?: string | null;
  rejection_reason?: string | null;
  [key: string]: unknown; // select('*') returns more columns
}

// ── Filter tabs ──────────────────────────────────────────────────────────────

export type PayoutFilter =
  | 'all'
  | 'pending_approval'
  | 'approved'
  | 'auto_approved'
  | 'rejected'
  | 'pre_approved';

export const PAYOUT_FILTERS: { key: PayoutFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending_approval', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'auto_approved', label: 'Auto-Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'pre_approved', label: 'Pre-Approved' },
];

/**
 * Filter rows for the active tab.
 * 'all' → every row; else rows where status === filter.
 * Mirrors renderTable()'s filtered logic in admin-payouts.html.
 */
export function filterPayouts(
  payouts: PayoutApproval[],
  filter: PayoutFilter,
): PayoutApproval[] {
  if (filter === 'all') return payouts;
  return payouts.filter((p) => p.status === filter);
}

// ── Summary helpers ──────────────────────────────────────────────────────────

/**
 * Sum of Number(r.amount || 0) over rows.
 * Mirrors sumAmount in admin-payouts.html updateSummaryCards().
 */
export function sumAmount(rows: PayoutApproval[]): number {
  return rows.reduce((s, r) => s + Number(r.amount || 0), 0);
}

/**
 * monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().
 * now injectable, defaults to new Date().
 */
export function monthStartIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

// ── Summary cards ─────────────────────────────────────────────────────────────

export interface PayoutSummary {
  pendingCount: number;
  pendingAmount: number;
  approvedCount: number;
  approvedAmount: number;
  autoCount: number;
  autoAmount: number;
  rejectedCount: number;
}

/**
 * Summary card data. Mirrors updateSummaryCards() EXACTLY.
 * now injectable (default new Date()).
 *
 *   pendingCount  = count status==='pending_approval'
 *   pendingAmount = sumAmount of those
 *   approvedCount = count status==='approved'   && !!approved_at && approved_at >= monthStartIso(now)
 *   approvedAmount= sumAmount of those
 *   autoCount     = count status==='auto_approved' && !!approved_at && approved_at >= monthStartIso(now)
 *   autoAmount    = sumAmount of those
 *   rejectedCount = count status==='rejected'
 *
 * (String comparison approved_at >= monthStart, guarded by !!approved_at to satisfy TS.)
 */
export function summaryCards(
  payouts: PayoutApproval[],
  now: Date = new Date(),
): PayoutSummary {
  const monthStart = monthStartIso(now);

  const pending = payouts.filter((p) => p.status === 'pending_approval');
  const approved = payouts.filter(
    (p) =>
      p.status === 'approved' &&
      !!p.approved_at &&
      (p.approved_at as string) >= monthStart,
  );
  const auto = payouts.filter(
    (p) =>
      p.status === 'auto_approved' &&
      !!p.approved_at &&
      (p.approved_at as string) >= monthStart,
  );
  const rejected = payouts.filter((p) => p.status === 'rejected');

  return {
    pendingCount: pending.length,
    pendingAmount: sumAmount(pending),
    approvedCount: approved.length,
    approvedAmount: sumAmount(approved),
    autoCount: auto.length,
    autoAmount: sumAmount(auto),
    rejectedCount: rejected.length,
  };
}

// ── Display helpers ──────────────────────────────────────────────────────────

/**
 * '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).
 * For summary sub-text. Mirrors fmt() in admin-payouts.html.
 */
export function formatMoneyWhole(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).
 * For the Amount column. Mirrors per-row amount formatting in admin-payouts.html.
 */
export function formatMoneyCents(n: number | string | null | undefined): string {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).
 * Mirrors created / autoOn in admin-payouts.html.
 */
export function formatPayoutDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * auto_approve_at ? formatPayoutDate(auto_approve_at) : '—'.
 * Mirrors autoOn in admin-payouts.html renderTable().
 */
export function autoApproveLabel(autoApproveAt: string | null | undefined): string {
  return autoApproveAt ? formatPayoutDate(autoApproveAt) : '—';
}

/**
 * payout_type === 'commission_referral' ? 'Referral' : 'Recruit Bonus'.
 * Mirrors payoutTypeLabel in admin-payouts.html renderTable().
 */
export function payoutTypeLabel(payoutType: string | null | undefined): string {
  return payoutType === 'commission_referral' ? 'Referral' : 'Recruit Bonus';
}

/**
 * (trigger_event || '—').substring(0, 60).
 * Mirrors trigger in admin-payouts.html renderTable().
 */
export function triggerText(triggerEvent: string | null | undefined): string {
  return (triggerEvent || '—').substring(0, 60);
}

// ── Status badge ─────────────────────────────────────────────────────────────

export interface PayoutStatusBadge {
  label: string;
  /** Badge CSS modifier class, e.g. 'badge-pending'. */
  className: string;
}

/**
 * Status badge descriptor (NOT html). Mirrors the statusBadge map in renderTable().
 *
 *   pending_approval → { label: 'Pending',       className: 'badge-pending' }
 *   approved         → { label: 'Approved',      className: 'badge-approved' }
 *   auto_approved    → { label: 'Auto-Approved', className: 'badge-auto' }
 *   rejected         → { label: 'Rejected',      className: 'badge-rejected' }
 *   pre_approved     → { label: 'Pre-Approved',  className: 'badge-pre' }
 *   default (unknown)→ { label: status (raw),    className: 'badge-pre' }
 */
export function statusBadge(status: string): PayoutStatusBadge {
  switch (status) {
    case 'pending_approval':
      return { label: 'Pending', className: 'badge-pending' };
    case 'approved':
      return { label: 'Approved', className: 'badge-approved' };
    case 'auto_approved':
      return { label: 'Auto-Approved', className: 'badge-auto' };
    case 'rejected':
      return { label: 'Rejected', className: 'badge-rejected' };
    case 'pre_approved':
      return { label: 'Pre-Approved', className: 'badge-pre' };
    default:
      return { label: status, className: 'badge-pre' };
  }
}

// ── Reject reason validation ──────────────────────────────────────────────────

/**
 * Minimum trimmed length for a reject reason (matches updateRejectBtn / handleReject
 * in admin-payouts.html).
 */
export const REJECT_MIN_LENGTH = 5;

/**
 * Reject reason validation. Static requires trimmed length >= 5.
 */
export function isRejectReasonValid(reason: string | null | undefined): boolean {
  return (reason ?? '').trim().length >= REJECT_MIN_LENGTH;
}

// ── EF payload builders — UNCHANGED CONTRACTS (Tier-3) ───────────────────────

export interface ApprovePayoutPayload {
  payout_approval_id: string;
}

export interface RejectPayoutPayload {
  payout_approval_id: string;
  rejection_reason: string;
}

/**
 * Build the approve-payout EF payload.
 * Field names UNCHANGED from admin-payouts.html JSON.stringify body.
 */
export function approvePayload(payoutApprovalId: string): ApprovePayoutPayload {
  return { payout_approval_id: payoutApprovalId };
}

/**
 * Build the reject-payout EF payload.
 * Field names UNCHANGED from admin-payouts.html JSON.stringify body.
 */
export function rejectPayload(
  payoutApprovalId: string,
  reason: string,
): RejectPayoutPayload {
  return { payout_approval_id: payoutApprovalId, rejection_reason: reason };
}
