'use client';

/**
 * Admin Cert Verifications — D-211 Phase 9. Port of admin-cert-verifications.html
 * → the React /admin/cert-verifications route.
 *
 * Wrapped by <RequireAdmin tier="reviewer"> + <AdminNav active="cert-verifications">.
 * The static page's inline CONFIG guard, createClient call, magic-link hash handler,
 * and hardcoded-email gate are all replaced by the shared auth shell
 * (AuthProvider + RequireAdmin — consistent with Phase-8 contractors page).
 *
 * §6.1 XSS fold: the static render() built HTML strings and interpolated
 * contractor/cert-controlled values into onclick="…('${…}')" handlers.
 * This port renders every value as JSX text (React-escaped) and wires every
 * action as an onClick closure over the row object — zero innerHTML /
 * dangerouslySetInnerHTML / string-built handlers.
 *
 * Writes are append-only audit rows (INSERT, not UPDATE). A DB trigger updates
 * cert_status JSONB — this page does NOT reference cert_status.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { RequireAdmin } from '../_shell/RequireAdmin';
import { AdminNav } from '../_shell/AdminNav';
import { FilterTabs } from '../_shell/FilterTabs';
import { SignedDocLink } from '../_shell/doc-viewer';
import {
  type CertVerificationRow,
  type CertFilter,
  CERT_FILTERS,
  rowsForFilter,
  summaryCounts,
  statusLabel,
  isSafeHttpUrl,
  buildApproveInsert,
  buildRejectInsert,
} from './utils';

export default function CertVerificationsPage() {
  return (
    <RequireAdmin tier="reviewer">
      <CertVerificationsContent />
    </RequireAdmin>
  );
}

function CertVerificationsContent() {
  const { user, signOut } = useAuth();
  const router = useRouter();

  const [rows, setRows] = useState<CertVerificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CertFilter>('needs_review');
  const [modeBanner, setModeBanner] = useState<string | null>(null);

  // ── Loaders ──

  async function loadModeBanner() {
    try {
      const { data } = await supabase
        .from('platform_settings')
        .select('value')
        .eq('key', 'D204_HARD_FILTER')
        .maybeSingle();
      const hard = data && data.value === true;
      setModeBanner(
        hard
          ? 'D-204 HARD MODE — Tier dropdowns hide unverified options. Review preconditions before any flag changes.'
          : 'D-204 SOFT MODE — Tier dropdowns log filter intent but do not hide options yet. Forcing review by July 30, 2026.',
      );
    } catch {
      // On error hide the banner entirely (per spec)
      setModeBanner(null);
    }
  }

  async function loadAll() {
    setLoading(true);
    setLoadError(null);

    const { data, error } = await supabase
      .from('contractor_cert_verifications')
      .select(
        'id, contractor_id, manufacturer, cert_name, status, source, source_url, evidence_storage_path, verified_at, expires_at, notes, reviewed_by_admin, created_at, updated_at, contractors!inner(id, company_name)',
      )
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      setLoadError('Load error: ' + error.message);
      setLoading(false);
      return;
    }

    setRows((data || []) as CertVerificationRow[]);
    setLoading(false);
  }

  useEffect(() => {
    void loadModeBanner();
    void loadAll();
    // RequireAdmin only mounts once auth is settled + authorized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived ──
  const counts = summaryCounts(rows);
  const filtered = rowsForFilter(filter, rows);

  // ── Mutations ──

  async function handleApprove(row: CertVerificationRow) {
    if (
      !window.confirm(
        `Approve ${row.manufacturer} ${row.cert_name} for this contractor?`,
      )
    ) {
      return;
    }
    const payload = buildApproveInsert(row, user?.email);
    const { error } = await supabase
      .from('contractor_cert_verifications')
      .insert(payload);
    if (error) {
      window.alert('Approve error: ' + error.message);
      return;
    }
    void loadAll();
  }

  async function handleReject(row: CertVerificationRow) {
    const reason = window.prompt(
      `Reject ${row.manufacturer} ${row.cert_name}? Optional note for the contractor:`,
      '',
    );
    if (reason === null) return; // user cancelled
    const payload = buildRejectInsert(row, user?.email, reason);
    const { error } = await supabase
      .from('contractor_cert_verifications')
      .insert(payload);
    if (error) {
      window.alert('Reject error: ' + error.message);
      return;
    }
    void loadAll();
  }

  // ── Logout (mirrors Phase-8 contractors page: signOut then router.push) ──
  async function handleLogout() {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  }

  return (
    <main className="oqcv-main">
      <style>{STYLES}</style>

      {/* Header */}
      <div className="oqcv-header">
        <div className="oqcv-title">
          <span className="oqcv-badge">ADMIN</span>
          <h1 className="oqcv-h1">Cert Verifications</h1>
        </div>
        <button type="button" className="oqcv-logout" onClick={handleLogout}>
          Log Out
        </button>
      </div>

      {/* Admin nav */}
      <div className="oqcv-nav-wrap">
        <AdminNav active="cert-verifications" />
      </div>

      {/* Mode banner (hidden on error) */}
      {modeBanner !== null && (
        <div className="mode-banner">{modeBanner}</div>
      )}

      {/* Load error */}
      {loadError !== null && (
        <div className="oqcv-error">{loadError}</div>
      )}

      {/* Summary cards */}
      <div className="summary-cards">
        <SummaryCard label="Pending Review (Upload)" value={counts.pending} />
        <SummaryCard label="Scrape Failed" value={counts.scrape_failed} />
        <SummaryCard label="Blocked by robots.txt" value={counts.blocked_by_robots} />
        <SummaryCard label="Verified Active" value={counts.verified} />
      </div>

      {/* Filter tabs */}
      <FilterTabs
        tabs={CERT_FILTERS}
        active={filter}
        onChange={(key) => setFilter(key as CertFilter)}
      />

      {/* Table */}
      <div className="table-wrapper">
        {loading ? (
          <div className="loading-spinner">Loading verifications…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No verifications match this filter.</div>
        ) : (
          <table className="cert-table">
            <thead>
              <tr>
                <th>Contractor</th>
                <th>Manufacturer × Cert</th>
                <th>Source</th>
                <th>Status</th>
                <th>Notes</th>
                <th>Evidence</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <CertRow
                  key={row.id}
                  row={row}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="summary-card">
      <div className="summary-card-label">{label}</div>
      <div className="summary-card-value">{value}</div>
    </div>
  );
}

