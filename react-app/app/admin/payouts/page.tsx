'use client';

/**
 * Admin Commission Payouts — D-211 Phase 10. Port of admin-payouts.html
 * → the React /admin/payouts route.
 *
 * Wrapped by <RequireAdmin tier="super"> + <AdminNav active="payouts">.
 * The static page's CONFIG guard, createClient call, magic-link hash handler,
 * and single-hardcoded-email gate (dustinstohler1@gmail.com) are all replaced
 * by the shared auth shell (AuthProvider + RequireAdmin — edge-gate-consistent
 * parity choice; deliberate, do NOT re-check email in this page).
 *
 * §6.1 XSS fold: the static renderTable() built HTML strings and interpolated
 * partner/trigger-controlled values into onclick="…('${…}')" handlers and
 * cell innerHTML. This port renders every DB/user value (partner_name,
 * trigger_event, amounts, status, notes) as JSX text (React-escaped) and wires
 * every action as an onClick closure over the row object — zero innerHTML /
 * dangerouslySetInnerHTML / string-built handlers.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { RequireAdmin } from '../_shell/RequireAdmin';
import { AdminNav } from '../_shell/AdminNav';
import { FilterTabs } from '../_shell/FilterTabs';
import {
  type PayoutApproval,
  type PayoutFilter,
  PAYOUT_FILTERS,
  filterPayouts,
  summaryCards,
  formatMoneyWhole,
  formatMoneyCents,
  formatPayoutDate,
  autoApproveLabel,
  payoutTypeLabel,
  triggerText,
  statusBadge,
  isRejectReasonValid,
  approvePayload,
  rejectPayload,
} from './utils';

export default function AdminPayoutsPage() {
  return (
    <RequireAdmin tier="super">
      <AdminPayoutsContent />
    </RequireAdmin>
  );
}

function AdminPayoutsContent() {
  const { signOut } = useAuth();
  const router = useRouter();

  const [payouts, setPayouts] = useState<PayoutApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<PayoutFilter>('all');
  const [approvingIds, setApprovingIds] = useState<Set<string>>(new Set());
  const [rejectTarget, setRejectTarget] = useState<PayoutApproval | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);

  // ── Loader ──────────────────────────────────────────────────────────────────

  async function loadPayouts() {
    const { data, error } = await supabase
      .from('payout_approvals')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading payouts:', error);
      setLoadError('Error loading payouts — check console.');
    } else {
      setPayouts((data || []) as PayoutApproval[]);
    }
    setLoading(false);
  }

  useEffect(() => {
    void loadPayouts();
    // RequireAdmin only mounts once auth is settled + authorized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────

  const cards = summaryCards(payouts);
  const filtered = filterPayouts(payouts, filter);

  // ── Optimistic patch ─────────────────────────────────────────────────────────

  function patchPayout(id: string, patch: Partial<PayoutApproval>) {
    setPayouts((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  // ── Approve ──────────────────────────────────────────────────────────────────

  async function handleApprove(row: PayoutApproval) {
    setApprovingIds((prev) => new Set(prev).add(row.id));
    try {
      const { data, error } = await supabase.functions.invoke('approve-payout', {
        body: approvePayload(row.id),
      });
      if (error) throw error;
      if (!data || data.ok !== true) {
        const message = (data && (data.error as string)) || 'Approval failed';
        window.alert('Approval failed: ' + message);
        setApprovingIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
        return;
      }
      patchPayout(row.id, { status: 'approved', approved_at: new Date().toISOString() });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'error';
      console.error('Approve error:', err);
      window.alert('Approval failed: ' + message);
    }
    setApprovingIds((prev) => {
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });
  }

  // ── Reject modal ─────────────────────────────────────────────────────────────

  function openReject(row: PayoutApproval) {
    setRejectTarget(row);
    setRejectReason('');
  }

  function closeReject() {
    setRejectTarget(null);
    setRejectReason('');
    setRejectSubmitting(false);
  }

  async function submitReject() {
    if (!isRejectReasonValid(rejectReason) || !rejectTarget) return;
    setRejectSubmitting(true);
    const reason = rejectReason.trim();
    try {
      const { data, error } = await supabase.functions.invoke('reject-payout', {
        body: rejectPayload(rejectTarget.id, reason),
      });
      if (error) throw error;
      if (!data || data.ok !== true) {
        const message = (data && (data.error as string)) || 'Rejection failed';
        window.alert('Rejection failed: ' + message);
        setRejectSubmitting(false);
        return;
      }
      patchPayout(rejectTarget.id, {
        status: 'rejected',
        rejected_at: new Date().toISOString(),
        rejection_reason: reason,
      });
      closeReject();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'error';
      console.error('Reject error:', err);
      window.alert('Rejection failed: ' + message);
      setRejectSubmitting(false);
    }
  }

  // ── Logout ───────────────────────────────────────────────────────────────────

  async function handleLogout() {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <main className="oqpa-main">
      <style>{STYLES}</style>

      {/* Header */}
      <div className="oqpa-header">
        <div className="oqpa-title">
          <span className="oqpa-badge">ADMIN</span>
          <h1 className="oqpa-h1">Referral Fee Payouts</h1>
        </div>
        <button type="button" className="oqpa-logout" onClick={handleLogout}>
          Log Out
        </button>
      </div>

      {/* Admin nav */}
      <div className="oqpa-nav-wrap">
        <AdminNav active="payouts" />
      </div>

      {/* Load error */}
      {loadError !== null && (
        <div className="oqpa-error">{loadError}</div>
      )}

      {/* Summary cards */}
      <div className="summary-cards">
        <div className="summary-card pending">
          <div className="summary-card-label">Pending Approval</div>
          <div className="summary-card-value">{cards.pendingCount}</div>
          <div className="summary-card-sub">{formatMoneyWhole(cards.pendingAmount) + ' pending'}</div>
        </div>
        <div className="summary-card approved">
          <div className="summary-card-label">Approved This Month</div>
          <div className="summary-card-value">{cards.approvedCount}</div>
          <div className="summary-card-sub">{formatMoneyWhole(cards.approvedAmount) + ' this month'}</div>
        </div>
        <div className="summary-card approved">
          <div className="summary-card-label">Auto-Approved This Month</div>
          <div className="summary-card-value">{cards.autoCount}</div>
          <div className="summary-card-sub">{formatMoneyWhole(cards.autoAmount) + ' this month'}</div>
        </div>
        <div className="summary-card rejected">
          <div className="summary-card-label">Rejected</div>
          <div className="summary-card-value">{cards.rejectedCount}</div>
          <div className="summary-card-sub">all time</div>
        </div>
      </div>

      {/* Filter tabs */}
      <FilterTabs
        tabs={PAYOUT_FILTERS}
        active={filter}
        onChange={(key) => setFilter(key as PayoutFilter)}
      />

      {/* Table */}
      <div className="table-wrapper">
        {loading ? (
          <div className="loading-spinner">Loading payouts…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No payouts found for this filter.</div>
        ) : (
          <table className="payout-table">
            <thead>
              <tr>
                <th>Partner</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Trigger</th>
                <th>Created</th>
                <th>Auto-Approves</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <PayoutRow
                  key={p.id}
                  payout={p}
                  approving={approvingIds.has(p.id)}
                  onApprove={handleApprove}
                  onReject={openReject}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Reject modal */}
      {rejectTarget !== null && (
        <div className="oqpa-modal-overlay">
          <div className="oqpa-modal">
            <div className="oqpa-modal-title">Reject Payout</div>
            {rejectTarget.partner_name && (
              <div className="oqpa-modal-partner">{rejectTarget.partner_name}</div>
            )}
            <textarea
              className="oqpa-modal-textarea"
              placeholder="Rejection reason (required)…"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <div className="oqpa-modal-buttons">
              <button
                type="button"
                className="oqpa-modal-btn oqpa-modal-btn-secondary"
                onClick={closeReject}
                disabled={rejectSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="oqpa-modal-btn oqpa-modal-btn-primary"
                onClick={submitReject}
                disabled={!isRejectReasonValid(rejectReason) || rejectSubmitting}
              >
                Confirm Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ── PayoutRow sub-component ───────────────────────────────────────────────────

function PayoutRow({
  payout,
  approving,
  onApprove,
  onReject,
}: {
  payout: PayoutApproval;
  approving: boolean;
  onApprove: (row: PayoutApproval) => void;
  onReject: (row: PayoutApproval) => void;
}) {
  const badge = statusBadge(payout.status);

  return (
    <tr>
      {/* 1 Partner + trigger sub-line */}
      <td>
        <div className="partner-name">{payout.partner_name || '—'}</div>
        <div className="trigger-text">{triggerText(payout.trigger_event)}</div>
      </td>

      {/* 2 Type */}
      <td>{payoutTypeLabel(payout.payout_type)}</td>

      {/* 3 Amount */}
      <td className="amount-cell">{formatMoneyCents(payout.amount)}</td>

      {/* 4 Trigger column (static page repeats trigger in both partner sub-line and this column) */}
      <td className="oqpa-trigger-col">{triggerText(payout.trigger_event)}</td>

      {/* 5 Created */}
      <td>{formatPayoutDate(payout.created_at)}</td>

      {/* 6 Auto-Approves */}
      <td>{autoApproveLabel(payout.auto_approve_at)}</td>

      {/* 7 Status badge */}
      <td>
        <span className={`badge ${badge.className}`}>{badge.label}</span>
      </td>

      {/* 8 Actions */}
      <td>
        {payout.status === 'pending_approval' ? (
          <>
            <button
              type="button"
              className="action-btn btn-approve"
              disabled={approving}
              onClick={() => onApprove(payout)}
            >
              {approving ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="action-btn btn-reject"
              onClick={() => onReject(payout)}
            >
              Reject
            </button>
          </>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

// ── Styles (ported from admin-payouts.html inline CSS) ───────────────────────

const STYLES = `
  :root {
    --navy:  #0D1B2E;
    --amber: #E07B00;
    --white: #FFFFFF;
    --slate: #94A3B8;
    --light: #E2E8F0;
    --red:   #EF4444;
    --green: #10B981;
  }

  .oqpa-main {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
    color: #1F2937;
    font-family: 'Rubik', sans-serif;
  }

  /* ── Header ──────────────────────────────────────────── */
  .oqpa-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 2rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .oqpa-title {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .oqpa-badge {
    background: var(--amber, #E07B00);
    color: var(--navy, #0D1B2E);
    padding: 0.4rem 0.8rem;
    border-radius: 0.5rem;
    font-weight: 700;
    font-size: 0.875rem;
  }
  .oqpa-h1 {
    font-size: 2.5rem;
    color: var(--white, #FFFFFF);
    margin: 0;
    font-family: 'Rubik', sans-serif;
  }
  .oqpa-logout {
    background: var(--white, #FFFFFF);
    color: var(--navy, #0D1B2E);
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    font-family: 'Rubik', sans-serif;
  }
  .oqpa-logout:hover { background: var(--light, #E2E8F0); }
  .oqpa-nav-wrap { margin-bottom: 2rem; }

  /* ── Error ───────────────────────────────────────────── */
  .oqpa-error {
    background: #FEE2E2;
    color: #991B1B;
    padding: 1rem 1.5rem;
    border-radius: 0.75rem;
    margin-bottom: 1.5rem;
    font-weight: 500;
  }

  /* ── Summary cards ───────────────────────────────────── */
  .summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
  }
  .summary-card {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    padding: 1.5rem;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  .summary-card-label {
    font-size: 0.8rem;
    color: var(--slate, #94A3B8);
    margin-bottom: 0.4rem;
    font-weight: 500;
  }
  .summary-card-value {
    font-size: 2rem;
    font-weight: 700;
    color: var(--navy, #0D1B2E);
  }
  .summary-card-sub {
    font-size: 0.8rem;
    color: var(--slate, #94A3B8);
    margin-top: 0.25rem;
  }
  .summary-card.pending  .summary-card-value { color: #D97706; }
  .summary-card.approved .summary-card-value { color: var(--green, #10B981); }
  .summary-card.rejected .summary-card-value { color: var(--red, #EF4444); }

  /* ── Filter tabs ─────────────────────────────────────── */
  .filter-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }
  .filter-tab {
    background: rgba(255,255,255,0.08);
    color: var(--slate, #94A3B8);
    border: none;
    padding: 0.6rem 1.2rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    font-family: 'Rubik', sans-serif;
    transition: all 0.2s;
  }
  .filter-tab:hover  { background: rgba(255,255,255,0.12); color: var(--white, #FFFFFF); }
  .filter-tab.active { background: var(--amber, #E07B00); color: var(--navy, #0D1B2E); }

  /* ── Table ───────────────────────────────────────────── */
  .table-wrapper {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  .payout-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .payout-table thead {
    background: #F8FAFC;
  }
  .payout-table th {
    padding: 0.875rem 1rem;
    text-align: left;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--slate, #94A3B8);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--light, #E2E8F0);
  }
  .payout-table td {
    padding: 0.875rem 1rem;
    border-bottom: 1px solid #F1F5F9;
    color: #374151;
    vertical-align: top;
  }
  .payout-table tbody tr:last-child td { border-bottom: none; }
  .payout-table tbody tr:hover { background: #FAFAFA; }

  /* ── Status badges ───────────────────────────────────── */
  .badge {
    display: inline-block;
    padding: 0.25rem 0.6rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .badge-pending  { background: #FEF3C7; color: #92400E; }
  .badge-approved { background: #D1FAE5; color: #065F46; }
  .badge-auto     { background: #DBEAFE; color: #1E40AF; }
  .badge-rejected { background: #FEE2E2; color: #991B1B; }
  .badge-pre      { background: #F3F4F6; color: #6B7280; }

  /* ── Action buttons ──────────────────────────────────── */
  .action-btn {
    border: none;
    padding: 0.4rem 0.875rem;
    border-radius: 0.4rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    font-family: 'Rubik', sans-serif;
    transition: all 0.2s;
  }
  .btn-approve {
    background: #D1FAE5;
    color: #065F46;
    margin-right: 0.4rem;
  }
  .btn-approve:hover:not(:disabled) { background: #A7F3D0; }
  .btn-reject  { background: #FEE2E2; color: #991B1B; }
  .btn-reject:hover:not(:disabled)  { background: #FECACA; }
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Empty / loading ─────────────────────────────────── */
  .empty-state {
    text-align: center;
    padding: 3rem 1.5rem;
    color: var(--slate, #94A3B8);
  }
  .loading-spinner {
    text-align: center;
    padding: 2rem;
    color: var(--slate, #94A3B8);
  }

  /* ── Partner / trigger / amount cells ───────────────── */
  .partner-name  { font-weight: 600; color: var(--navy, #0D1B2E); }
  .trigger-text  { font-size: 0.75rem; color: var(--slate, #94A3B8); margin-top: 2px; }
  .amount-cell   { font-weight: 700; color: var(--navy, #0D1B2E); }
  .oqpa-trigger-col { font-size: 0.8rem; color: #64748B; }

  /* ── Reject modal ────────────────────────────────────── */
  .oqpa-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .oqpa-modal {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    padding: 2rem;
    min-width: 380px;
    max-width: 480px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  }
  .oqpa-modal-title {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--navy, #0D1B2E);
    margin-bottom: 1rem;
  }
  .oqpa-modal-partner {
    font-weight: 600;
    color: #374151;
    margin-bottom: 0.75rem;
    font-size: 0.9rem;
  }
  .oqpa-modal-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--light, #E2E8F0);
    border-radius: 0.4rem;
    font-size: 0.875rem;
    font-family: 'Rubik', sans-serif;
    resize: vertical;
    min-height: 80px;
    margin-bottom: 1rem;
  }
  .oqpa-modal-textarea:focus { outline: 2px solid var(--amber, #E07B00); border-color: transparent; }
  .oqpa-modal-buttons {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }
  .oqpa-modal-btn {
    padding: 0.6rem 1.25rem;
    border: none;
    border-radius: 0.4rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    font-family: 'Rubik', sans-serif;
    transition: all 0.2s;
  }
  .oqpa-modal-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .oqpa-modal-btn-secondary {
    background: #F1F5F9;
    color: #374151;
  }
  .oqpa-modal-btn-secondary:hover:not(:disabled) { background: var(--light, #E2E8F0); }
  .oqpa-modal-btn-primary {
    background: var(--red, #EF4444);
    color: var(--white, #FFFFFF);
  }
  .oqpa-modal-btn-primary:hover:not(:disabled) { background: #DC2626; }

  @media (max-width: 768px) {
    .oqpa-header { flex-direction: column; align-items: flex-start; }
    .oqpa-h1 { font-size: 1.75rem; }
    .payout-table th:nth-child(5),
    .payout-table td:nth-child(5),
    .payout-table th:nth-child(6),
    .payout-table td:nth-child(6) { display: none; }
  }
`;
