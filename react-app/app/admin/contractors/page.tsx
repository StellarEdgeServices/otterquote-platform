'use client';

/**
 * Admin Contractors — D-211 Phase 8 (PR 2/2). Port of admin-contractors.html → the
 * React /admin/contractors route. Wrapped by <RequireAdmin tier="super"> (the
 * ADMIN_EMAILS allow-list, matching middleware.ts + AuthProvider) + <AdminNav> — the
 * static page's single-hardcoded-email gate + inline D-180 nav bar are replaced by the
 * shared shell (a deliberate, edge-gate-consistent parity choice; we do NOT re-check
 * email in the page).
 *
 * Init order mirrors the static init(): contractors → summary (derived) → cron health
 * → waitlist. All mutations route through the admin-contractor-action EF / RPCs with
 * UNCHANGED contracts (the page never writes contractors privilege columns directly).
 *
 * §6.1 Phase-8 XSS fold: the static renderContractors() interpolated contractor-
 * controlled values into an HTML string and into onclick="…('${…}')" handlers. This
 * port renders every value as JSX text (React-escaped) and wires every action as an
 * onClick closure over the contractor object — zero innerHTML/dangerouslySetInnerHTML,
 * zero string-built handlers.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { RequireAdmin } from '../_shell/RequireAdmin';
import { AdminNav } from '../_shell/AdminNav';
import { ContractorCard } from './ContractorCard';
import { MonitoringPanel } from './MonitoringPanel';
import { WaitlistPanel } from './WaitlistPanel';
import { RejectModal, InsuranceModal, ApproveConfirmModal } from './modals';
import {
  type Contractor,
  type ContractorFilter,
  type CronRow,
  type PlatformAlert,
  type WaitlistRow,
  CONTRACTOR_FILTERS,
  summaryCounts,
  filterContractors,
  deriveLicenseBoardState,
  licenseBoardUrl,
  markLicenseVerifiedPayload,
  markInsuranceVerifiedPayload,
  saveNotesPayload,
  sendInsuranceVerificationPayload,
  approvePayload,
  rejectPayload,
} from './utils';

type ModalKind = 'reject' | 'insurance' | 'approve' | null;

export default function AdminContractorsPage() {
  return (
    <RequireAdmin tier="super">
      <AdminContractorsContent />
    </RequireAdmin>
  );
}

function AdminContractorsContent() {
  const { signOut } = useAuth();
  const router = useRouter();

  // ── Contractors ──
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ContractorFilter>('pending_approval');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // ── Modals ──
  const [modal, setModal] = useState<ModalKind>(null);
  const [modalContractor, setModalContractor] = useState<Contractor | null>(null);

  // ── Platform monitoring ──
  const [cronOpen, setCronOpen] = useState(false);
  const [cronRows, setCronRows] = useState<CronRow[]>([]);
  const [alerts, setAlerts] = useState<PlatformAlert[]>([]);
  const [cronLoading, setCronLoading] = useState(true);
  const [cronError, setCronError] = useState<string | null>(null);

  // ── Expansion waitlist ──
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [waitlistRows, setWaitlistRows] = useState<WaitlistRow[]>([]);
  const [waitlistLoading, setWaitlistLoading] = useState(true);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [waitlistRefreshed, setWaitlistRefreshed] = useState('');

  // ── Loaders (mirror init(): contractors → cron → waitlist) ──
  async function loadContractors() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('contractors')
        .select('*, contractor_licenses(id, municipality, license_number)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setContractors((data || []) as Contractor[]);
      setLoadError(null);
    } catch (err) {
      console.error('Error loading contractors:', err);
      setLoadError('Failed to load contractors');
      if (typeof window !== 'undefined') window.alert('Failed to load contractors');
    } finally {
      setLoading(false);
    }
  }

  async function loadCronHealth() {
    setCronLoading(true);
    setCronError(null);
    try {
      const { data: rows, error: cronErr } = await supabase
        .from('cron_health')
        .select('*')
        .order('job_name', { ascending: true });
      if (cronErr) throw cronErr;

      const { data: alertRows, error: alertErr } = await supabase
        .from('platform_alerts_log')
        .select('*')
        .is('acknowledged_at', null)
        .order('sent_at', { ascending: false })
        .limit(50);
      if (alertErr) throw alertErr;

      setCronRows((rows || []) as CronRow[]);
      setAlerts((alertRows || []) as PlatformAlert[]);
    } catch (err) {
      console.error('loadCronHealth error:', err);
      setCronError('Failed to load monitoring data: ' + String(err));
    } finally {
      setCronLoading(false);
    }
  }

  async function loadWaitlist() {
    setWaitlistLoading(true);
    setWaitlistError(null);
    try {
      const { data, error } = await supabase
        .from('expansion_waitlist')
        .select('state, opted_in, created_at')
        .order('state', { ascending: true });
      if (error) throw error;
      setWaitlistRows((data || []) as WaitlistRow[]);
      setWaitlistRefreshed(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('loadWaitlistStats error:', err);
      setWaitlistError('Failed to load waitlist data.');
    } finally {
      setWaitlistLoading(false);
    }
  }

  useEffect(() => {
    void loadContractors();
    void loadCronHealth();
    void loadWaitlist();
    // RequireAdmin only mounts this once auth is settled + authorized, so a single
    // mount-time load mirrors init(). Loaders are stable (module-level supabase).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived ──
  const summary = summaryCounts(contractors);
  const filtered = filterContractors(contractors, filter);

  // ── Card expand/collapse ──
  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── Mutations (admin-contractor-action EF / RPCs — UNCHANGED contracts) ──
  function patchContractor(id: string, patch: Partial<Contractor>) {
    setContractors((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  async function handleMarkLicenseVerified(c: Contractor) {
    try {
      const { error } = await supabase.functions.invoke('admin-contractor-action', {
        body: markLicenseVerifiedPayload(c.id),
      });
      if (error) throw error;
      patchContractor(c.id, { license_verified: true, license_verified_at: new Date().toISOString() });
      window.alert('License marked as verified');
    } catch (err) {
      console.error('Error marking license verified:', err);
      window.alert('Failed to mark license as verified');
    }
  }

  async function handleMarkInsuranceVerified(c: Contractor) {
    try {
      const { error } = await supabase.functions.invoke('admin-contractor-action', {
        body: markInsuranceVerifiedPayload(c.id),
      });
      if (error) throw error;
      patchContractor(c.id, { insurance_verified: true, insurance_verified_at: new Date().toISOString() });
      window.alert('Insurance marked as verified');
    } catch (err) {
      console.error('Error marking insurance verified:', err);
      window.alert('Failed to mark insurance as verified');
    }
  }

  async function handleSaveNotes(c: Contractor, notes: string): Promise<boolean> {
    try {
      const { error } = await supabase.functions.invoke('admin-contractor-action', {
        body: saveNotesPayload(c.id, notes),
      });
      if (error) throw error;
      patchContractor(c.id, { admin_notes: notes });
      return true;
    } catch (err) {
      console.error('Error saving notes:', err);
      return false;
    }
  }

  function handleSearchLicenseBoard(c: Contractor) {
    const url = licenseBoardUrl(deriveLicenseBoardState(c), c.contact_name || '');
    if (typeof window !== 'undefined') window.open(url, '_blank');
  }

  // ── Modal open/close ──
  function openModal(kind: Exclude<ModalKind, null>, c: Contractor) {
    setModalContractor(c);
    setModal(kind);
  }
  function closeModal() {
    setModal(null);
    setModalContractor(null);
  }

  // ── Modal submits (return error string for inline display, null on success) ──
  async function submitReject(c: Contractor, reason: string): Promise<string | null> {
    try {
      const { error } = await supabase.functions.invoke('admin-contractor-action', {
        body: rejectPayload(c.id, reason),
      });
      if (error) throw error;
      patchContractor(c.id, { status: 'inactive', rejected_at: new Date().toISOString(), rejection_reason: reason });
      closeModal();
      window.alert('Application rejected');
      return null;
    } catch (err) {
      console.error('Error rejecting contractor:', err);
      return 'Failed to reject application';
    }
  }

  async function submitInsurance(c: Contractor, brokerEmail: string): Promise<string | null> {
    try {
      const { error } = await supabase.functions.invoke('admin-contractor-action', {
        body: sendInsuranceVerificationPayload(c.id, brokerEmail, c.company_name),
      });
      if (error) throw error;
      patchContractor(c.id, {
        insurance_verification_sent_at: new Date().toISOString(),
        insurance_verification_email: brokerEmail,
      });
      closeModal();
      window.alert('Insurance verification email sent');
      return null;
    } catch (err) {
      console.error('Error sending insurance verification:', err);
      return 'Failed to send verification email';
    }
  }

  async function submitApprove(c: Contractor): Promise<string | null> {
    try {
      // D-210: gate on contractor_has_required_docs() FIRST (RPC contract UNCHANGED).
      const { data: hasRequiredDocs, error: rpcError } = await supabase.rpc('contractor_has_required_docs', {
        p_contractor_id: c.id,
      });
      if (rpcError) throw rpcError;
      if (!hasRequiredDocs) {
        return 'This contractor is missing required documents. Approval blocked.';
      }

      const { error } = await supabase.functions.invoke('admin-contractor-action', {
        body: approvePayload(c.id),
      });
      if (error) throw error;

      patchContractor(c.id, { status: 'active', approved_at: new Date().toISOString() });
      closeModal();
      const w = typeof window !== 'undefined' ? (window as { gtag?: (...a: unknown[]) => void }) : undefined;
      if (w && typeof w.gtag === 'function') {
        w.gtag('event', 'contractor_approved', { contractor_id: c.id });
      }
      window.alert('Contractor approved and welcome email sent');
      return null;
    } catch (err) {
      console.error('Error approving contractor:', err);
      return 'Failed to approve contractor. Please try again.';
    }
  }

  // ── Platform-health-check EF + acknowledge_alert RPC (UNCHANGED contracts) ──
  async function runHealthCheck(): Promise<number> {
    const { data, error } = await supabase.functions.invoke('platform-health-check', { body: {} });
    if (error) throw error;
    const total =
      data && typeof (data as { totalAlerts?: unknown }).totalAlerts === 'number'
        ? (data as { totalAlerts: number }).totalAlerts
        : 0;
    await loadCronHealth();
    return total;
  }

  async function acknowledgeAlert(alertId: string) {
    try {
      const { error } = await supabase.rpc('acknowledge_alert', { p_id: alertId });
      if (error) throw error;
      await loadCronHealth();
    } catch (err) {
      console.error('acknowledgeAlert error:', err);
      window.alert('Failed to acknowledge alert');
    }
  }

  // ── Logout → React /login (signOut then navigate, mirroring the static flow) ──
  async function handleLogout() {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  }

  return (
    <main className="oqac-main">
      <style>{STYLES}</style>

      {/* Header */}
      <div className="oqac-header">
        <div className="oqac-title">
          <h1 className="oqac-h1">Admin Portal</h1>
          <span className="oqac-badge">ADMIN</span>
        </div>
        <button type="button" className="oqac-logout" onClick={handleLogout}>
          Log Out
        </button>
      </div>

      {/* Admin nav (replaces the inline D-180 nav bar) */}
      <div className="oqac-nav-wrap">
        <AdminNav active="contractors" />
      </div>

      {/* Summary cards */}
      <div className="oqac-summary-cards">
        <SummaryCard label="Pending Review" value={summary.pending} />
        <SummaryCard label="Active Contractors" value={summary.active} />
        <SummaryCard label="Total Contractors" value={summary.total} />
        <SummaryCard
          label="⚠️ PC Template Nudge"
          value={summary.pcMigration}
          borderColor="#E07B00"
          labelColor="#92400e"
          valueColor="#d97706"
        />
        <SummaryCard
          label="⚠️ COI Missing / Expired"
          value={summary.coiMissing}
          borderColor="#dc2626"
          labelColor="#991b1b"
          valueColor="#b91c1c"
        />
        <SummaryCard
          label="COI Expiring ≤30d"
          value={summary.coiExpiring}
          borderColor="#E07B00"
          labelColor="#92400e"
          valueColor="#d97706"
        />
        <SummaryCard
          label="Waitlisted Homeowners"
          value={waitlistRows.length}
          borderColor="#0ea5e9"
          labelColor="#0c4a6e"
          valueColor="#0369a1"
        />
      </div>

      {/* Filter tabs */}
      <div className="oqac-filter-tabs">
        {CONTRACTOR_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={'oqac-filter-tab' + (filter === f.key ? ' is-active' : '')}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Contractors list */}
      <div className="oqac-list">
        {loading && contractors.length === 0 ? (
          <div className="oqac-loading">
            <div className="oqac-spin" />
          </div>
        ) : loadError ? (
          <p className="oqac-empty">{loadError}</p>
        ) : filtered.length === 0 ? (
          <p className="oqac-empty">No contractors to display</p>
        ) : (
          filtered.map((c) => (
            <ContractorCard
              key={c.id}
              contractor={c}
              expanded={expandedIds.has(c.id)}
              onToggleExpand={() => toggleExpand(c.id)}
              onMarkLicenseVerified={handleMarkLicenseVerified}
              onSearchLicenseBoard={handleSearchLicenseBoard}
              onRequestInsurance={(x) => openModal('insurance', x)}
              onMarkInsuranceVerified={handleMarkInsuranceVerified}
              onSaveNotes={handleSaveNotes}
              onApprove={(x) => openModal('approve', x)}
              onReject={(x) => openModal('reject', x)}
            />
          ))
        )}
      </div>

      {/* Platform Monitoring */}
      <MonitoringPanel
        open={cronOpen}
        onToggle={() => setCronOpen((v) => !v)}
        loading={cronLoading}
        error={cronError}
        cronRows={cronRows}
        alerts={alerts}
        onRunHealthCheck={runHealthCheck}
        onAcknowledge={acknowledgeAlert}
      />

      {/* Expansion Waitlist */}
      <WaitlistPanel
        open={waitlistOpen}
        onToggle={() => setWaitlistOpen((v) => !v)}
        loading={waitlistLoading}
        error={waitlistError}
        rows={waitlistRows}
        lastRefreshed={waitlistRefreshed}
        onRefresh={loadWaitlist}
      />

      {/* Modals */}
      {modal === 'reject' && modalContractor && (
        <RejectModal
          contractor={modalContractor}
          onSubmit={(reason) => submitReject(modalContractor, reason)}
          onClose={closeModal}
        />
      )}
      {modal === 'insurance' && modalContractor && (
        <InsuranceModal
          contractor={modalContractor}
          onSubmit={(email) => submitInsurance(modalContractor, email)}
          onClose={closeModal}
        />
      )}
      {modal === 'approve' && modalContractor && (
        <ApproveConfirmModal
          contractor={modalContractor}
          onSubmit={() => submitApprove(modalContractor)}
          onClose={closeModal}
        />
      )}
    </main>
  );
}