function CertRow({
  row,
  onApprove,
  onReject,
}: {
  row: CertVerificationRow;
  onApprove: (row: CertVerificationRow) => void;
  onReject: (row: CertVerificationRow) => void;
}) {
  const companyName = row.contractors?.company_name || '(unknown)';
  const created = row.created_at ? new Date(row.created_at).toLocaleString() : '—';

  return (
    <tr>
      {/* 1 Contractor */}
      <td>
        <strong>{companyName}</strong>
        <br />
        <span className="oqcv-muted oqcv-small">
          {row.contractor_id.slice(0, 8)}…
        </span>
      </td>

      {/* 2 Manufacturer × Cert */}
      <td>
        <strong>{row.manufacturer}</strong>
        <br />
        <span style={{ color: '#475569' }}>{row.cert_name}</span>
      </td>

      {/* 3 Source */}
      <td>
        {row.source}
        {row.source_url && (
          <>
            <br />
            {isSafeHttpUrl(row.source_url) ? (
              <a
                href={row.source_url}
                target="_blank"
                rel="noopener"
                className="oqcv-source-link"
              >
                source page ↗
              </a>
            ) : (
              <span className="oqcv-small oqcv-muted">{row.source_url}</span>
            )}
          </>
        )}
      </td>

      {/* 4 Status badge */}
      <td>
        <span className={`status-badge status-${row.status}`}>
          {statusLabel(row.status)}
        </span>
      </td>

      {/* 5 Notes */}
      <td className="notes-cell">{row.notes}</td>

      {/* 6 Evidence */}
      <td>
        {row.evidence_storage_path ? (
          <SignedDocLink
            bucket="cert-letters"
            path={row.evidence_storage_path}
            ttlSeconds={600}
            label="View letter"
            className="btn-action btn-view"
          />
        ) : (
          <span className="oqcv-muted oqcv-small">—</span>
        )}
      </td>

      {/* 7 Created */}
      <td>{created}</td>

      {/* 8 Actions */}
      <td>
        <div className="actions">
          {row.status !== 'verified' && (
            <button
              type="button"
              className="btn-action btn-approve"
              onClick={() => onApprove(row)}
            >
              Approve
            </button>
          )}
          {row.status !== 'rejected' && (
            <button
              type="button"
              className="btn-action btn-reject"
              onClick={() => onReject(row)}
            >
              Reject
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Styles (ported from admin-cert-verifications.html inline CSS) ─────────────

const STYLES = `
  .oqcv-main { max-width: 1400px; margin: 0 auto; padding: 2rem 1.5rem; color: #1F2937; }

  .oqcv-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem; gap: 1rem; flex-wrap: wrap; }
  .oqcv-title { display: flex; align-items: center; gap: 1rem; }
  .oqcv-h1 { font-family: 'Rubik', sans-serif; font-size: 2.5rem; color: var(--white,#FFFFFF); margin: 0; }
  .oqcv-badge { background: var(--amber,#E07B00); color: var(--navy,#0D1B2E); padding: 0.4rem 0.8rem; border-radius: 0.5rem; font-weight: 700; font-size: 0.875rem; }
  .oqcv-logout { background: var(--white,#FFFFFF); color: var(--navy,#0D1B2E); border: none; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; }
  .oqcv-logout:hover { background: var(--light,#E2E8F0); }
  .oqcv-nav-wrap { margin-bottom: 2rem; }

  .oqcv-error { padding: 1.5rem 1rem; color: var(--white,#FFFFFF); background: rgba(239,68,68,0.1); border: 1px solid #EF4444; border-radius: 0.5rem; margin-bottom: 1.5rem; }

  .mode-banner { background: rgba(224,123,0,0.1); border: 1px solid rgba(224,123,0,0.3); color: var(--amber,#E07B00); padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 1.5rem; font-size: 0.9rem; }

  .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
  .summary-card { background: var(--white,#FFFFFF); border-radius: 0.75rem; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .summary-card-label { font-size: 0.8rem; color: var(--slate,#94A3B8); margin-bottom: 0.4rem; font-weight: 500; }
  .summary-card-value { font-size: 2rem; font-weight: 700; color: var(--navy,#0D1B2E); }

  .filter-tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .filter-tab { background: rgba(255,255,255,0.05); color: var(--slate,#94A3B8); border: 1px solid rgba(255,255,255,0.1); padding: 0.5rem 1rem; border-radius: 0.5rem; cursor: pointer; font-size: 0.9rem; }
  .filter-tab:hover { background: rgba(255,255,255,0.1); color: var(--white,#FFFFFF); }
  .filter-tab.active { background: var(--amber,#E07B00); color: var(--navy,#0D1B2E); border-color: var(--amber,#E07B00); font-weight: 600; }

  .table-wrapper { background: var(--white,#FFFFFF); border-radius: 0.75rem; padding: 0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .cert-table { width: 100%; border-collapse: collapse; }
  .cert-table th { background: var(--light,#E2E8F0); padding: 1rem; text-align: left; font-weight: 600; color: var(--navy,#0D1B2E); font-size: 0.85rem; }
  .cert-table td { padding: 1rem; border-top: 1px solid var(--light,#E2E8F0); font-size: 0.9rem; vertical-align: top; }
  .cert-table tr:hover { background: rgba(0,0,0,0.02); }

  .status-badge { display: inline-block; padding: 0.25rem 0.65rem; border-radius: 1rem; font-size: 0.75rem; font-weight: 600; }
  .status-pending           { background: #FEF3C7; color: #92400E; }
  .status-scrape_failed     { background: #FEE2E2; color: #991B1B; }
  .status-blocked_by_robots { background: #DBEAFE; color: #1E40AF; }
  .status-verified          { background: #D1FAE5; color: #065F46; }
  .status-rejected          { background: #FCE7F3; color: #9F1239; }

  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .btn-action { padding: 0.4rem 0.85rem; border-radius: 0.4rem; border: none; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
  .btn-approve { background: #10B981; color: white; }
  .btn-approve:hover { background: #059669; }
  .btn-reject { background: #EF4444; color: white; }
  .btn-reject:hover { background: #DC2626; }
  .btn-view { background: var(--light,#E2E8F0); color: var(--navy,#0D1B2E); text-decoration: none; display: inline-block; }
  .btn-view:hover { background: #CBD5E1; }

  .loading-spinner { padding: 3rem; text-align: center; color: var(--slate,#94A3B8); }
  .empty-state { padding: 3rem; text-align: center; color: var(--slate,#94A3B8); }

  .notes-cell { max-width: 320px; color: #475569; font-size: 0.85rem; line-height: 1.4; }
  .oqcv-muted { color: #94A3B8; }
  .oqcv-small { font-size: 0.78rem; }
  .oqcv-source-link { color: #0F766E; font-size: 0.78rem; }

  @media (max-width: 768px) {
    .cert-table { font-size: 0.8rem; }
    .cert-table th, .cert-table td { padding: 0.6rem; }
  }
`;
