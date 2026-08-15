'use client';

/**
 * Admin Referral Partners — D-211 Phase 11. Port of admin-referrals.html
 * → the React /admin/referrals route.
 *
 * Wrapped by <RequireAdmin tier="super"> + <AdminNav active="referrals">.
 *
 * GATE: the static page gated client-side on a single hardcoded email
 * (currentUser.email === 'dustinstohler1@gmail.com'). That is replaced by the
 * shared auth shell (AuthProvider + RequireAdmin tier="super") — the same
 * deliberate parity choice made for admin-payouts / admin-fee-config (do NOT
 * re-check email here). See the handoff for the super-allowlist (2 emails) vs
 * the v88 referral_agents RLS admin policy (single hardcoded email) divergence
 * — FLAGGED for the CTO, NOT fixed here.
 *
 * §6.1 XSS fold: the static renderTable()/buildActions() built HTML strings and
 * interpolated first_name, last_name, email, agent_type (agent_type UNESCAPED)
 * and w9_file_url into cell innerHTML and onclick="…('${…}')" handlers. This
 * port renders every DB/user value as JSX text (React-escaped) and wires every
 * action as an onClick closure over the row — zero innerHTML /
 * dangerouslySetInnerHTML / string-built handlers. W-9 PDFs open via the shared
 * SignedDocLink (partner-w9 bucket, 60s TTL); no path is interpolated into the DOM.
 *
 * ⚠️  W-9 / PAYMENT-BLOCK CONTRACTS UNCHANGED (Tier-3): the referral_agents read
 * (REFERRAL_AGENTS_SELECT), verify-W9 write ({ w9_verified_at }), and manual-
 * unblock write ({ payments_blocked: false }) are byte-for-byte the static
 * queries — DIRECT table .update() calls, NOT Edge Functions. No commission
 * logic (apply_referral_commission) is touched.
 *
 * gh-865: this route had no `agent_type` correction path at all (only
 * handleVerify / confirmUnblock existed) — a gap PR #891 disclosed but left
 * unfixed on `admin-referrals.html` (the sibling static admin page, which got
 * the Edit control). Added here to close that divergence: openAgentTypeEditor
 * / handleChangeAgentType below mirror admin-referrals.html's
 * openAgentTypeEditor()/changeAgentType() 1:1 — same direct
 * `.update({ agent_type })` write, same RLS policy ("Admin can update
 * referral agents", is_admin_email(), p18_admin_identity_allowlist.sql), same
 * six-value referral_agents_agent_type_check option set. Whitelisted to this
 * file only, so the label map + modal live inline here rather than in
 * utils.ts (unlike verifyW9Payload/unblockPayload).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { RequireAdmin } from '../_shell/RequireAdmin';
import { AdminNav } from '../_shell/AdminNav';
import { FilterTabs } from '../_shell/FilterTabs';
import { SignedDocLink } from '../_shell/doc-viewer';
import {
  type ReferralAgent,
  type ReferralFilter,
  REFERRAL_AGENTS_SELECT,
  REFERRAL_FILTERS,
  filterPartners,
  summaryCards,
  fullName,
  fmtDate,
  w9StatusBadge,
  typeBadge,
  paymentsBadge,
  showViewW9,
  showVerifyW9,
  showUnblock,
  verifyW9Payload,
  unblockPayload,
  W9_BUCKET,
  W9_SIGNED_URL_TTL_SECONDS,
  UNBLOCK_CONFIRM_TEXT,
} from './utils';

// gh-865: mirrors admin-referrals.html's AGENT_TYPE_LABELS in
// openAgentTypeEditor() exactly — the six referral_agents_agent_type_check
// values (sql/v0-base-schema.sql / baseline schema constraint).
const AGENT_TYPE_LABELS: Record<string, string> = {
  re_agent: 'Real Estate Agent',
  insurance_agent: 'Insurance Agent',
  home_inspector: 'Home Inspector',
  customer: 'Customer',
  adjuster: 'Insurance Adjuster',
  other: 'Other',
};

export default function AdminReferralsPage() {
  return (
    <RequireAdmin tier="super">
      <AdminReferralsContent />
    </RequireAdmin>
  );
}

function AdminReferralsContent() {
  const { signOut } = useAuth();
  const router = useRouter();

  const [allPartners, setAllPartners] = useState<ReferralAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReferralFilter>('all');
  const [unblockTarget, setUnblockTarget] = useState<ReferralAgent | null>(null);
  const [editTypeTarget, setEditTypeTarget] = useState<ReferralAgent | null>(null);
  const [editTypeValue, setEditTypeValue] = useState<string>('');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Transient toast — mirrors showToast() (auto-hide after 3500ms).
  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // ── Loader ──────────────────────────────────────────────────────────────────
  async function loadPartners() {
    const { data, error } = await supabase
      .from('referral_agents')
      .select(REFERRAL_AGENTS_SELECT)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('loadPartners error:', error);
      setLoadError('Failed to load partners: ' + error.message);
      setAllPartners([]);
    } else {
      setLoadError(null);
      setAllPartners((data || []) as ReferralAgent[]);
    }
    setLoading(false);
  }

  useEffect(() => {
    // RequireAdmin only mounts this content once auth is settled + authorized.
    void loadPartners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────
  const cards = summaryCards(allPartners);
  const partners = filterPartners(allPartners, filter);

  // ── Verify W-9 (DIRECT table update — UNCHANGED contract) ───────────────────
  async function handleVerify(id: string) {
    const { error } = await supabase
      .from('referral_agents')
      .update(verifyW9Payload(new Date().toISOString()))
      .eq('id', id);

    if (error) {
      showToast('Error verifying W-9: ' + error.message);
      return;
    }
    showToast('W-9 verified ✅');
    await loadPartners();
  }

  // ── Manual unblock (DIRECT table update — UNCHANGED contract) ───────────────
  function openUnblock(row: ReferralAgent) {
    setUnblockTarget(row);
  }
  function closeUnblock() {
    setUnblockTarget(null);
  }
  async function confirmUnblock() {
    if (!unblockTarget) return;
    const id = unblockTarget.id;

    const { error } = await supabase
      .from('referral_agents')
      .update(unblockPayload())
      .eq('id', id);

    closeUnblock();
    if (error) {
      showToast('Error unblocking partner: ' + error.message);
      return;
    }
    showToast('Partner manually unblocked ✅');
    await loadPartners();
  }

  // ── Agent-type correction (gh-865, DIRECT table update — mirrors
  //    admin-referrals.html openAgentTypeEditor()/changeAgentType()) ──────────
  function openAgentTypeEditor(row: ReferralAgent) {
    setEditTypeValue(row.agent_type || '');
    setEditTypeTarget(row);
  }
  function closeAgentTypeEditor() {
    setEditTypeTarget(null);
  }
  async function handleChangeAgentType() {
    if (!editTypeTarget) return;
    const id = editTypeTarget.id;
    const currentType = editTypeTarget.agent_type || '';
    const newType = editTypeValue;

    closeAgentTypeEditor();
    if (newType === currentType) return;

    // Matches referral_agents_agent_type_check (baseline schema): re_agent,
    // insurance_agent, home_inspector, customer, adjuster, other.
    const { error } = await supabase
      .from('referral_agents')
      .update({ agent_type: newType })
      .eq('id', id);

    if (error) {
      showToast('Error changing partner type: ' + error.message);
      return;
    }
    showToast('Partner type updated ✅');
    await loadPartners();
  }

  // ── Logout ──────────────────────────────────────────────────────────────────
  async function handleLogout() {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <main className="oqr-main">
      <style>{STYLES}</style>

      {/* Header */}
      <div className="oqr-header">
        <div className="oqr-title">
          <h1 className="oqr-h1">Referral Partners</h1>
          <span className="oqr-badge">ADMIN</span>
        </div>
        <button type="button" className="oqr-logout" onClick={handleLogout}>
          Log Out
        </button>
      </div>

      {/* Admin nav */}
      <div className="oqr-nav-wrap">
        <AdminNav active="referrals" />
      </div>

      {/* Summary cards */}
      <div className="summary-cards">
        <div className="summary-card">
          <div className="summary-card-label">Total Partners</div>
          <div className="summary-card-value">{cards.total}</div>
        </div>
        <div className="summary-card" style={{ borderLeft: '4px solid #fcd34d' }}>
          <div className="summary-card-label" style={{ color: '#92400e' }}>
            ⚠️ Payments Blocked
          </div>
          <div className="summary-card-value" style={{ color: '#d97706' }}>
            {cards.blocked}
          </div>
        </div>
        <div className="summary-card" style={{ borderLeft: '4px solid #93c5fd' }}>
          <div className="summary-card-label" style={{ color: '#1d4ed8' }}>
            📋 Pending Review
          </div>
          <div className="summary-card-value" style={{ color: '#2563eb' }}>
            {cards.pendingReview}
          </div>
        </div>
        <div className="summary-card" style={{ borderLeft: '4px solid #86efac' }}>
          <div className="summary-card-label" style={{ color: '#166534' }}>
            ✅ W-9 Verified
          </div>
          <div className="summary-card-value" style={{ color: '#15803d' }}>
            {cards.verified}
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <FilterTabs
        tabs={REFERRAL_FILTERS}
        active={filter}
        onChange={(key) => setFilter(key as ReferralFilter)}
      />

      {/* Partners table */}
      <div className="table-wrapper">
        <table className="partners-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Type</th>
              <th>Signed Up</th>
              <th>W-9 Status</th>
              <th>Notified</th>
              <th>Payments</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="oqr-cell-msg">
                  Loading…
                </td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={8} className="oqr-cell-msg oqr-cell-error">
                  {loadError}
                </td>
              </tr>
            ) : partners.length === 0 ? (
              <tr>
                <td colSpan={8} className="oqr-cell-msg">
                  No partners in this category.
                </td>
              </tr>
            ) : (
              partners.map((p) => (
                <PartnerRow
                  key={p.id}
                  partner={p}
                  onVerify={handleVerify}
                  onUnblock={openUnblock}
                  onEditType={openAgentTypeEditor}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Toast */}
      {toast !== null && <div className="toast show">{toast}</div>}

      {/* Manual-unblock confirm modal (replaces native confirm() — sibling pattern) */}
      {unblockTarget !== null && (
        <div
          className="oqr-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeUnblock();
          }}
        >
          <div className="oqr-modal">
            <h3 className="oqr-modal-title">Unblock Partner</h3>
            <p className="oqr-modal-text">{UNBLOCK_CONFIRM_TEXT}</p>
            <div className="oqr-modal-buttons">
              <button
                type="button"
                className="oqr-modal-btn oqr-modal-btn-secondary"
                onClick={closeUnblock}
              >
                Cancel
              </button>
              <button
                type="button"
                className="oqr-modal-btn oqr-modal-btn-primary"
                onClick={confirmUnblock}
              >
                Unblock
              </button>
            </div>
          </div>
        </div>
      )}

      {/* gh-865: agent-type correction modal — mirrors admin-referrals.html
          openAgentTypeEditor(); same six-value option set, same direct
          .update({ agent_type }) write on Save. */}
      {editTypeTarget !== null && (
        <div
          className="oqr-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAgentTypeEditor();
          }}
        >
          <div className="oqr-modal">
            <h3 className="oqr-modal-title">Change partner type</h3>
            <p className="oqr-modal-text">
              Corrects a mis-classified partner (e.g. a signup that landed on the wrong recruit
              page). Writes directly to referral_agents.agent_type.
            </p>
            <select
              className="oqr-type-select"
              value={editTypeValue}
              onChange={(e) => setEditTypeValue(e.target.value)}
              autoFocus
            >
              {Object.entries(AGENT_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <div className="oqr-modal-buttons">
              <button
                type="button"
                className="oqr-modal-btn oqr-modal-btn-secondary"
                onClick={closeAgentTypeEditor}
              >
                Cancel
              </button>
              <button
                type="button"
                className="oqr-modal-btn oqr-modal-btn-primary"
                onClick={handleChangeAgentType}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ── PartnerRow sub-component ───────────────────────────────────────────────────
function PartnerRow({
  partner,
  onVerify,
  onUnblock,
  onEditType,
}: {
  partner: ReferralAgent;
  onVerify: (id: string) => void;
  onUnblock: (row: ReferralAgent) => void;
  onEditType: (row: ReferralAgent) => void;
}) {
  const w9 = w9StatusBadge(partner);
  const type = typeBadge(partner.agent_type);
  const payments = paymentsBadge(partner);
  const hasAction = showViewW9(partner) || showVerifyW9(partner) || showUnblock(partner);

  return (
    <tr>
      <td>
        <strong>{fullName(partner)}</strong>
      </td>
      <td>{partner.email || '—'}</td>
      <td>
        <span className={`badge ${type.className}`}>{type.label}</span>{' '}
        <button
          type="button"
          className="btn-sm btn-sm-view"
          onClick={() => onEditType(partner)}
          title="gh-865: correct a mis-classified partner"
        >
          Edit
        </button>
      </td>
      <td>{fmtDate(partner.created_at)}</td>
      <td>
        <span className={`badge ${w9.className}`}>{w9.label}</span>
      </td>
      <td>{fmtDate(partner.w9_notification_sent_at)}</td>
      <td>
        <span className={`badge ${payments.className}`}>{payments.label}</span>
      </td>
      <td>
        <div className="action-cell">
          {showViewW9(partner) && (
            <SignedDocLink
              bucket={W9_BUCKET}
              path={partner.w9_file_url as string}
              ttlSeconds={W9_SIGNED_URL_TTL_SECONDS}
              label="View W-9"
              className="btn-sm btn-sm-view"
            />
          )}
          {showVerifyW9(partner) && (
            <button
              type="button"
              className="btn-sm btn-sm-verify"
              onClick={() => onVerify(partner.id)}
            >
              Verify W-9
            </button>
          )}
          {showUnblock(partner) && (
            <button
              type="button"
              className="btn-sm btn-sm-unblock"
              onClick={() => onUnblock(partner)}
            >
              Unblock
            </button>
          )}
          {!hasAction && <span className="action-empty">—</span>}
        </div>
      </td>
    </tr>
  );
}

// ── Styles (ported from admin-referrals.html inline CSS; outer container classes
//    namespaced oqr-, shared badge/btn/table/filter/summary class names kept) ───

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

  .oqr-main {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
    color: #1F2937;
    font-family: 'Rubik', sans-serif;
  }

  /* ── Header ──────────────────────────────────────────── */
  .oqr-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 2rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .oqr-title { display: flex; align-items: center; gap: 1rem; }
  .oqr-badge {
    background: var(--teal, #14B8A6);
    color: var(--white, #FFFFFF);
    padding: 0.4rem 0.8rem;
    border-radius: 0.5rem;
    font-weight: 700;
    font-size: 0.875rem;
  }
  .oqr-h1 {
    font-family: 'Rubik', sans-serif;
    font-size: 2.5rem;
    color: var(--white, #FFFFFF);
    margin: 0;
  }
  .oqr-logout {
    background: var(--white, #FFFFFF);
    color: var(--navy, #0D1B2E);
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
    font-family: 'Rubik', sans-serif;
  }
  .oqr-logout:hover { background: var(--light, #E2E8F0); }
  .oqr-nav-wrap { margin-bottom: 1.5rem; }

  /* ── Summary cards ───────────────────────────────────── */
  .summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
  }
  .summary-card {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    padding: 1.5rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .summary-card-label {
    font-size: 0.875rem;
    color: var(--slate, #94A3B8);
    margin-bottom: 0.5rem;
  }
  .summary-card-value {
    font-size: 2.5rem;
    font-weight: 700;
    color: var(--navy, #0D1B2E);
  }

  /* ── Filter tabs (FilterTabs emits .filter-tabs / .filter-tab[.active]) ── */
  .filter-tabs {
    display: flex;
    gap: 1rem;
    margin-bottom: 2rem;
    border-bottom: 2px solid rgba(255, 255, 255, 0.1);
    flex-wrap: wrap;
  }
  .filter-tab {
    background: transparent;
    color: var(--slate, #94A3B8);
    border: none;
    padding: 1rem 1.5rem;
    cursor: pointer;
    font-weight: 600;
    font-size: 1rem;
    border-bottom: 3px solid transparent;
    transition: all 0.3s ease;
    font-family: 'Rubik', sans-serif;
  }
  .filter-tab.active {
    color: var(--white, #FFFFFF);
    border-bottom-color: var(--teal, #14B8A6);
  }

  /* ── Table ───────────────────────────────────────────── */
  .table-wrapper {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    overflow-x: auto;
  }
  .partners-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .partners-table th {
    background: var(--navy, #0D1B2E);
    color: var(--white, #FFFFFF);
    padding: 0.875rem 1rem;
    text-align: left;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }
  .partners-table td {
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--light, #E2E8F0);
    vertical-align: middle;
    color: #374151;
  }
  .partners-table tr:last-child td { border-bottom: none; }
  .partners-table tr:hover td { background: #f8fafc; }

  .oqr-cell-msg {
    text-align: center;
    padding: 2rem;
    color: var(--slate, #94A3B8);
  }
  .oqr-cell-error { color: #ef4444; }

  /* ── Badges ──────────────────────────────────────────── */
  .badge {
    display: inline-block;
    padding: 0.3rem 0.6rem;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .badge-verified    { background: #dcfce7; color: #15803d; }
  .badge-pending     { background: #dbeafe; color: #1d4ed8; }
  .badge-blocked     { background: #fef3c7; color: #92400e; }
  .badge-not-filed   { background: var(--light, #E2E8F0); color: #64748b; }
  .badge-type-re     { background: #ede9fe; color: #6d28d9; }
  .badge-type-ins    { background: #fce7f3; color: #9d174d; }
  .badge-type-insp   { background: #e0f2fe; color: #0369a1; }
  .badge-type-cust   { background: #f0fdf4; color: #166534; }

  /* ── Action buttons ──────────────────────────────────── */
  .btn-sm {
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: all 0.2s ease;
    white-space: nowrap;
    text-decoration: none;
    display: inline-block;
    font-family: 'Rubik', sans-serif;
  }
  .btn-sm-verify { background: var(--green, #10B981); color: var(--white, #FFFFFF); }
  .btn-sm-verify:hover { background: #059669; }
  .btn-sm-view { background: var(--teal, #14B8A6); color: var(--white, #FFFFFF); }
  .btn-sm-view:hover { background: #0f9488; }
  .btn-sm-unblock { background: var(--amber, #E07B00); color: var(--navy, #0D1B2E); }
  .btn-sm-unblock:hover { background: #d97706; }

  .action-cell {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .action-empty { color: var(--slate, #94A3B8); font-size: 0.8rem; }

  /* ── Toast ───────────────────────────────────────────── */
  .toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    background: #1f2937;
    color: var(--white, #FFFFFF);
    padding: 0.875rem 1.5rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    font-weight: 600;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 9999;
    display: none;
  }
  .toast.show { display: block; }

  /* ── Unblock confirm modal ───────────────────────────── */
  .oqr-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .oqr-modal {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    padding: 2rem;
    min-width: 380px;
    max-width: 480px;
    width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  }
  .oqr-modal-title {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--navy, #0D1B2E);
    margin: 0 0 1rem 0;
  }
  .oqr-modal-text { margin-bottom: 1.5rem; color: #475569; line-height: 1.5; }
  .oqr-type-select {
    width: 100%;
    padding: 0.6rem;
    border-radius: 0.5rem;
    border: 1px solid var(--light, #E2E8F0);
    font-size: 0.9rem;
    margin-bottom: 1.5rem;
    background: var(--white, #FFFFFF);
    color: #1F2937;
    font-family: 'Rubik', sans-serif;
  }
  .oqr-modal-buttons { display: flex; gap: 0.75rem; justify-content: flex-end; }
  .oqr-modal-btn {
    padding: 0.6rem 1.25rem;
    border: none;
    border-radius: 0.4rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    font-family: 'Rubik', sans-serif;
    transition: all 0.2s;
  }
  .oqr-modal-btn-secondary { background: #F1F5F9; color: #374151; }
  .oqr-modal-btn-secondary:hover { background: var(--light, #E2E8F0); }
  .oqr-modal-btn-primary { background: var(--amber, #E07B00); color: var(--navy, #0D1B2E); }
  .oqr-modal-btn-primary:hover { background: #C46B00; }

  @media (max-width: 768px) {
    .oqr-header { flex-direction: column; align-items: flex-start; gap: 1rem; }
    .oqr-h1 { font-size: 1.75rem; }
    .summary-cards { grid-template-columns: repeat(2, 1fr); }
  }
`;
