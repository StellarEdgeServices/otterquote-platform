'use client';

/**
 * Admin Warranty Manifest Drift — D-211 Phase 10. Port of admin-warranty-drift.html
 * → the React /admin/warranty-drift route.
 *
 * Wrapped by <RequireAdmin tier="reviewer"> + <AdminNav active="warranty-drift">.
 * The static page's top-level `return` (SyntaxError guard on !sb), CONFIG.SUPABASE_ANON_KEY
 * guard, createClient call, and any hardcoded key are all replaced by the supabase
 * singleton + auth shell (AuthProvider + RequireAdmin — fixed by construction).
 *
 * §6.1 XSS fold: the static buildDriftRow() built HTML strings and interpolated
 * manufacturer/tier/reviewed_by/rejection_reason values into onclick="…('${…}')"
 * handlers and cell innerHTML. This port renders every DB/user value as JSX text
 * (React-escaped) and wires every action as an onClick closure over the row object
 * — zero innerHTML / dangerouslySetInnerHTML / string-built handlers.
 *
 * KNOWN BACKEND DEFECTS (called UNCHANGED; not fixed here):
 *   (1) warranty_manifest_drift "Admin read" RLS subqueries auth.users → "permission
 *       denied for table users" for authenticated client reads. Root cause:
 *       sql/v69_d202_warranty_manifest_drift.sql:60 — SELECT policy subquery joins
 *       auth.users directly; fixed separately in sql/v70.
 *   (2) approve-warranty-drift and reject-warranty-drift Edge Functions set
 *       Access-Control-Allow-Origin only on OPTIONS preflight responses, not on
 *       POST responses — CORS-blocks POST calls from the browser. Root cause:
 *       approve-warranty-drift/index.ts:30, reject-warranty-drift/index.ts:21.
 *       EF POST responses are CORS-blocked; fixed separately in those EFs.
 *
 * Both defects produce graceful error/empty states in this page (no crash).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { RequireAdmin } from '../_shell/RequireAdmin';
import { AdminNav } from '../_shell/AdminNav';
import { FilterTabs } from '../_shell/FilterTabs';
import {
  type DriftRow,
  type DriftFilter,
  type CronHealthRow,
  type WarrantyEfPayload,
  DRIFT_FILTERS,
  changeTypeBadgeClass,
  changeTypeLabel,
  statusBadgeClass,
  statusLabel,
  formatDate,
  lastRunLabel,
  runStatusColor,
  runIdShort,
  itemsDetectedLabel,
  isSafeHttpUrl,
  buildDiff,
  isRejectReasonValid,
  isApproveEditSkip,
  approvePayload,
  approveWithChangesPayload,
  rejectPayload,
  skipPayload,
} from './utils';

// ── EF caller helper ──────────────────────────────────────────────────────────

async function callEf(
  fn: string,
  body: WarrantyEfPayload,
): Promise<{ error: string | null }> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) return { error: error.message };
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    return { error: String((data as { error: unknown }).error) };
  }
  return { error: null };
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function AdminWarrantyDriftPage() {
  return (
    <RequireAdmin tier="reviewer">
      <AdminWarrantyDriftContent />
    </RequireAdmin>
  );
}

// ── State types ───────────────────────────────────────────────────────────────

interface DriftCounts {
  pending: number;
  applied: number;
  rejected: number;
  skipped: number;
}

interface RejectModalState {
  target: string | null; // drift_id
  reason: string;
}

interface ApproveEditTarget {
  driftId: string;
  optionId: string | null;
  manufacturer: string;
  tier: string;
}

interface ApproveEditModalState {
  target: ApproveEditTarget | null;
  displayString: string;
  programName: string;
}

// ── Content component ─────────────────────────────────────────────────────────

function AdminWarrantyDriftContent() {
  const { signOut } = useAuth();
  const router = useRouter();

  // Summary state — null until loaded, then numbers
  const [counts, setCounts] = useState<DriftCounts | null>(null);
  const [lastRun, setLastRun] = useState<string>('—');

  // Run history
  const [runHistory, setRunHistory] = useState<CronHealthRow[] | null>(null);
  const [runHistoryLoading, setRunHistoryLoading] = useState(true);

  // Drift table
  const [driftRows, setDriftRows] = useState<DriftRow[]>([]);
  const [driftLoading, setDriftLoading] = useState(true);
  const [driftError, setDriftError] = useState<string | null>(null);

  // Filter
  const [filter, setFilter] = useState<DriftFilter>('pending_review');

  // Busy approve/skip button ids
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  // Reject modal
  const [rejectModal, setRejectModal] = useState<RejectModalState>({
    target: null,
    reason: '',
  });

  // Approve-edit modal
  const [approveEditModal, setApproveEditModal] =
    useState<ApproveEditModalState>({
      target: null,
      displayString: '',
      programName: '',
    });

  // ── Loaders ────────────────────────────────────────────────────────────────

  async function loadSummary() {
    const statuses = ['pending_review', 'applied', 'rejected', 'skipped'] as const;
    const results = await Promise.all(
      statuses.map((st) =>
        supabase
          .from('warranty_manifest_drift')
          .select('id', { count: 'exact', head: true })
          .eq('status', st),
      ),
    );
    const [pendingRes, appliedRes, rejectedRes, skippedRes] = results;
    setCounts({
      pending: pendingRes.count ?? 0,
      applied: appliedRes.count ?? 0,
      rejected: rejectedRes.count ?? 0,
      skipped: skippedRes.count ?? 0,
    });

    const cronRes = await supabase
      .from('cron_health')
      .select('ran_at')
      .eq('job_name', 'warranty-manifest-refresh')
      .eq('status', 'success')
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setLastRun(lastRunLabel(cronRes.data?.ran_at));
  }

  async function loadRunHistory() {
    setRunHistoryLoading(true);
    const { data } = await supabase
      .from('cron_health')
      .select('ran_at, status, metadata')
      .eq('job_name', 'warranty-manifest-refresh')
      .order('ran_at', { ascending: false })
      .limit(4);
    setRunHistory((data as CronHealthRow[]) || []);
    setRunHistoryLoading(false);
  }

  async function loadDrift() {
    setDriftLoading(true);
    setDriftError(null);

    let query = supabase
      .from('warranty_manifest_drift')
      .select('*')
      .order('detected_at', { ascending: false });
    if (filter !== 'all') {
      query = query.eq('status', filter);
    }

    const { data, error } = await query;

    if (error) {
      setDriftError('Error loading data: ' + error.message);
      setDriftRows([]);
    } else {
      setDriftRows((data || []) as DriftRow[]);
    }
    setDriftLoading(false);
  }

  async function reload() {
    await loadSummary();
    await loadDrift();
  }

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    void loadSummary();
    void loadRunHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadDrift();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // ── Actions ────────────────────────────────────────────────────────────────

  async function approveDrift(driftId: string) {
    setBusyIds((prev) => new Set(prev).add(driftId));
    const { error } = await callEf('approve-warranty-drift', approvePayload(driftId));
    if (error) {
      window.alert('Error: ' + error);
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(driftId);
        return next;
      });
      return;
    }
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(driftId);
      return next;
    });
    await reload();
  }

  async function skipDrift(driftId: string) {
    if (
      !window.confirm(
        "Confirm: you have manually checked this manufacturer's warranty page and no changes are needed?",
      )
    ) {
      return;
    }
    const { error } = await callEf('reject-warranty-drift', skipPayload(driftId));
    if (error) {
      window.alert('Error: ' + error);
      return;
    }
    await reload();
  }

  function openRejectModal(driftId: string) {
    setRejectModal({ target: driftId, reason: '' });
  }

  function closeRejectModal() {
    setRejectModal({ target: null, reason: '' });
  }

  async function confirmReject() {
    if (!rejectModal.target) return;
    if (!isRejectReasonValid(rejectModal.reason)) {
      window.alert('Please enter a rejection reason.');
      return;
    }
    const { error } = await callEf(
      'reject-warranty-drift',
      rejectPayload(rejectModal.target, rejectModal.reason.trim()),
    );
    if (error) {
      window.alert('Error: ' + error);
      return;
    }
    closeRejectModal();
    await reload();
  }

  function openApproveEditModal(
    driftId: string,
    optionId: string | null,
    manufacturer: string,
    tier: string,
  ) {
    setApproveEditModal({
      target: { driftId, optionId, manufacturer, tier },
      displayString: '',
      programName: '',
    });
  }

  function closeApproveEditModal() {
    setApproveEditModal({ target: null, displayString: '', programName: '' });
  }

  async function confirmApproveEdit() {
    if (!approveEditModal.target) return;
    const { driftId } = approveEditModal.target;
    const { displayString, programName } = approveEditModal;

    let efResult: { error: string | null };
    if (isApproveEditSkip(displayString, programName)) {
      efResult = await callEf('reject-warranty-drift', skipPayload(driftId));
    } else {
      efResult = await callEf(
        'approve-warranty-drift',
        approveWithChangesPayload(driftId, displayString, programName),
      );
    }

    if (efResult.error) {
      window.alert('Error: ' + efResult.error);
      return;
    }
    closeApproveEditModal();
    await reload();
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  async function handleLogout() {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="oqwd-main">
      <style>{STYLES}</style>

      {/* Header */}
      <div className="oqwd-header">
        <div className="oqwd-title">
          <span className="oqwd-badge">ADMIN</span>
          <h1 className="oqwd-h1">Warranty Manifest Drift</h1>
        </div>
        <button type="button" className="oqwd-logout" onClick={handleLogout}>
          Sign Out
        </button>
      </div>

      {/* Admin nav */}
      <div className="oqwd-nav-wrap">
        <AdminNav active="warranty-drift" />
      </div>

      {/* Info banner */}
      <div className="info-banner">
        📋 <strong>Admin-gated change control.</strong> No changes are applied to
        the warranty manifest until you approve them here. Quarterly refresh runs
        Jan 1 / Apr 1 / Jul 1 / Oct 1.
      </div>

      {/* Summary cards */}
      <div className="summary-cards">
        <div className="summary-card">
          <div className="summary-card-label">Pending Review</div>
          <div className="summary-card-value">
            {counts === null ? '—' : counts.pending}
          </div>
        </div>
        <div className="summary-card">
          <div className="summary-card-label">Applied (All Time)</div>
          <div className="summary-card-value">
            {counts === null ? '—' : counts.applied}
          </div>
        </div>
        <div className="summary-card">
          <div className="summary-card-label">Rejected</div>
          <div className="summary-card-value">
            {counts === null ? '—' : counts.rejected}
          </div>
        </div>
        <div className="summary-card">
          <div className="summary-card-label">Skipped</div>
          <div className="summary-card-value">
            {counts === null ? '—' : counts.skipped}
          </div>
        </div>
        <div className="summary-card">
          <div className="summary-card-label">Last Run</div>
          <div className="summary-card-value summary-card-value-sm">{lastRun}</div>
        </div>
      </div>

      {/* Run history */}
      <details className="run-history">
        <summary>Run history (last 4 cycles)</summary>
        <div style={{ marginTop: '0.75rem' }}>
          {runHistoryLoading ? (
            <div className="loading">Loading…</div>
          ) : !runHistory || runHistory.length === 0 ? (
            <p className="oqwd-run-empty">No runs recorded yet.</p>
          ) : (
            runHistory.map((r, i) => {
              const meta = r.metadata || {};
              return (
                <div key={i} className="run-row">
                  <span style={{ color: runStatusColor(r.status), fontWeight: 600 }}>
                    {r.status}
                  </span>
                  <span>{formatDate(r.ran_at)}</span>
                  {runIdShort(meta) ? (
                    <span className="run-id">{runIdShort(meta)}</span>
                  ) : null}
                  {itemsDetectedLabel(meta) ? (
                    <span>{itemsDetectedLabel(meta)}</span>
                  ) : null}
                  {meta.error ? (
                    <span style={{ color: '#EF4444' }}>{meta.error}</span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </details>

      {/* Filter tabs */}
      <FilterTabs
        tabs={DRIFT_FILTERS}
        active={filter}
        onChange={(k) => setFilter(k as DriftFilter)}
      />

      {/* Drift table */}
      <div className="table-wrapper">
        <table className="drift-table">
          <thead>
            <tr>
              <th>Manufacturer / Tier</th>
              <th>Change Type</th>
              <th>Detected</th>
              <th>Current → Proposed</th>
              <th>Source</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {driftLoading ? (
              <tr>
                <td colSpan={7} className="loading">
                  Loading…
                </td>
              </tr>
            ) : driftError !== null ? (
              <tr>
                <td colSpan={7} className="oqwd-error-cell">
                  {driftError}
                </td>
              </tr>
            ) : driftRows.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">
                    <div className="empty-state-icon">✅</div>
                    <h3>No items in this view</h3>
                    <p>
                      Warranty manifest is current, or no refresh has run yet.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              driftRows.map((row) => (
                <DriftTableRow
                  key={row.id}
                  row={row}
                  busy={busyIds.has(row.id)}
                  onApprove={approveDrift}
                  onSkip={skipDrift}
                  onOpenReject={openRejectModal}
                  onOpenApproveEdit={openApproveEditModal}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Reject modal */}
      {rejectModal.target !== null && (
        <div
          className="oqwd-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeRejectModal();
          }}
        >
          <div className="oqwd-modal-box">
            <h3>Reject Drift Item</h3>
            <label htmlFor="oqwd-reject-reason">Reason (required)</label>
            <textarea
              id="oqwd-reject-reason"
              placeholder="e.g. Manufacturer confirmed no program changes this quarter"
              value={rejectModal.reason}
              onChange={(e) =>
                setRejectModal((prev) => ({ ...prev, reason: e.target.value }))
              }
            />
            <div className="oqwd-modal-actions">
              <button
                type="button"
                className="oqwd-modal-cancel"
                onClick={closeRejectModal}
              >
                Cancel
              </button>
              <button
                type="button"
                className="oqwd-modal-confirm"
                onClick={confirmReject}
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Approve-edit modal */}
      {approveEditModal.target !== null && (
        <div
          className="oqwd-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeApproveEditModal();
          }}
        >
          <div className="oqwd-modal-box">
            <h3>Approve with Changes</h3>
            <p className="oqwd-modal-sub">
              Enter the updated display_string and program_name for this
              warranty tier. Leave blank to skip (no changes needed).
            </p>
            <label>Manufacturer / Tier</label>
            <input
              type="text"
              readOnly
              style={{ background: '#F8FAFC' }}
              value={`${approveEditModal.target.manufacturer} — ${approveEditModal.target.tier}`}
            />
            <label>New Display String</label>
            <input
              type="text"
              placeholder="e.g. GAF Golden Pledge® Lifetime (2025)"
              value={approveEditModal.displayString}
              onChange={(e) =>
                setApproveEditModal((prev) => ({
                  ...prev,
                  displayString: e.target.value,
                }))
              }
            />
            <label>New Program Name</label>
            <input
              type="text"
              placeholder="e.g. Golden Pledge® Lifetime"
              value={approveEditModal.programName}
              onChange={(e) =>
                setApproveEditModal((prev) => ({
                  ...prev,
                  programName: e.target.value,
                }))
              }
            />
            <div className="oqwd-modal-actions">
              <button
                type="button"
                className="oqwd-modal-cancel"
                onClick={closeApproveEditModal}
              >
                Cancel
              </button>
              <button
                type="button"
                className="oqwd-modal-confirm oqwd-modal-confirm-green"
                onClick={confirmApproveEdit}
              >
                Apply Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ── DriftTableRow sub-component ───────────────────────────────────────────────

function DriftTableRow({
  row,
  busy,
  onApprove,
  onSkip,
  onOpenReject,
  onOpenApproveEdit,
}: {
  row: DriftRow;
  busy: boolean;
  onApprove: (driftId: string) => void;
  onSkip: (driftId: string) => void;
  onOpenReject: (driftId: string) => void;
  onOpenApproveEdit: (
    driftId: string,
    optionId: string | null,
    manufacturer: string,
    tier: string,
  ) => void;
}) {
  const diff = buildDiff(row);

  return (
    <tr>
      {/* Manufacturer / Tier */}
      <td>
        <strong>{row.manufacturer}</strong>
        <br />
        <span className="oqwd-tier-label">{row.tier}</span>
      </td>

      {/* Change type */}
      <td>
        <span className={`badge ${changeTypeBadgeClass(row.change_type)}`}>
          {changeTypeLabel(row.change_type)}
        </span>
      </td>

      {/* Detected */}
      <td className="oqwd-date-cell">{formatDate(row.detected_at)}</td>

      {/* Current → Proposed diff */}
      <td>
        {diff.kind === 'no_source' && (
          <>
            <span className="oqwd-diff-label">
              Manual check required.
              <br />
              Current tiers in manifest:
            </span>
            {diff.tiers.length > 0 && (
              <ul className="tier-list">
                {diff.tiers.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {diff.kind === 'deprecated' && (
          <div className="diff-box">
            <div className="diff-current">{diff.current}</div>
            <span className="oqwd-deprecated-label">
              Deprecated (not found on source page)
            </span>
          </div>
        )}
        {diff.kind === 'modified' && (
          <div className="diff-box">
            <div className="diff-current">{diff.current}</div>
            <div className="diff-proposed">→ {diff.proposed}</div>
          </div>
        )}
        {diff.kind === 'added' && (
          <div className="diff-box">
            <div className="diff-proposed">New: {diff.proposed}</div>
          </div>
        )}
        {diff.kind === 'none' && (
          <span className="oqwd-none-label">—</span>
        )}
      </td>

      {/* Source */}
      <td>
        {isSafeHttpUrl(row.source_url) ? (
          /* URL guard: only http/https links become clickable — §6.1 XSS */
          <a
            href={row.source_url!}
            target="_blank"
            rel="noopener"
            className="source-link"
          >
            Open Warranty Page ↗
          </a>
        ) : row.source_url ? (
          /* Unsafe/non-http URL rendered as plain text, not a link */
          <span className="oqwd-source-plain">{row.source_url}</span>
        ) : (
          <span className="oqwd-source-none">No URL</span>
        )}
      </td>

      {/* Status */}
      <td>
        <span className={`badge ${statusBadgeClass(row.status)}`}>
          {statusLabel(row.status)}
        </span>
        {row.rejection_reason && (
          <div className="oqwd-rejection-reason">{row.rejection_reason}</div>
        )}
      </td>

      {/* Actions */}
      <td>
        {row.status === 'pending_review' ? (
          <div className="action-btns">
            {row.change_type === 'no_source' ? (
              <>
                <button
                  type="button"
                  className="btn btn-approve"
                  onClick={() =>
                    onOpenApproveEdit(
                      row.id,
                      row.warranty_option_id ?? null,
                      row.manufacturer,
                      row.tier,
                    )
                  }
                >
                  Approve w/ Changes
                </button>
                <button
                  type="button"
                  className="btn btn-skip"
                  onClick={() => onSkip(row.id)}
                >
                  Skip — No Changes
                </button>
                <button
                  type="button"
                  className="btn btn-reject"
                  onClick={() => onOpenReject(row.id)}
                >
                  Reject
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-approve"
                  disabled={busy}
                  onClick={() => onApprove(row.id)}
                >
                  {busy ? 'Applying…' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="btn btn-reject"
                  onClick={() => onOpenReject(row.id)}
                >
                  Reject
                </button>
              </>
            )}
          </div>
        ) : (
          <span className="oqwd-reviewer">
            {row.reviewed_by ? row.reviewed_by.split('@')[0] : ''}
            {row.reviewed_at ? (
              <>
                <br />
                {formatDate(row.reviewed_at)}
              </>
            ) : null}
          </span>
        )}
      </td>
    </tr>
  );
}

// ── Styles (ported from admin-warranty-drift.html inline CSS) ─────────────────

const STYLES = `
  :root {
    --navy:  #0D1B2E;
    --amber: #E07B00;
    --white: #FFFFFF;
    --slate: #94A3B8;
    --light: #E2E8F0;
    --red:   #EF4444;
    --green: #10B981;
    --teal:  #14B8A6;
  }

  .oqwd-main {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
    color: #1F2937;
    font-family: 'Rubik', sans-serif;
  }

  /* ── Header ──────────────────────────────────────────── */
  .oqwd-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 2rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .oqwd-title {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .oqwd-badge {
    background: var(--amber, #E07B00);
    color: var(--navy, #0D1B2E);
    padding: 0.4rem 0.8rem;
    border-radius: 0.5rem;
    font-weight: 700;
    font-size: 0.875rem;
  }
  .oqwd-h1 {
    font-size: 2.5rem;
    color: var(--white, #FFFFFF);
    margin: 0;
    font-family: 'Rubik', sans-serif;
  }
  .oqwd-logout {
    background: var(--white, #FFFFFF);
    color: var(--navy, #0D1B2E);
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    font-family: 'Rubik', sans-serif;
  }
  .oqwd-logout:hover { background: var(--light, #E2E8F0); }
  .oqwd-nav-wrap { margin-bottom: 2rem; }

  /* ── Info banner ─────────────────────────────────────── */
  .info-banner {
    background: rgba(20,184,166,0.08);
    border: 1px solid rgba(20,184,166,0.25);
    color: var(--teal, #14B8A6);
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    margin-bottom: 1.5rem;
    font-size: 0.9rem;
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
  .summary-card-value-sm {
    font-size: 1rem;
    margin-top: 0.25rem;
  }

  /* ── Filter tabs ─────────────────────────────────────── */
  .filter-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .filter-tab {
    background: rgba(255,255,255,0.05);
    color: var(--slate, #94A3B8);
    border: 1px solid rgba(255,255,255,0.1);
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    cursor: pointer;
    font-size: 0.9rem;
    font-family: 'Rubik', sans-serif;
  }
  .filter-tab:hover  { background: rgba(255,255,255,0.1); color: var(--white, #FFFFFF); }
  .filter-tab.active { background: var(--amber, #E07B00); color: var(--navy, #0D1B2E); border-color: var(--amber, #E07B00); font-weight: 600; }

  /* ── Table ───────────────────────────────────────────── */
  .table-wrapper {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    margin-bottom: 2rem;
  }
  .drift-table {
    width: 100%;
    border-collapse: collapse;
  }
  .drift-table th {
    background: var(--light, #E2E8F0);
    padding: 0.875rem 1rem;
    text-align: left;
    font-weight: 600;
    color: var(--navy, #0D1B2E);
    font-size: 0.85rem;
  }
  .drift-table td {
    padding: 1rem;
    border-top: 1px solid var(--light, #E2E8F0);
    font-size: 0.9rem;
    vertical-align: top;
  }
  .drift-table tr:hover { background: rgba(0,0,0,0.02); }

  /* ── Badges ──────────────────────────────────────────── */
  .badge {
    display: inline-block;
    padding: 0.25rem 0.65rem;
    border-radius: 1rem;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .badge-no-source  { background: #DBEAFE; color: #1E40AF; }
  .badge-modified   { background: #FEF3C7; color: #92400E; }
  .badge-deprecated { background: #FEE2E2; color: #991B1B; }
  .badge-added      { background: #D1FAE5; color: #065F46; }
  .badge-applied    { background: #D1FAE5; color: #065F46; }
  .badge-rejected   { background: #FCE7F3; color: #9F1239; }
  .badge-skipped    { background: #F1F5F9; color: #475569; }
  .badge-pending    { background: #FEF3C7; color: #92400E; }

  /* ── Source link ─────────────────────────────────────── */
  .source-link { color: var(--amber, #E07B00); font-size: 0.85rem; text-decoration: none; }
  .source-link:hover { text-decoration: underline; }
  .oqwd-source-plain { color: var(--slate, #94A3B8); font-size: 0.85rem; }
  .oqwd-source-none  { color: var(--slate, #94A3B8); font-size: 0.85rem; }

  /* ── Diff display ────────────────────────────────────── */
  .diff-box {
    background: #F8FAFC;
    border: 1px solid var(--light, #E2E8F0);
    border-radius: 0.5rem;
    padding: 0.75rem;
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }
  .diff-current  { color: var(--red, #EF4444); text-decoration: line-through; margin-bottom: 0.25rem; }
  .diff-proposed { color: var(--green, #10B981); }
  .diff-json     { font-family: monospace; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }
  .tier-list     { font-size: 0.8rem; color: #475569; margin-top: 0.4rem; }
  .tier-list li  { margin-bottom: 0.15rem; }
  .oqwd-diff-label { font-size: 0.85rem; color: #4B5563; }
  .oqwd-deprecated-label { font-size: 0.8rem; color: #EF4444; font-weight: 600; }
  .oqwd-none-label { color: var(--slate, #94A3B8); font-size: 0.85rem; }
  .oqwd-tier-label { color: var(--slate, #94A3B8); font-size: 0.85rem; }
  .oqwd-date-cell { font-size: 0.85rem; color: #4B5563; }

  /* ── Action buttons ──────────────────────────────────── */
  .action-btns { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .btn {
    padding: 0.5rem 1rem;
    border-radius: 0.4rem;
    font-size: 0.85rem;
    font-weight: 600;
    border: none;
    cursor: pointer;
    font-family: 'Rubik', sans-serif;
  }
  .btn-approve { background: #10B981; color: #fff; }
  .btn-approve:hover:not(:disabled) { background: #059669; }
  .btn-reject  { background: #EF4444; color: #fff; }
  .btn-reject:hover:not(:disabled)  { background: #DC2626; }
  .btn-skip    { background: var(--light, #E2E8F0); color: var(--navy, #0D1B2E); }
  .btn-skip:hover    { background: #CBD5E1; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Empty / loading / error ─────────────────────────── */
  .empty-state { text-align: center; padding: 3rem 1rem; color: var(--slate, #94A3B8); }
  .empty-state-icon { font-size: 3rem; margin-bottom: 1rem; }
  .empty-state h3 { color: var(--white, #FFFFFF); margin-bottom: 0.5rem; }
  .loading { color: var(--slate, #94A3B8); padding: 2rem; text-align: center; }
  .oqwd-error-cell { color: #EF4444; padding: 1rem; }

  /* ── Status / reviewer display ───────────────────────── */
  .oqwd-rejection-reason { font-size: 0.8rem; color: #6B7280; font-style: italic; margin-top: 0.25rem; }
  .oqwd-reviewer { font-size: 0.8rem; color: var(--slate, #94A3B8); }

  /* ── Run history ─────────────────────────────────────── */
  .run-history {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 0.75rem;
    padding: 1rem 1.5rem;
    margin-bottom: 1.5rem;
  }
  .run-history summary { color: var(--slate, #94A3B8); font-size: 0.9rem; cursor: pointer; }
  .run-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 0;
    border-top: 1px solid rgba(255,255,255,0.06);
    font-size: 0.85rem;
    color: var(--slate, #94A3B8);
    flex-wrap: wrap;
  }
  .run-id { font-family: monospace; font-size: 0.75rem; }
  .oqwd-run-empty { color: var(--slate, #94A3B8); font-size: 0.85rem; margin: 0.5rem 0; }

  /* ── Modal ───────────────────────────────────────────── */
  .oqwd-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .oqwd-modal-box {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    padding: 2rem;
    max-width: 520px;
    width: 100%;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }
  .oqwd-modal-box h3 { margin: 0 0 1rem 0; color: var(--navy, #0D1B2E); font-size: 1.25rem; }
  .oqwd-modal-box label {
    font-size: 0.9rem;
    font-weight: 500;
    color: #374151;
    display: block;
    margin-bottom: 0.4rem;
  }
  .oqwd-modal-box textarea {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--light, #E2E8F0);
    border-radius: 0.5rem;
    font-size: 0.9rem;
    font-family: inherit;
    resize: vertical;
    min-height: 90px;
    box-sizing: border-box;
  }
  .oqwd-modal-box input[type="text"] {
    width: 100%;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--light, #E2E8F0);
    border-radius: 0.5rem;
    font-size: 0.9rem;
    font-family: inherit;
    box-sizing: border-box;
    margin-bottom: 1rem;
    display: block;
  }
  .oqwd-modal-sub {
    font-size: 0.9rem;
    color: #6B7280;
    margin-bottom: 1rem;
  }
  .oqwd-modal-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }
  .oqwd-modal-cancel {
    background: var(--light, #E2E8F0);
    color: var(--navy, #0D1B2E);
    padding: 0.6rem 1.2rem;
    border: none;
    border-radius: 0.4rem;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    font-family: inherit;
  }
  .oqwd-modal-confirm {
    background: var(--red, #EF4444);
    color: #fff;
    padding: 0.6rem 1.2rem;
    border: none;
    border-radius: 0.4rem;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    font-family: inherit;
  }
  .oqwd-modal-confirm-green {
    background: var(--green, #10B981) !important;
  }
  .oqwd-modal-confirm:hover { opacity: 0.9; }
`;