function SummaryCard({
  label,
  value,
  borderColor,
  labelColor,
  valueColor,
}: {
  label: string;
  value: number;
  borderColor?: string;
  labelColor?: string;
  valueColor?: string;
}) {
  return (
    <div className="oqac-summary-card" style={borderColor ? { borderLeft: `4px solid ${borderColor}` } : undefined}>
      <div className="oqac-summary-label" style={labelColor ? { color: labelColor } : undefined}>
        {label}
      </div>
      <div className="oqac-summary-value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
    </div>
  );
}

const STYLES = `
  .oqac-main { max-width: 1400px; margin: 0 auto; padding: 2rem 1.5rem; color: #1F2937; }
  .oqac-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem; gap: 1rem; flex-wrap: wrap; }
  .oqac-title { display: flex; align-items: center; gap: 1rem; }
  .oqac-h1 { font-family: 'Rubik', sans-serif; font-size: 2.5rem; color: var(--white,#FFFFFF); margin: 0; }
  .oqac-badge { background: var(--amber,#E07B00); color: var(--navy,#0D1B2E); padding: 0.4rem 0.8rem; border-radius: 0.5rem; font-weight: 700; font-size: 0.875rem; }
  .oqac-logout { background: var(--white,#FFFFFF); color: var(--navy,#0D1B2E); border: none; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; }
  .oqac-logout:hover { background: var(--light,#E2E8F0); }
  .oqac-nav-wrap { margin-bottom: 1.5rem; }

  .oqac-summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
  .oqac-summary-card { background: var(--white,#FFFFFF); border-radius: 0.75rem; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .oqac-summary-label { font-size: 0.875rem; color: var(--slate,#8A9BAB); margin-bottom: 0.5rem; }
  .oqac-summary-value { font-size: 2.5rem; font-weight: 700; color: var(--navy,#0D1B2E); }

  .oqac-filter-tabs { display: flex; gap: 1rem; margin-bottom: 2rem; border-bottom: 2px solid rgba(255,255,255,0.1); flex-wrap: wrap; }
  .oqac-filter-tab { background: transparent; color: var(--slate,#8A9BAB); border: none; padding: 1rem 1.5rem; cursor: pointer; font-weight: 600; font-size: 1rem; border-bottom: 3px solid transparent; }
  .oqac-filter-tab.is-active { color: var(--white,#FFFFFF); border-bottom-color: var(--amber,#E07B00); }

  .oqac-list { min-height: 4rem; }
  .oqac-empty { color: var(--slate,#8A9BAB); text-align: center; padding: 2rem; }
  .oqac-loading { display: flex; align-items: center; justify-content: center; padding: 3rem; }
  .oqac-spin { width: 28px; height: 28px; border: 3px solid rgba(224,123,0,0.2); border-top-color: var(--amber,#E07B00); border-radius: 50%; animation: oqac-spin .8s linear infinite; }
  @keyframes oqac-spin { to { transform: rotate(360deg); } }

  .oqac-card { background: var(--white,#FFFFFF); border-radius: 0.75rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; }
  .oqac-card-header { background: var(--navy,#0D1B2E); color: var(--white,#FFFFFF); padding: 1.5rem; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .oqac-card-header:hover { background: #1a2944; }
  .oqac-header-left { flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1.5rem; }
  .oqac-header-cell { display: flex; flex-direction: column; gap: 0.25rem; }
  .oqac-header-cell-label { font-size: 0.75rem; color: var(--light,#E2E8F0); text-transform: uppercase; }
  .oqac-header-cell-value { font-weight: 600; font-size: 1rem; }
  .oqac-header-badges { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: flex-start; }
  .oqac-status-badge { padding: 0.4rem 0.8rem; border-radius: 0.4rem; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; background: #9CA3AF; color: var(--white,#FFFFFF); }
  .oqac-status-pending_approval { background: var(--amber,#E07B00); color: var(--navy,#0D1B2E); }
  .oqac-status-active { background: var(--green,#10B981); color: var(--white,#FFFFFF); }
  .oqac-status-inactive { background: #9CA3AF; color: var(--white,#FFFFFF); }
  .oqac-trade-badge { background: #E5E7EB; color: var(--navy,#0D1B2E); padding: 0.25rem 0.6rem; border-radius: 0.3rem; font-size: 0.7rem; font-weight: 500; }
  .oqac-warn-badge { border-radius: 0.25rem; padding: 0.15rem 0.5rem; font-size: 0.7rem; font-weight: 600; }
  .oqac-warn-amber { background: #fef3c7; color: #92400e; border: 1px solid #E07B00; }
  .oqac-warn-red { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .oqac-caret { font-size: 1.2rem; }

  .oqac-doc-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; padding: 0 1.5rem; margin-top: 0.75rem; }
  .oqac-doc-badge { padding: 0.5rem; border-radius: 0.4rem; font-size: 0.8rem; font-weight: 600; }

  .oqac-card-body { padding: 1.5rem; display: none; }
  .oqac-card-body.is-expanded { display: block; }
  .oqac-section { margin-bottom: 2rem; }
  .oqac-section-title { font-weight: 700; font-size: 1.1rem; margin-bottom: 1rem; color: var(--navy,#0D1B2E); border-bottom: 2px solid var(--light,#E2E8F0); padding-bottom: 0.75rem; }
  .oqac-info-row { display: grid; grid-template-columns: 150px 1fr; gap: 1rem; margin-bottom: 0.75rem; align-items: start; }
  .oqac-info-label { font-weight: 600; color: var(--slate,#8A9BAB); font-size: 0.875rem; }
  .oqac-info-value { color: var(--navy,#0D1B2E); }
  .oqac-checklist { display: flex; flex-direction: column; gap: 0.75rem; }
  .oqac-checklist-item { display: flex; gap: 0.75rem; align-items: flex-start; color: var(--navy,#0D1B2E); }
  .oqac-checklist-icon { font-size: 1.2rem; flex-shrink: 0; }
  .oqac-license-record { background: var(--light,#E2E8F0); padding: 1rem; border-radius: 0.5rem; margin-bottom: 0.75rem; display: flex; justify-content: space-between; align-items: start; }
  .oqac-license-muni { font-weight: 600; color: var(--navy,#0D1B2E); margin-bottom: 0.25rem; }
  .oqac-license-num { font-size: 0.875rem; color: var(--slate,#8A9BAB); }
  .oqac-status-line { margin-top: 0.75rem; padding: 0.75rem; background: var(--light,#E2E8F0); border-radius: 0.4rem; font-size: 0.875rem; color: var(--navy,#0D1B2E); }
  .oqac-muted { color: var(--slate,#8A9BAB); }
  .oqac-button-row { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.75rem; }
  .oqac-btn-sm { padding: 0.5rem 1rem; border: 1px solid var(--light,#E2E8F0); background: var(--white,#FFFFFF); color: var(--navy,#0D1B2E); border-radius: 0.4rem; cursor: pointer; font-size: 0.875rem; font-weight: 600; }
  .oqac-btn-sm:hover { background: var(--light,#E2E8F0); }
  .oqac-btn-sm-primary { background: var(--amber,#E07B00); color: var(--navy,#0D1B2E); border: 1px solid var(--amber,#E07B00); }

  .oqac-notes { background: #FEF3C7; padding: 1.5rem; border-radius: 0.5rem; border-left: 4px solid var(--amber,#E07B00); }
  .oqac-notes-label { font-weight: 700; color: var(--navy,#0D1B2E); margin-bottom: 0.75rem; }
  .oqac-notes-textarea { width: 100%; min-height: 100px; padding: 0.75rem; border: 1px solid #BDB701; border-radius: 0.4rem; font-family: 'Rubik', sans-serif; font-size: 0.875rem; resize: vertical; box-sizing: border-box; }
  .oqac-notes-btn { margin-top: 0.75rem; background: var(--amber,#E07B00); color: var(--navy,#0D1B2E); padding: 0.5rem 1rem; border: none; border-radius: 0.4rem; font-weight: 600; cursor: pointer; }
  .oqac-notes-status { margin-top: 0.5rem; font-size: 0.875rem; }

  .oqac-actions-final { display: flex; gap: 1rem; margin-top: 2rem; padding-top: 1.5rem; border-top: 2px solid var(--light,#E2E8F0); }
  .oqac-btn-action { flex: 1; padding: 0.75rem 1.5rem; border: none; border-radius: 0.5rem; font-weight: 700; cursor: pointer; font-size: 1rem; }
  .oqac-btn-approve { background: var(--green,#10B981); color: var(--white,#FFFFFF); }
  .oqac-btn-reject { background: var(--red,#EF4444); color: var(--white,#FFFFFF); }

  /* Modals */
  .oqac-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; }
  .oqac-modal { background: var(--white,#FFFFFF); border-radius: 0.75rem; padding: 2rem; max-width: 500px; width: 90%; box-shadow: 0 10px 25px rgba(0,0,0,0.2); color: #1F2937; }
  .oqac-modal-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 1rem; color: var(--navy,#0D1B2E); }
  .oqac-modal-text { margin-bottom: 1.5rem; color: var(--navy,#0D1B2E); }
  .oqac-modal-field { margin-bottom: 1.5rem; }
  .oqac-modal-label { font-weight: 600; color: var(--navy,#0D1B2E); margin-bottom: 0.5rem; display: block; }
  .oqac-modal-readonly { padding: 0.75rem; background: var(--light,#E2E8F0); border-radius: 0.4rem; }
  .oqac-modal-input, .oqac-modal-textarea { width: 100%; padding: 0.75rem; border: 1px solid var(--light,#E2E8F0); border-radius: 0.4rem; font-family: 'Rubik', sans-serif; font-size: 0.875rem; box-sizing: border-box; }
  .oqac-modal-textarea { min-height: 100px; resize: vertical; }
  .oqac-modal-error { color: var(--red,#EF4444); font-size: 0.875rem; margin-top: 0.5rem; }
  .oqac-modal-buttons { display: flex; gap: 1rem; justify-content: flex-end; margin-top: 2rem; }
  .oqac-modal-btn { padding: 0.75rem 1.5rem; border: none; border-radius: 0.4rem; font-weight: 600; cursor: pointer; }
  .oqac-modal-btn-primary { background: var(--amber,#E07B00); color: var(--navy,#0D1B2E); }
  .oqac-modal-btn-secondary { background: var(--light,#E2E8F0); color: var(--navy,#0D1B2E); }
  .oqac-modal-btn:disabled { opacity: 0.6; cursor: default; }

  /* Monitoring + Waitlist panels (dark, on the navy page background) */
  .oqac-monitor, .oqac-waitlist { margin-top: 2rem; }
  .oqac-monitor-bar, .oqac-waitlist-bar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .oqac-monitor-toggle { display: flex; align-items: center; gap: 0.5rem; background: none; border: 1px solid #334155; color: #94a3b8; font-size: 0.875rem; font-weight: 600; padding: 0.6rem 1rem; border-radius: 0.5rem; cursor: pointer; letter-spacing: 0.03em; text-transform: uppercase; }
  .oqac-monitor-run { display: flex; align-items: center; gap: 0.4rem; background: #0D1B2E; border: 1px solid #E07B00; color: #E07B00; font-size: 0.8rem; font-weight: 600; padding: 0.5rem 0.9rem; border-radius: 0.5rem; cursor: pointer; }
  .oqac-monitor-run:disabled { opacity: 0.7; cursor: default; }
  .oqac-waitlist-refresh { display: flex; align-items: center; gap: 0.4rem; background: #0D1B2E; border: 1px solid #0ea5e9; color: #0ea5e9; font-size: 0.8rem; font-weight: 600; padding: 0.5rem 0.9rem; border-radius: 0.5rem; cursor: pointer; }
  .oqac-waitlist-refresh:disabled { opacity: 0.7; cursor: default; }
  .oqac-monitor-panel, .oqac-waitlist-panel { margin-top: 0.75rem; overflow-x: auto; color: #94a3b8; font-size: 0.875rem; }
`;
