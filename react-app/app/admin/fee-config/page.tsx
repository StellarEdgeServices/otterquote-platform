'use client';

/**
 * Admin Platform Fee Configuration — D-211 Phase 11. Port of admin-fee-config.html
 * → the React /admin/fee-config route.
 *
 * Wrapped by <RequireAdmin tier="super"> + <AdminNav active="fee-config">.
 *
 * AUDIT FOLD (anon-key, admin-fee-config.html:518) — FIXED BY CONSTRUCTION:
 * the static page hardcoded a bogus anon key (its JWT `ref` claim does not even
 * match its own SUPABASE_URL host) and built its own supabase.createClient().
 * This port imports the shared `supabase` singleton (app/lib/supabase.ts), which
 * reads NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY from env. There
 * is NO createClient() call and NO literal key in this page.
 *
 * GATE: the static page gated client-side on a single hardcoded email
 * (session.user.email === 'dustinstohler1@gmail.com'). That is replaced by the
 * shared auth shell (AuthProvider + RequireAdmin tier="super") — the same
 * deliberate parity choice made for admin-payouts (do NOT re-check email here).
 * See handoff for the super-allowlist vs platform_fee_config RLS divergence note.
 *
 * §6.1 XSS fold: the static renderTable() interpolated fee.state / fee.trade /
 * fee.fee_basis into row innerHTML and interpolated fee.id into
 * onclick="openEditModal(${fee.id})" / startDelete(...) handlers. This port
 * renders every DB value as JSX text (React-escaped) and wires every action as
 * an onClick closure over the row — zero innerHTML / dangerouslySetInnerHTML /
 * string-built handlers. (As a side effect this also fixes a latent static bug:
 * fee.id is a uuid, so the static unquoted `openEditModal(${fee.id})` was invalid
 * JS; the closure form here works for uuid ids.)
 *
 * ⚠️  LIVE FEE MATH: fee_pct is written exactly as entered (percent value, via
 * parseFloat) — never rounded or rescaled. See utils.buildFeePayload.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { RequireAdmin } from '../_shell/RequireAdmin';
import { AdminNav } from '../_shell/AdminNav';
import {
  type FeeConfigRow,
  type FeeSortColumn,
  type FeeSortState,
  TRADE_OPTIONS,
  FEE_BASIS_OPTIONS,
  nextSortState,
  sortFees,
  feeBasisLabel,
  formatEffectiveDate,
  isLastRule,
  parseFeePct,
  isFeePctValid,
  buildFeePayload,
} from './utils';

export default function AdminFeeConfigPage() {
  return (
    <RequireAdmin tier="super">
      <AdminFeeConfigContent />
    </RequireAdmin>
  );
}

function AdminFeeConfigContent() {
  const { signOut } = useAuth();
  const router = useRouter();

  const [allFees, setAllFees] = useState<FeeConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sort, setSort] = useState<FeeSortState>({ column: 'state', ascending: true });

  // Add/Edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [stateInput, setStateInput] = useState('');
  const [tradeInput, setTradeInput] = useState('');
  const [feePctInput, setFeePctInput] = useState('');
  const [feeBasisInput, setFeeBasisInput] = useState('bid_amount');
  const [effectiveDateInput, setEffectiveDateInput] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  // Delete-confirm modal state (holds the id pending deletion)
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Transient banner timers (auto-hide after 5s, matching the static page)
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showSuccess(message: string) {
    setSuccessMsg(message);
    if (successTimer.current) clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => setSuccessMsg(null), 5000);
  }

  function showError(message: string) {
    setErrorMsg(message);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setErrorMsg(null), 5000);
  }

  useEffect(
    () => () => {
      if (successTimer.current) clearTimeout(successTimer.current);
      if (errorTimer.current) clearTimeout(errorTimer.current);
    },
    [],
  );

  // ── Loader ──────────────────────────────────────────────────────────────────

  async function loadFees() {
    setLoading(true);
    const { data, error } = await supabase
      .from('platform_fee_config')
      .select('*')
      .order('state', { ascending: true, nullsFirst: false })
      .order('trade', { ascending: true, nullsFirst: false });

    if (error) {
      console.error('Error loading fees:', error);
      showError('Failed to load fee configuration: ' + error.message);
      setAllFees([]);
    } else {
      setAllFees((data || []) as FeeConfigRow[]);
    }
    setLoading(false);
  }

  useEffect(() => {
    // RequireAdmin only mounts this content once auth is settled + authorized.
    void loadFees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sorting ───────────────────────────────────────────────────────────────

  function handleSort(column: FeeSortColumn) {
    setSort((prev) => nextSortState(prev, column));
  }

  const sortedFees = sortFees(allFees, sort.column, sort.ascending);

  // ── Add / Edit modal ──────────────────────────────────────────────────────

  function openAddModal() {
    setEditingId(null);
    setStateInput('');
    setTradeInput('');
    setFeePctInput('');
    setFeeBasisInput('bid_amount');
    setEffectiveDateInput(new Date().toISOString().split('T')[0]);
    setModalError(null);
    setModalOpen(true);
  }

  function openEditModal(fee: FeeConfigRow) {
    setEditingId(fee.id);
    setStateInput(fee.state || '');
    setTradeInput(fee.trade || '');
    setFeePctInput(String(fee.fee_pct));
    setFeeBasisInput(fee.fee_basis);
    setEffectiveDateInput(String(fee.effective_date));
    setModalError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
  }

  async function handleSaveRule(event: React.FormEvent) {
    event.preventDefault();

    const feePct = parseFeePct(feePctInput);
    if (!isFeePctValid(feePct)) {
      setModalError('Fee must be between 0 and 50');
      return;
    }

    const payload = buildFeePayload({
      state: stateInput,
      trade: tradeInput,
      feePct,
      feeBasis: feeBasisInput,
      effectiveDate: effectiveDateInput,
    });

    try {
      const result = editingId
        ? await supabase.from('platform_fee_config').update(payload).eq('id', editingId)
        : await supabase.from('platform_fee_config').insert([payload]);

      if (result.error) throw result.error;

      const wasEditing = editingId !== null;
      closeModal();
      showSuccess(wasEditing ? 'Fee rule updated successfully' : 'Fee rule added successfully');
      await loadFees();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Error saving rule:', err);
      setModalError('Failed to save rule: ' + message);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  function startDelete(id: string) {
    setDeletingId(id);
  }

  function closeDeleteModal() {
    setDeletingId(null);
  }

  async function confirmDelete() {
    if (!deletingId) return;
    // At least one rule must always exist (mirrors the static guard).
    if (isLastRule(allFees.length)) return;

    try {
      const result = await supabase
        .from('platform_fee_config')
        .delete()
        .eq('id', deletingId);

      if (result.error) throw result.error;

      closeDeleteModal();
      showSuccess('Fee rule deleted successfully');
      await loadFees();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Error deleting rule:', err);
      showError('Failed to delete rule: ' + message);
    }
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async function handleLogout() {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const lastRule = isLastRule(allFees.length);

  return (
    <main className="oqfc-main">
      <style>{STYLES}</style>

      {/* Header */}
      <div className="oqfc-header">
        <div className="oqfc-title">
          <span className="oqfc-badge">ADMIN</span>
          <h1 className="oqfc-h1">Platform Fee Configuration</h1>
        </div>
        <button type="button" className="oqfc-logout" onClick={handleLogout}>
          Logout
        </button>
      </div>

      {/* Admin nav */}
      <div className="oqfc-nav-wrap">
        <AdminNav active="fee-config" />
      </div>

      {/* Transient banners */}
      {successMsg !== null && <div className="oqfc-alert oqfc-alert-success">{successMsg}</div>}
      {errorMsg !== null && <div className="oqfc-alert oqfc-alert-error">{errorMsg}</div>}

      {/* Section header */}
      <div className="oqfc-section-header">
        <h2>Fee Rules</h2>
        <button type="button" className="oqfc-add-btn" onClick={openAddModal}>
          + Add Fee Rule
        </button>
      </div>

      {/* Table */}
      <div className="oqfc-table-wrapper">
        {loading ? (
          <div className="oqfc-loading">
            <div className="oqfc-spinner" />
            <p>Loading fee configuration…</p>
          </div>
        ) : allFees.length === 0 ? (
          <div className="oqfc-empty-state">
            <p>No fee rules configured yet.</p>
            <button type="button" className="oqfc-add-btn" onClick={openAddModal}>
              + Add Fee Rule
            </button>
          </div>
        ) : (
          <table className="oqfc-table">
            <thead>
              <tr>
                <th onClick={() => handleSort('state')}>State</th>
                <th onClick={() => handleSort('trade')}>Trade</th>
                <th onClick={() => handleSort('fee_pct')}>Fee %</th>
                <th onClick={() => handleSort('fee_basis')}>Basis</th>
                <th onClick={() => handleSort('effective_date')}>Effective Date</th>
                <th style={{ width: '150px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedFees.map((fee) => (
                <tr key={fee.id}>
                  <td>
                    {fee.state ? (
                      fee.state
                    ) : (
                      <span className="oqfc-default-badge">All States</span>
                    )}
                  </td>
                  <td>
                    {fee.trade ? (
                      fee.trade
                    ) : (
                      <span className="oqfc-default-badge">All Trades</span>
                    )}
                  </td>
                  <td>{fee.fee_pct}%</td>
                  <td>{feeBasisLabel(fee.fee_basis)}</td>
                  <td>{formatEffectiveDate(fee.effective_date)}</td>
                  <td>
                    <div className="oqfc-actions-cell">
                      <button
                        type="button"
                        className="oqfc-edit-btn"
                        onClick={() => openEditModal(fee)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="oqfc-delete-btn"
                        disabled={lastRule}
                        onClick={() => startDelete(fee.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add / Edit modal */}
      {modalOpen && (
        <div
          className="oqfc-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="oqfc-modal">
            <h3>{editingId ? 'Edit Fee Rule' : 'Add Fee Rule'}</h3>
            {modalError !== null && (
              <div className="oqfc-alert oqfc-alert-error">{modalError}</div>
            )}
            <form onSubmit={handleSaveRule}>
              <div className="oqfc-form-group">
                <label htmlFor="oqfc-state">State (leave blank for all states)</label>
                <input
                  id="oqfc-state"
                  type="text"
                  maxLength={2}
                  placeholder="e.g., IN, OH, KY"
                  style={{ textTransform: 'uppercase' }}
                  value={stateInput}
                  onChange={(e) => setStateInput(e.target.value)}
                />
              </div>

              <div className="oqfc-form-group">
                <label htmlFor="oqfc-trade">Trade (leave blank for all trades)</label>
                <select
                  id="oqfc-trade"
                  value={tradeInput}
                  onChange={(e) => setTradeInput(e.target.value)}
                >
                  {TRADE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="oqfc-form-group">
                <label htmlFor="oqfc-feepct">Fee % (0-50)</label>
                <input
                  id="oqfc-feepct"
                  type="number"
                  min={0}
                  max={50}
                  step={0.01}
                  required
                  placeholder="e.g., 15.5"
                  value={feePctInput}
                  onChange={(e) => setFeePctInput(e.target.value)}
                />
              </div>

              <div className="oqfc-form-group">
                <label htmlFor="oqfc-basis">Fee Basis</label>
                <select
                  id="oqfc-basis"
                  value={feeBasisInput}
                  onChange={(e) => setFeeBasisInput(e.target.value)}
                >
                  {FEE_BASIS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="oqfc-form-group">
                <label htmlFor="oqfc-date">Effective Date</label>
                <input
                  id="oqfc-date"
                  type="date"
                  required
                  value={effectiveDateInput}
                  onChange={(e) => setEffectiveDateInput(e.target.value)}
                />
              </div>

              <div className="oqfc-form-actions">
                <button type="submit" className="oqfc-btn oqfc-btn-primary">
                  {editingId ? 'Update Rule' : 'Save Rule'}
                </button>
                <button
                  type="button"
                  className="oqfc-btn oqfc-btn-secondary"
                  onClick={closeModal}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deletingId !== null && (
        <div
          className="oqfc-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDeleteModal();
          }}
        >
          <div className="oqfc-modal oqfc-modal-sm">
            <h3>Delete Fee Rule?</h3>
            <p className="oqfc-modal-text">
              Are you sure you want to delete this fee rule? This action cannot be undone.
            </p>
            {lastRule && (
              <div className="oqfc-alert oqfc-alert-info">
                This is the last remaining default rule. At least one rule must always exist.
              </div>
            )}
            <div className="oqfc-form-actions">
              <button
                type="button"
                className="oqfc-btn oqfc-btn-primary"
                disabled={lastRule}
                onClick={confirmDelete}
              >
                Delete
              </button>
              <button
                type="button"
                className="oqfc-btn oqfc-btn-secondary"
                onClick={closeDeleteModal}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ── Styles (themed to match the Phase-8+ admin shell: navy bg / amber accents) ─

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

  .oqfc-main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
    color: #1F2937;
    font-family: 'Rubik', sans-serif;
  }

  /* ── Header ──────────────────────────────────────────── */
  .oqfc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 2rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .oqfc-title { display: flex; align-items: center; gap: 1rem; }
  .oqfc-badge {
    background: var(--amber, #E07B00);
    color: var(--navy, #0D1B2E);
    padding: 0.4rem 0.8rem;
    border-radius: 0.5rem;
    font-weight: 700;
    font-size: 0.875rem;
  }
  .oqfc-h1 {
    font-size: 2rem;
    color: var(--white, #FFFFFF);
    margin: 0;
    font-family: 'Rubik', sans-serif;
  }
  .oqfc-logout {
    background: var(--white, #FFFFFF);
    color: var(--navy, #0D1B2E);
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    font-family: 'Rubik', sans-serif;
  }
  .oqfc-logout:hover { background: var(--light, #E2E8F0); }
  .oqfc-nav-wrap { margin-bottom: 2rem; }

  /* ── Alerts ──────────────────────────────────────────── */
  .oqfc-alert {
    padding: 1rem;
    border-radius: 0.5rem;
    margin-bottom: 1rem;
    font-size: 0.9375rem;
  }
  .oqfc-alert-error   { background: #FEE2E2; color: #991B1B; border: 1px solid #FECACA; }
  .oqfc-alert-success { background: #DCFCE7; color: #166534; border: 1px solid #BBF7D0; }
  .oqfc-alert-info    { background: #DBEAFE; color: #1E40AF; border: 1px solid #BFDBFE; }

  /* ── Section header ──────────────────────────────────── */
  .oqfc-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .oqfc-section-header h2 {
    font-size: 1.5rem;
    color: var(--white, #FFFFFF);
    font-weight: 600;
    margin: 0;
  }
  .oqfc-add-btn {
    background: var(--amber, #E07B00);
    color: var(--navy, #0D1B2E);
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9375rem;
    font-family: 'Rubik', sans-serif;
  }
  .oqfc-add-btn:hover { background: #C46B00; }

  /* ── Table ───────────────────────────────────────────── */
  .oqfc-table-wrapper {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  .oqfc-table { width: 100%; border-collapse: collapse; }
  .oqfc-table thead { background: #F1F5F9; border-bottom: 2px solid var(--light, #E2E8F0); }
  .oqfc-table th {
    padding: 1rem;
    text-align: left;
    font-weight: 600;
    color: var(--navy, #0D1B2E);
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    user-select: none;
  }
  .oqfc-table th:hover { background: var(--light, #E2E8F0); }
  .oqfc-table td {
    padding: 1rem;
    font-size: 0.9375rem;
    border-bottom: 1px solid var(--light, #E2E8F0);
    color: #374151;
  }
  .oqfc-table tbody tr:hover { background: #F8FAFC; }

  .oqfc-default-badge {
    display: inline-block;
    background: #DBEAFE;
    color: #1E40AF;
    padding: 0.25rem 0.625rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  /* ── Action buttons ──────────────────────────────────── */
  .oqfc-actions-cell { display: flex; gap: 0.5rem; align-items: center; }
  .oqfc-edit-btn, .oqfc-delete-btn {
    border: none;
    padding: 0.5rem 0.875rem;
    border-radius: 0.25rem;
    cursor: pointer;
    font-weight: 500;
    font-size: 0.8125rem;
    font-family: 'Rubik', sans-serif;
  }
  .oqfc-edit-btn   { background: var(--navy, #0D1B2E); color: var(--white, #FFFFFF); }
  .oqfc-edit-btn:hover { background: #1A3D5C; }
  .oqfc-delete-btn { background: var(--red, #EF4444); color: var(--white, #FFFFFF); }
  .oqfc-delete-btn:hover:not(:disabled) { background: #DC2626; }
  .oqfc-delete-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Loading / empty ─────────────────────────────────── */
  .oqfc-loading { text-align: center; padding: 2rem; color: #64748B; }
  .oqfc-spinner {
    display: inline-block;
    width: 30px;
    height: 30px;
    border: 3px solid var(--light, #E2E8F0);
    border-top-color: var(--amber, #E07B00);
    border-radius: 50%;
    animation: oqfc-spin 0.8s linear infinite;
  }
  @keyframes oqfc-spin { to { transform: rotate(360deg); } }
  .oqfc-empty-state { text-align: center; padding: 3rem 2rem; color: #64748B; }
  .oqfc-empty-state p { margin-bottom: 1rem; }

  /* ── Modal ───────────────────────────────────────────── */
  .oqfc-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .oqfc-modal {
    background: var(--white, #FFFFFF);
    border-radius: 0.75rem;
    padding: 2rem;
    max-width: 500px;
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }
  .oqfc-modal-sm { max-width: 400px; }
  .oqfc-modal h3 { margin: 0 0 1.5rem 0; color: var(--navy, #0D1B2E); font-size: 1.5rem; }
  .oqfc-modal-text { margin-bottom: 1.5rem; color: #475569; }

  .oqfc-form-group { margin-bottom: 1.5rem; }
  .oqfc-form-group label {
    display: block;
    margin-bottom: 0.5rem;
    color: var(--navy, #0D1B2E);
    font-weight: 600;
    font-size: 0.875rem;
  }
  .oqfc-form-group input,
  .oqfc-form-group select {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid #CBD5E1;
    border-radius: 0.5rem;
    font-size: 0.9375rem;
    font-family: inherit;
    box-sizing: border-box;
  }
  .oqfc-form-group input:focus,
  .oqfc-form-group select:focus {
    outline: none;
    border-color: var(--amber, #E07B00);
    box-shadow: 0 0 0 3px rgba(224,123,0,0.12);
  }

  .oqfc-form-actions { display: flex; gap: 1rem; margin-top: 2rem; }
  .oqfc-btn {
    flex: 1;
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 0.5rem;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9375rem;
    font-family: 'Rubik', sans-serif;
  }
  .oqfc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .oqfc-btn-primary { background: var(--amber, #E07B00); color: var(--navy, #0D1B2E); }
  .oqfc-btn-primary:hover:not(:disabled) { background: #C46B00; }
  .oqfc-btn-secondary { background: #CBD5E1; color: #1E293B; }
  .oqfc-btn-secondary:hover { background: #A1AFC9; }

  @media (max-width: 768px) {
    .oqfc-section-header { flex-direction: column; align-items: flex-start; }
    .oqfc-add-btn { width: 100%; }
    .oqfc-table { font-size: 0.8125rem; }
    .oqfc-table th, .oqfc-table td { padding: 0.75rem 0.5rem; }
    .oqfc-modal { max-width: 100%; }
  }
`;
