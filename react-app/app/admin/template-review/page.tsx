'use client';

/**
 * Admin Template Review — D-211 Phase 9 (A6). Port of admin-template-review.html
 * → the React /admin/template-review route.
 *
 * Wrapped by <RequireAdmin tier="reviewer"> + <AdminNav active="template-review">.
 * The static page's inline CONFIG guard, createClient call, magic-link hash
 * handler, and hardcoded-email gate are all replaced by the shared auth shell
 * (AuthProvider + RequireAdmin — reviewer tier = ADMIN_EMAILS OR
 * contractors.template_review_role==='admin', the exact static gate).
 *
 * §6.1 XSS fold: the static built DOM nodes imperatively; this port renders
 * every DB/user value as JSX text (React-escaped) and wires every action as an
 * onClick closure over the row object — zero innerHTML / string-built handlers.
 *
 * Writes are DIRECT contractor_templates UPDATEs (approve → admin_validated,
 * reject → rejected) — NOT via an Edge Function (validate-contract-template is
 * deliberately NOT called; the static page never called it either). reviewed_by
 * is the admin's user.id.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { RequireAdmin } from '../_shell/RequireAdmin';
import { AdminNav } from '../_shell/AdminNav';
import { FilterTabs } from '../_shell/FilterTabs';
import { SignedDocLink } from '../_shell/doc-viewer';
import { DetailDrawer } from '../_shell/DetailDrawer';
import {
  type TemplateRow,
  type TemplateFilter,
  TEMPLATE_FILTERS,
  filteredTemplates,
  summaryCounts,
  statusBadge,
  anchorSummary,
  buildAnchorList,
  drawerTitle,
  buildApproveUpdate,
  buildRejectUpdate,
} from './utils';

const TEMPLATE_SELECT =
  '*, contractors:contractor_id(id, company_name, email, contact_name)';

export default function TemplateReviewPage() {
  return (
    <RequireAdmin tier="reviewer">
      <TemplateReviewContent />
    </RequireAdmin>
  );
}

function TemplateReviewContent() {
  const { user, signOut } = useAuth();
  const router = useRouter();

  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<TemplateFilter>('needs_review');

  const [openTemplate, setOpenTemplate] = useState<TemplateRow | null>(null);
  const [rejectFormOpen, setRejectFormOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  // ── Loader (port of loadTemplates(), read UNCHANGED) ──
  async function loadTemplates() {
    setLoading(true);
    setLoadError(false);
    try {
      const { data, error } = await supabase
        .from('contractor_templates')
        .select(TEMPLATE_SELECT)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      setRows((data || []) as TemplateRow[]);
    } catch (err) {
      console.error('Error loading templates:', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTemplates();
    // RequireAdmin only mounts this once auth is settled + authorized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived ──
  const counts = summaryCounts(rows);
  const filtered = filteredTemplates(filter, rows);
  const anchorList = openTemplate ? buildAnchorList(openTemplate.validation_result) : null;

  // ── Drawer open/close ──
  function openDrawer(row: TemplateRow) {
    setOpenTemplate(row);
    setRejectFormOpen(false);
    setRejectReason('');
  }
  function closeDrawer() {
    setOpenTemplate(null);
    setRejectFormOpen(false);
    setRejectReason('');
  }

  // ── Mutations (DIRECT contractor_templates UPDATE — port UNCHANGED) ──
  async function handleApprove() {
    if (!openTemplate || !user) return;
    if (
      !window.confirm(
        'Approve this template as admin-validated? Contractor will be able to bid using this template.',
      )
    ) {
      return;
    }
    const { error } = await supabase
      .from('contractor_templates')
      .update(buildApproveUpdate(user.id))
      .eq('id', openTemplate.id);
    if (error) {
      window.alert('Approve failed: ' + error.message);
      return;
    }
    closeDrawer();
    await loadTemplates();
  }

  async function handleReject() {
    if (!openTemplate || !user) return;
    const reason = rejectReason.trim();
    if (!reason) {
      window.alert('Rejection reason is required.');
      return;
    }
    const { error } = await supabase
      .from('contractor_templates')
      .update(buildRejectUpdate(user.id, reason))
      .eq('id', openTemplate.id);
    if (error) {
      window.alert('Reject failed: ' + error.message);
      return;
    }
    closeDrawer();
    await loadTemplates();
  }

  // ── Logout (mirror A5 / Phase 8) ──
  async function handleLogout() {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  }

  return (
    <main className="oqtr-main">
      <style>{STYLES}</style>

      {/* Header */}
      <div className="oqtr-header">
        <div className="oqtr-title">
          <span className="oqtr-badge">ADMIN</span>
          <h1 className="oqtr-h1">Template Review</h1>
        </div>
        <button type="button" className="oqtr-logout" onClick={handleLogout}>
          Log Out
        </button>
      </div>

      {/* Admin nav */}
      <div className="oqtr-nav-wrap">
        <AdminNav active="template-review" />
      </div>

      {/* Summary cards */}
      <div className="summary-cards">
        <SummaryCard label="Awaiting Admin Review" value={counts.awaiting} />
        <SummaryCard label="Auto-Validated (Tier 1)" value={counts.auto} />
        <SummaryCard label="Manual-Validated (Tier 2)" value={counts.manual} />
        <SummaryCard label="Rejected" value={counts.rejected} />
      </div>

      {/* Filter tabs */}
      <FilterTabs
        tabs={TEMPLATE_FILTERS}
        active={filter}
        onChange={(key) => setFilter(key as TemplateFilter)}
      />

      {/* Table */}
      <div className="table-wrapper">
        {loadError ? (
          <div className="loading-spinner">Error loading templates — see console.</div>
        ) : loading ? (
          <div className="loading-spinner">Loading templates…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No templates match this filter.</div>
        ) : (
          <table className="template-table">
            <thead>
              <tr>
                <th>Contractor</th>
                <th>Trade × Funding</th>
                <th>Anchors Found</th>
                <th>Status</th>
                <th>Submitted</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <TemplateTableRow key={row.id} row={row} onReview={openDrawer} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail drawer */}
      <DetailDrawer
        open={openTemplate !== null}
        title={openTemplate ? drawerTitle(openTemplate) : ''}
        onClose={closeDrawer}
      >
        {openTemplate && (
          <>
            {/* a) Open contractor PDF (lazy signed URL on click) */}
            <div style={{ marginBottom: '1rem' }}>
              <SignedDocLink
                bucket="contractor-templates"
                path={openTemplate.pdf_storage_path}
                ttlSeconds={600}
                label="Open contractor PDF"
                className="btn-action btn-view"
              />
            </div>

            {/* b) Required anchors (only when anchors present) */}
            {anchorList && anchorList.rows.length > 0 && (
              <>
                <h3 className="oqtr-anchor-heading">
                  Required Anchors ({anchorList.headingFound} / {anchorList.headingTotal})
                </h3>
                <div className="anchor-grid">
                  {anchorList.rows.map((a, i) => (
                    <div key={`${a.anchor}-${i}`} className={'anchor-row ' + a.rowClass}>
                      <div>
                        <code>{a.anchor}</code>
                        <br />
                        <small style={{ color: '#666' }}>{a.field}</small>
                      </div>
                      <span style={{ fontWeight: 600 }}>{a.rightText}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* c) Actions */}
            <div className="oqtr-drawer-actions">
              <button
                type="button"
                className="btn-action btn-approve"
                onClick={handleApprove}
              >
                Approve as Admin-Validated
              </button>
              <button
                type="button"
                className="btn-action btn-reject"
                onClick={() => setRejectFormOpen((v) => !v)}
              >
                Reject
              </button>
            </div>

            {/* d) Reject form (hidden until toggled) */}
            <div className={'reject-form' + (rejectFormOpen ? ' open' : '')}>
              <label className="oqtr-reject-label">
                Rejection reason (visible to contractor):
              </label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g., Required anchors are not present even after manual mapping. Please re-upload a template that includes the listed required fields."
              />
              <button
                type="button"
                className="btn-action btn-reject"
                style={{ marginTop: '0.75rem' }}
                onClick={handleReject}
              >
                Confirm Reject
              </button>
            </div>
          </>
        )}
      </DetailDrawer>
    </main>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="summary-card">
      <div className="summary-card-label">{label}</div>
      <div className="summary-card-value">{value}</div>
    </div>
  );
}

function TemplateTableRow({
  row,
  onReview,
}: {
  row: TemplateRow;
  onReview: (row: TemplateRow) => void;
}) {
  const company = row.contractors?.company_name || '(unknown)';
  const email = row.contractors?.email || '';
  const badge = statusBadge(row.status);
  const anchors = anchorSummary(row.validation_result);
  const ts = new Date(row.updated_at || row.created_at || '');
  const submitted =
    ts.toLocaleDateString() +
    ' ' +
    ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <tr>
      {/* 1 Contractor */}
      <td>
        <strong>{company}</strong>
        <br />
        <small style={{ color: 'var(--slate,#94A3B8)' }}>{email}</small>
      </td>

      {/* 2 Trade × Funding */}
      <td>{row.trade + ' × ' + row.funding_type}</td>

      {/* 3 Anchors Found */}
      <td className="anchor-summary">
        {anchors.validated ? (
          <>
            <strong>
              {anchors.found} / {anchors.total}
            </strong>{' '}
            required found
          </>
        ) : (
          anchors.label
        )}
      </td>

      {/* 4 Status */}
      <td>
        <span className={'status-badge ' + badge.cls}>{badge.label}</span>
      </td>

      {/* 5 Submitted */}
      <td>{submitted}</td>

      {/* 6 Actions */}
      <td className="actions">
        <button
          type="button"
          className="btn-action btn-view"
          onClick={() => onReview(row)}
        >
          Review
        </button>
      </td>
    </tr>
  );
}

// ── Styles (ported from admin-template-review.html inline CSS) ────────────────

const STYLES = `
  .oqtr-main { max-width: 1400px; margin: 0 auto; padding: 2rem 1.5rem; color: #1F2937; }

  .oqtr-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem; gap: 1rem; flex-wrap: wrap; }
  .oqtr-title { display: flex; align-items: center; gap: 1rem; }
  .oqtr-h1 { font-family: 'Rubik', sans-serif; font-size: 2.5rem; color: var(--white,#FFFFFF); margin: 0; }
  .oqtr-badge { background: var(--amber,#E07B00); color: var(--navy,#0D1B2E); padding: 0.4rem 0.8rem; border-radius: 0.5rem; font-weight: 700; font-size: 0.875rem; }
  .oqtr-logout { background: var(--white,#FFFFFF); color: var(--navy,#0D1B2E); border: none; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; }
  .oqtr-logout:hover { background: var(--light,#E2E8F0); }
  .oqtr-nav-wrap { margin-bottom: 2rem; }

  .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
  .summary-card { background: var(--white,#FFFFFF); border-radius: 0.75rem; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .summary-card-label { font-size: 0.8rem; color: var(--slate,#94A3B8); margin-bottom: 0.4rem; font-weight: 500; }
  .summary-card-value { font-size: 2rem; font-weight: 700; color: var(--navy,#0D1B2E); }

  .filter-tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .filter-tab { background: rgba(255,255,255,0.05); color: var(--slate,#94A3B8); border: 1px solid rgba(255,255,255,0.1); padding: 0.5rem 1rem; border-radius: 0.5rem; cursor: pointer; font-size: 0.9rem; }
  .filter-tab:hover { background: rgba(255,255,255,0.1); color: var(--white,#FFFFFF); }
  .filter-tab.active { background: var(--amber,#E07B00); color: var(--navy,#0D1B2E); border-color: var(--amber,#E07B00); font-weight: 600; }

  .table-wrapper { background: var(--white,#FFFFFF); border-radius: 0.75rem; padding: 0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .template-table { width: 100%; border-collapse: collapse; }
  .template-table th { background: var(--light,#E2E8F0); padding: 1rem; text-align: left; font-weight: 600; color: var(--navy,#0D1B2E); font-size: 0.85rem; }
  .template-table td { padding: 1rem; border-top: 1px solid var(--light,#E2E8F0); font-size: 0.9rem; vertical-align: top; }
  .template-table tr:hover { background: rgba(0,0,0,0.02); }

  .status-badge { display: inline-block; padding: 0.25rem 0.65rem; border-radius: 1rem; font-size: 0.75rem; font-weight: 600; }
  .status-pending  { background: #FEF3C7; color: #92400E; }
  .status-mapping  { background: #FEE2E2; color: #991B1B; }
  .status-admin    { background: #DBEAFE; color: #1E40AF; }
  .status-validated{ background: #D1FAE5; color: #065F46; }
  .status-rejected { background: #FCE7F3; color: #9F1239; }

  .anchor-summary { font-family: ui-monospace, "SFMono-Regular", monospace; font-size: 0.8rem; color: var(--slate,#94A3B8); }
  .anchor-summary strong { color: var(--navy,#0D1B2E); }

  .actions { display: flex; gap: 0.5rem; }
  .btn-action { padding: 0.4rem 0.85rem; border-radius: 0.4rem; border: none; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
  .btn-approve { background: #10B981; color: white; }
  .btn-approve:hover { background: #059669; }
  .btn-reject  { background: #EF4444; color: white; }
  .btn-reject:hover { background: #DC2626; }
  .btn-view    { background: var(--light,#E2E8F0); color: var(--navy,#0D1B2E); text-decoration: none; display: inline-block; }
  .btn-view:hover { background: #CBD5E1; }

  .loading-spinner { padding: 3rem; text-align: center; color: var(--slate,#94A3B8); }
  .empty-state { padding: 3rem; text-align: center; color: var(--slate,#94A3B8); }

  /* drawer body content (drawer chrome lives in DetailDrawer) */
  .oqtr-anchor-heading { font-size: 1rem; margin-top: 1.5rem; }
  .anchor-grid { display: grid; grid-template-columns: 1fr; gap: 0.5rem; margin-top: 1rem; }
  .anchor-row { padding: 0.6rem 0.85rem; border-radius: 0.4rem; display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; }
  .anchor-row.found { background: #D1FAE5; }
  .anchor-row.missing { background: #FEE2E2; }
  .anchor-row code { font-family: ui-monospace, monospace; }
  .oqtr-drawer-actions { margin-top: 1.5rem; display: flex; gap: 0.5rem; }
  .reject-form { padding-top: 1rem; border-top: 1px solid var(--light,#E2E8F0); margin-top: 1rem; display: none; }
  .reject-form.open { display: block; }
  .oqtr-reject-label { font-size: 0.85rem; font-weight: 600; }
  .reject-form textarea { width: 100%; min-height: 100px; padding: 0.75rem; border: 1px solid var(--light,#E2E8F0); border-radius: 0.5rem; font-family: inherit; font-size: 0.9rem; margin-top: 0.5rem; }

  @media (max-width: 768px) {
    .template-table { font-size: 0.8rem; }
    .template-table th, .template-table td { padding: 0.6rem; }
  }
`;
