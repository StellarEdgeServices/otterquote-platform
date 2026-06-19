'use client';

/**
 * Contractor Dashboard — D-211 Phase 2 (port of contractor-dashboard.html, the
 * contractor-track hub). Wrapped by the reusable ContractorShell (auth +
 * contractor-role gate + nav). Reuses the shared auth scaffolding and the
 * contractor-track shell — does NOT re-implement auth or the CPA/pending gates.
 *
 * Tier-3 surfaces (gated to Dustin):
 *   - Verbatim D-230 CPA re-attestation + first-time CPA acceptance modal copy
 *     (in ./copy.ts, asserted byte-for-byte by the parity test).
 *   - Live Edge Function calls (contracts unchanged): mark-job-complete,
 *     record-warranty-upload, send-message-notification (in <Messaging/>).
 *
 * Folded client-side audit findings (§6.1):
 *   - [critical] dead "Retry Payment Now": the static button wrote
 *     payment_failures.dunning_status='retried', which the DB CHECK rejects
 *     ('retried' is not an allowed state) AND relies on a self-resolve RLS hole.
 *     Folded → the dunning banner is read-only (alert + "Update Card" → settings);
 *     no client write. (The RLS hole itself is a Tier-3 SQL item, gated separately.)
 *   - duplicate messaging blocks / dead Netlify EF URL → single <Messaging/>.
 *   - normalized auth-failure redirect → handled by ContractorShell (/contractor/login).
 */

import { useEffect, useMemo, useState } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { ContractorShell } from '../_shell/ContractorShell';
import { useContractorRecord } from '../_shell/use-contractor-record';
import { CURRENT_CPA_VERSION, shouldShowCpaModal, clearCpaRedirectGuard } from '../_shell/cpa-guard';
import { isPendingApproval } from '../_shell/contractor-gating';
import { DASHBOARD_COPY as C, QUICK_LINKS } from './copy';
import { useDashboardData, type ActiveProject } from './use-dashboard-data';
import { Messaging } from './Messaging';
import {
  activityDotColor, calculateProfileCompletion, efUrl, formatEarnings,
  profileChecklist, serviceAreaDisplay, type ChecklistContractor,
  PROFILE_URL, SETTINGS_URL, SETTINGS_PAYMENT_URL,
} from './utils';

export default function ContractorDashboardPage() {
  return (
    <ContractorShell active="home">
      <DashboardContent />
    </ContractorShell>
  );
}

function DashboardContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;
  const { contractor, loading: contractorLoading, refetch } = useContractorRecord(userId);
  const data = useDashboardData(contractor, userId);

  // Local copy of projects so EF successes can update rows in place.
  const [projects, setProjects] = useState<ActiveProject[]>([]);
  useEffect(() => { setProjects(data.activeProjects); }, [data.activeProjects]);

  // pending_approval also honored via URL param (parity with the static page).
  const pendingParam = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('msg') === 'pending_approval';
  }, []);

  if (contractorLoading || !contractor) {
    return <div className="oqd-loading"><div className="oqd-spin" /><style>{STYLES}</style></div>;
  }

  const pending = pendingParam || isPendingApproval(contractor);
  const showAgreement = !contractor.agreement_accepted_at;
  const showCpa = shouldShowCpaModal(contractor);
  const { completedCount, totalSteps } = calculateProfileCompletion(contractor as unknown as ChecklistContractor);
  const showChecklist = completedCount < totalSteps;
  const counties = serviceAreaDisplay(contractor.service_counties);

  return (
    <div className="oqd-wrap">
      <style>{STYLES}</style>

      <div className="oqd-hero">
        <h1>{C.welcomePrefix}{contractor.company_name ? `, ${contractor.company_name}` : ''}</h1>
        <p>{counties.length ? C.serviceAreaPrefix + counties.join(', ') : C.serviceAreaNone}</p>
      </div>

      {/* Dunning — read-only (folded [critical] dead retry path) */}
      {data.dunning && (
        <div className="oqd-dunning" role="alert">
          <span aria-hidden="true" className="oqd-dunning-icon">🚨</span>
          <div>
            <div className="oqd-dunning-title">{C.dunningTitle}</div>
            <p className="oqd-dunning-msg">
              {C.dunningOverduePrefix}${(data.dunning.amountCents / 100).toFixed(2)}{C.dunningOverdueSuffix}
            </p>
            <a className="oqd-btn oqd-btn-danger" href={SETTINGS_URL}>{C.dunningUpdateCard}</a>
          </div>
        </div>
      )}

      {pending && (
        <div className="oqd-pending">
          <p>{C.pendingBanner}</p>
          <div className="oqd-pending-actions">
            <a className="oqd-btn oqd-btn-secondary" href={PROFILE_URL}>{C.pendingCompleteProfile}</a>
            <a className="oqd-btn oqd-btn-secondary" href={SETTINGS_PAYMENT_URL}>{C.pendingAddPayment}</a>
          </div>
        </div>
      )}

      {showChecklist && (
        <section className="oqd-card">
          <h2 className="oqd-card-title">{C.gettingStartedHeading}</h2>
          <div className="oqd-checklist">
            {profileChecklist(contractor as unknown as ChecklistContractor).map((item) => (
              <div className="oqd-check" key={item.key}>
                <span className="oqd-check-icon">{item.done ? '✅' : '⬜'}</span>
                <div>
                  <div className="oqd-check-label">{C.checklistLabels[item.key]}</div>
                  {!item.done && <a className="oqd-check-link" href={item.link}>{C.checklistComplete}</a>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Stats */}
      <div className="oqd-stats">
        <StatCard label={C.statAvailable} value={data.loading ? '—' : String(data.stats.availableCount)}
          link={{ href: 'https://otterquote.com/contractor-opportunities.html', text: C.statViewAll }} />
        <StatCard label={C.statActiveBids} value={data.loading ? '—' : String(data.stats.activeBids)}
          link={{ href: '#oqd-bids', text: C.statManage }} />
        <StatCard label={C.statWonJobs} value={data.loading ? '—' : String(data.stats.wonJobs)} />
        <StatCard label={C.statEarnings} value={data.loading ? '—' : formatEarnings(data.stats.earnings)} />
      </div>

      {/* Submitted bids */}
      <h2 className="oqd-section" id="oqd-bids">{C.submittedBidsHeading}</h2>
      {data.pendingBids.length === 0 ? (
        <p className="oqd-empty">{C.emptyBids}</p>
      ) : (
        <table className="oqd-table">
          <thead><tr><th>Project Area</th><th>Damage Type</th><th>Your Bid</th><th>Submitted</th><th>Status</th></tr></thead>
          <tbody>
            {data.pendingBids.map((b) => (
              <tr key={b.quoteId}>
                <td>{b.location}</td><td>{b.damageType}</td><td>{b.bidAmount}</td>
                <td>{b.submittedDate}</td><td><span className="oqd-badge oqd-badge-pending">Pending Decision</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Active & won projects */}
      <h2 className="oqd-section">{C.projectsHeading}</h2>
      {projects.length === 0 ? (
        <p className="oqd-empty">{C.emptyProjects}</p>
      ) : (
        <table className="oqd-table">
          <thead><tr><th>Project ID</th><th>Location</th><th>Damage Type</th><th>Material</th><th>Est. Value</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {projects.map((p) => (
              <ProjectRow key={p.quoteId} project={p} onCompleted={(claimId, date) => {
                setProjects((rows) => rows.map((r) => r.fullId === claimId ? { ...r, status: 'Completed', completionDate: date } : r));
              }} onWarranty={(quoteId, url) => {
                setProjects((rows) => rows.map((r) => r.quoteId === quoteId ? { ...r, warrantyUrl: url } : r));
              }} />
            ))}
          </tbody>
        </table>
      )}

      {/* Activity */}
      <h2 className="oqd-section">{C.activityHeading}</h2>
      {data.activity.length === 0 ? (
        <p className="oqd-empty">{C.emptyActivity}</p>
      ) : (
        <div className="oqd-activity">
          {data.activity.map((a, i) => (
            <div className="oqd-activity-item" key={i}>
              <span className="oqd-dot" style={{ background: activityDotColor(a.type) }} />
              <div><div className="oqd-activity-text">{a.text}</div><div className="oqd-activity-time">{a.time}</div></div>
            </div>
          ))}
        </div>
      )}

      {/* Quick links */}
      <h2 className="oqd-section">{C.quickLinksHeading}</h2>
      <div className="oqd-links">
        {QUICK_LINKS.map((l) => (
          <a className="oqd-navcard" href={l.href} key={l.title}><span className="oqd-navcard-icon">{l.icon}</span><span>{l.title}</span></a>
        ))}
      </div>

      <Messaging userId={contractor.user_id} />

      {showAgreement && <AgreementModal contractor={contractor} onAccepted={refetch} />}
      {!showAgreement && showCpa && <CpaReacceptModal contractorId={contractor.id} userId={contractor.user_id} onAccepted={refetch} />}
    </div>
  );
}

function StatCard({ label, value, link }: { label: string; value: string; link?: { href: string; text: string } }) {
  return (
    <div className="oqd-stat">
      <span className="oqd-stat-label">{label}</span>
      <span className="oqd-stat-value">{value}</span>
      {link ? <a className="oqd-stat-link" href={link.href}>{link.text}</a> : <span className="oqd-stat-link oqd-stat-link-muted">—</span>}
    </div>
  );
}

// ── Active/won project row + Mark-Complete / Warranty EF flows ──
function ProjectRow({ project, onCompleted, onWarranty }: {
  project: ActiveProject;
  onCompleted: (claimId: string, completionDate: string) => void;
  onWarranty: (quoteId: string, url: string) => void;
}) {
  const [markOpen, setMarkOpen] = useState(false);
  const [warrantyOpen, setWarrantyOpen] = useState(false);

  return (
    <tr>
      <td>{project.id}</td>
      <td>{project.location}</td>
      <td>{project.damageType}</td>
      <td>{project.material}</td>
      <td>{project.estimatedValue}</td>
      <td>
        {project.status === 'Completed'
          ? <span className="oqd-badge oqd-badge-done">✅ Completed{project.completionDate ? ' ' + new Date(project.completionDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</span>
          : <span className="oqd-badge oqd-badge-won">{project.status}</span>}
      </td>
      <td>
        {project.needsSignature && (
          <a className="oqd-btn oqd-btn-sm oqd-btn-primary" href={`/contractor/sign/${project.fullId}`}>Sign Contract</a>
        )}
        {project.status !== 'Completed' && (
          <button type="button" className="oqd-btn oqd-btn-sm oqd-btn-success" onClick={() => setMarkOpen(true)}>Mark Complete</button>
        )}
        {project.status === 'Completed' && !project.warrantyUrl && (
          <button type="button" className="oqd-btn oqd-btn-sm oqd-btn-outline" onClick={() => setWarrantyOpen(true)}>📄 Upload Warranty</button>
        )}
        {project.status === 'Completed' && project.warrantyUrl && (
          <span className="oqd-warranty-ok">📄 Warranty: ✓</span>
        )}
      </td>
      {markOpen && (
        <MarkCompleteModal address={project.location} claimId={project.fullId}
          onClose={() => setMarkOpen(false)}
          onSuccess={(date) => { setMarkOpen(false); onCompleted(project.fullId, date); setWarrantyOpen(true); }} />
      )}
      {warrantyOpen && (
        <WarrantyModal quoteId={project.quoteId}
          onClose={() => setWarrantyOpen(false)}
          onSuccess={(url) => { setWarrantyOpen(false); onWarranty(project.quoteId, url); }} />
      )}
    </tr>
  );
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('No auth session');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

function MarkCompleteModal({ address, claimId, onClose, onSuccess }: {
  address: string; claimId: string; onClose: () => void; onSuccess: (completionDate: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const confirm = async () => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(efUrl('mark-job-complete'), { method: 'POST', headers: await authHeader(), body: JSON.stringify({ claim_id: claimId }) });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `Server error ${res.status}`);
      onSuccess(json.completion_date);
    } catch (e) {
      console.error('[dashboard] mark-job-complete error:', e);
      setErr(C.markComplete.error); setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} labelledBy="oqd-mc-title">
      <h3 id="oqd-mc-title" className="oqd-modal-title">{C.markComplete.title}</h3>
      <p className="oqd-modal-strong-line">{address}</p>
      <p className="oqd-modal-body">{C.markComplete.bodyPrefix}<strong>{C.markComplete.bodyStrong}</strong>{C.markComplete.bodySuffix}</p>
      {err && <p className="oqd-modal-error">{err}</p>}
      <div className="oqd-modal-actions">
        <button type="button" className="oqd-btn oqd-btn-secondary" onClick={onClose}>{C.markComplete.cancel}</button>
        <button type="button" className="oqd-btn oqd-btn-success" disabled={busy} onClick={confirm}>{busy ? C.markComplete.confirming : C.markComplete.confirm}</button>
      </div>
    </Modal>
  );
}

function WarrantyModal({ quoteId, onClose, onSuccess }: { quoteId: string; onClose: () => void; onSuccess: (url: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const upload = async () => {
    setErr('');
    if (!file) { setErr(C.warranty.errSelect); return; }
    if (file.type !== 'application/pdf') { setErr(C.warranty.errType); return; }
    if (file.size > 25 * 1024 * 1024) { setErr(C.warranty.errSize); return; }
    if (!quoteId) { setErr(C.warranty.errQuote); return; }
    setBusy(true);
    try {
      const headers = await authHeader();
      const ts = Date.now();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const bucketPath = `warranties/${quoteId}/${ts}-${safeName}`;
      const storagePath = `contractor-documents/${bucketPath}`;
      const { error: upErr } = await supabase.storage.from('contractor-documents').upload(bucketPath, file, { contentType: 'application/pdf', upsert: false });
      if (upErr) throw new Error(upErr.message || 'Storage upload failed');
      const res = await fetch(efUrl('record-warranty-upload'), { method: 'POST', headers, body: JSON.stringify({ quote_id: quoteId, storage_path: storagePath }) });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `Server error ${res.status}`);
      onSuccess(storagePath);
    } catch (e) {
      console.error('[dashboard] warranty upload error:', e);
      setErr(C.warranty.errUpload); setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} labelledBy="oqd-w-title">
      <h3 id="oqd-w-title" className="oqd-modal-title">{C.warranty.title}</h3>
      <p className="oqd-modal-body">{C.warranty.body}</p>
      <p className="oqd-modal-hint">{C.warranty.constraints}</p>
      <input type="file" accept="application/pdf" className="oqd-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {err && <p className="oqd-modal-error">{err}</p>}
      <div className="oqd-modal-actions">
        <button type="button" className="oqd-btn oqd-btn-secondary" onClick={onClose}>{C.warranty.skip}</button>
        <button type="button" className="oqd-btn oqd-btn-info" disabled={busy} onClick={upload}>{busy ? C.warranty.uploading : C.warranty.upload}</button>
      </div>
    </Modal>
  );
}

// ── Tier-3 verbatim-locked legal modals (copy in ./copy.ts) ──
function AgreementModal({ contractor, onAccepted }: { contractor: { id: string }; onAccepted: () => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    if (!checked) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const today = now.split('T')[0];
      const { error } = await supabase.from('contractors').update({
        agreement_accepted_at: now, agreement_version: today,
        cpa_version: CURRENT_CPA_VERSION, cpa_accepted_at: now, needs_cpa_reattestation: false,
      }).eq('id', contractor.id);
      if (error) throw error;
      onAccepted();
    } catch (e) {
      console.error('Error accepting agreement:', e);
      alert(C.cpaReacceptModal.errorGeneric); setBusy(false);
    }
  };
  const m = C.agreementModal;
  return (
    <Modal onClose={() => {}} labelledBy="oqd-ag-title" dismissable={false}>
      <h2 id="oqd-ag-title" className="oqd-modal-title">{m.title}</h2>
      <p className="oqd-modal-body">{m.intro}</p>
      <a className="oqd-modal-link" href="https://otterquote.com/contractor-agreement.html" target="_blank" rel="noreferrer">{m.readLink}</a>
      <label className="oqd-modal-check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {m.checkboxLabel}</label>
      <button type="button" className="oqd-btn oqd-btn-primary oqd-btn-full" disabled={!checked || busy} onClick={accept}>{m.accept}</button>
    </Modal>
  );
}

function CpaReacceptModal({ contractorId, userId, onAccepted }: { contractorId: string; userId: string; onAccepted: () => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const m = C.cpaReacceptModal;
  const accept = async () => {
    if (!checked) return;
    setBusy(true); setErr('');
    try {
      const now = new Date().toISOString();
      const { error } = await supabase.from('contractors').update({
        cpa_version: CURRENT_CPA_VERSION, cpa_accepted_at: now, needs_cpa_reattestation: false,
      }).eq('id', contractorId);
      if (error) { setErr(m.errorSave); setBusy(false); return; }
      try { await supabase.rpc('record_cpa_ip', { p_contractor_id: contractorId }); } catch (e) { console.warn('record_cpa_ip failed (non-fatal):', e); }
      try {
        await supabase.from('activity_log').insert({
          user_id: userId, event_type: 'cpa_accepted',
          title: `Accepted updated Contractor Partner Agreement (${CURRENT_CPA_VERSION})`, created_at: now,
        });
      } catch (e) { console.warn('activity_log failed (non-fatal):', e); }
      clearCpaRedirectGuard();
      onAccepted();
    } catch (e) {
      console.error('CPA re-acceptance error:', e);
      setErr(m.errorGeneric); setBusy(false);
    }
  };
  return (
    <Modal onClose={() => {}} labelledBy="oqd-cpa-title" dismissable={false}>
      <h2 id="oqd-cpa-title" className="oqd-modal-title">{m.title}</h2>
      <p className="oqd-modal-body">{m.intro}</p>
      <a className="oqd-modal-link" href="https://otterquote.com/contractor-agreement.html" target="_blank" rel="noreferrer">{m.readLink}</a>
      <label className="oqd-modal-check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {m.checkboxLabel}</label>
      {err && <p className="oqd-modal-error">{err}</p>}
      <button type="button" className="oqd-btn oqd-btn-primary oqd-btn-full" disabled={!checked || busy} onClick={accept}>{busy ? m.saving : m.accept}</button>
    </Modal>
  );
}

function Modal({ children, onClose, labelledBy, dismissable = true }: {
  children: React.ReactNode; onClose: () => void; labelledBy: string; dismissable?: boolean;
}) {
  return (
    <div className="oqd-overlay" role="dialog" aria-modal="true" aria-labelledby={labelledBy}
      onClick={(e) => { if (dismissable && e.target === e.currentTarget) onClose(); }}>
      <div className="oqd-modal">{children}</div>
    </div>
  );
}

const STYLES = `
  .oqd-loading { display:flex; align-items:center; justify-content:center; min-height:60vh; }
  .oqd-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:oqd-spin .8s linear infinite; }
  @keyframes oqd-spin { to { transform:rotate(360deg); } }
  .oqd-wrap { max-width:1100px; margin:0 auto; padding:2rem 1.5rem 3rem; color:var(--white,#fff); }
  .oqd-hero h1 { font-size:1.8rem; margin:0 0 .25rem; }
  .oqd-hero p { color:var(--slate,#94a3b8); margin:0 0 1.5rem; }
  .oqd-dunning { display:flex; gap:1rem; background:#FEF2F2; border:2px solid #EF4444; border-radius:.75rem; padding:1.25rem 1.5rem; margin-bottom:1.5rem; color:#7F1D1D; }
  .oqd-dunning-icon { font-size:1.5rem; }
  .oqd-dunning-title { font-weight:700; color:#991B1B; margin-bottom:.4rem; }
  .oqd-dunning-msg { font-size:.875rem; margin:0 0 .75rem; }
  .oqd-pending { background:rgba(224,123,0,0.1); border:1px solid rgba(224,123,0,0.4); border-radius:.75rem; padding:1.25rem 1.5rem; margin-bottom:1.5rem; }
  .oqd-pending p { margin:0; color:var(--white,#fff); }
  .oqd-pending-actions { display:flex; gap:1rem; margin-top:1rem; flex-wrap:wrap; }
  .oqd-card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:1.5rem; margin-bottom:1.5rem; }
  .oqd-card-title { font-size:1.1rem; margin:0 0 1rem; }
  .oqd-checklist { display:flex; flex-direction:column; gap:.75rem; }
  .oqd-check { display:flex; gap:.75rem; align-items:flex-start; }
  .oqd-check-label { font-weight:600; }
  .oqd-check-link { color:var(--amber,#E07B00); font-size:.85rem; text-decoration:none; }
  .oqd-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:1rem; margin-bottom:2rem; }
  .oqd-stat { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:1.25rem; display:flex; flex-direction:column; gap:.4rem; }
  .oqd-stat-label { font-size:.8rem; color:var(--slate,#94a3b8); }
  .oqd-stat-value { font-size:1.6rem; font-weight:800; }
  .oqd-stat-link { font-size:.8rem; color:var(--amber,#E07B00); text-decoration:none; }
  .oqd-stat-link-muted { color:var(--slate,#94a3b8); }
  .oqd-section { font-size:1.1rem; margin:2rem 0 1rem; }
  .oqd-empty { color:var(--slate,#94a3b8); font-size:.9rem; }
  .oqd-table { width:100%; border-collapse:collapse; font-size:.85rem; }
  .oqd-table th { text-align:left; color:var(--slate,#94a3b8); font-weight:600; padding:.6rem .5rem; border-bottom:1px solid rgba(255,255,255,0.1); }
  .oqd-table td { padding:.7rem .5rem; border-bottom:1px solid rgba(255,255,255,0.06); }
  .oqd-badge { display:inline-block; padding:.2rem .55rem; border-radius:999px; font-size:.72rem; font-weight:700; }
  .oqd-badge-pending { background:rgba(2,132,199,0.15); color:#7DD3FC; }
  .oqd-badge-won { background:rgba(21,128,61,0.15); color:#86EFAC; }
  .oqd-badge-done { background:#DCFCE7; color:#15803D; }
  .oqd-activity { display:flex; flex-direction:column; gap:.75rem; }
  .oqd-activity-item { display:flex; gap:.6rem; align-items:flex-start; }
  .oqd-dot { width:10px; height:10px; border-radius:50%; margin-top:.35rem; flex-shrink:0; }
  .oqd-activity-text { font-size:.9rem; }
  .oqd-activity-time { font-size:.75rem; color:var(--slate,#94a3b8); }
  .oqd-links { display:grid; grid-template-columns:repeat(4,1fr); gap:1rem; margin-bottom:1.5rem; }
  .oqd-navcard { display:flex; flex-direction:column; align-items:center; gap:.5rem; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:1.25rem; text-decoration:none; color:var(--white,#fff); font-size:.9rem; font-weight:600; }
  .oqd-navcard:hover { border-color:var(--amber,#E07B00); }
  .oqd-navcard-icon { font-size:1.5rem; }
  .oqd-messages { margin-top:1rem; }
  .oqd-msg-label { display:block; font-size:.85rem; color:var(--slate,#94a3b8); margin-bottom:.4rem; }
  .oqd-select { width:100%; padding:.5rem .75rem; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.05); color:var(--white,#fff); font-family:inherit; }
  .oqd-thread { margin-top:1rem; }
  .oqd-msg-list { border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:1rem; height:300px; overflow-y:auto; margin-bottom:1rem; }
  .oqd-msg-empty { color:var(--slate,#94a3b8); text-align:center; margin:0; }
  .oqd-msg { margin-bottom:.75rem; padding:.6rem .75rem; border-radius:6px; background:rgba(255,255,255,0.04); border-left:3px solid var(--amber,#E07B00); }
  .oqd-msg.is-own { border-left-color:#0284C7; }
  .oqd-msg-from { font-weight:600; font-size:.8rem; margin-bottom:.2rem; }
  .oqd-msg-body { font-size:.85rem; word-wrap:break-word; }
  .oqd-msg-time { font-size:.7rem; color:var(--slate,#94a3b8); margin-top:.3rem; }
  .oqd-msg-compose { display:flex; gap:.75rem; }
  .oqd-textarea { flex:1; padding:.6rem; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.05); color:var(--white,#fff); font-family:inherit; resize:vertical; min-height:60px; }
  .oqd-msg-status { font-size:.75rem; color:var(--slate,#94a3b8); text-align:center; margin-top:.5rem; min-height:1rem; }
  .oqd-btn { display:inline-block; border:none; border-radius:8px; padding:.55rem 1rem; font-size:.85rem; font-weight:700; cursor:pointer; font-family:inherit; text-decoration:none; }
  .oqd-btn-sm { padding:.3rem .7rem; font-size:.75rem; }
  .oqd-btn-primary { background:var(--amber,#E07B00); color:var(--navy,#0B1929); }
  .oqd-btn-primary:disabled { opacity:.5; cursor:not-allowed; }
  .oqd-btn-full { width:100%; margin-top:1rem; }
  .oqd-btn-secondary { background:transparent; color:var(--white,#0B1929); border:1.5px solid rgba(255,255,255,0.25); }
  .oqd-btn-success { background:#15803D; color:#fff; }
  .oqd-btn-info { background:#0284C7; color:#fff; }
  .oqd-btn-outline { background:transparent; color:#0284C7; border:1px solid #0284C7; }
  .oqd-btn-danger { background:#EF4444; color:#fff; }
  .oqd-btn-send { background:var(--navy,#0B1929); color:#fff; align-self:flex-end; padding:.6rem 1.25rem; border-radius:6px; border:none; font-weight:700; cursor:pointer; }
  .oqd-warranty-ok { font-size:.75rem; color:#15803D; font-weight:600; }
  .oqd-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:1000; display:flex; align-items:center; justify-content:center; padding:1rem; }
  .oqd-modal { background:#fff; color:#0F172A; border-radius:.75rem; padding:2rem; max-width:480px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.3); }
  .oqd-modal-title { margin:0 0 .5rem; font-size:1.25rem; }
  .oqd-modal-strong-line { font-weight:600; margin:0 0 1rem; }
  .oqd-modal-body { color:#374151; font-size:.9rem; line-height:1.5; margin:0 0 1rem; }
  .oqd-modal-hint { color:#6B7280; font-size:.8rem; margin:0 0 1rem; }
  .oqd-modal-link { display:inline-block; color:#0284C7; margin-bottom:1rem; text-decoration:none; font-size:.9rem; }
  .oqd-modal-check { display:flex; gap:.5rem; align-items:flex-start; font-size:.875rem; color:#374151; margin-bottom:.5rem; }
  .oqd-modal-error { color:#991B1B; background:#FEF2F2; border:1px solid #FECACA; border-radius:.375rem; padding:.5rem; font-size:.85rem; }
  .oqd-modal-actions { display:flex; gap:.75rem; justify-content:flex-end; margin-top:1rem; }
  .oqd-file { display:block; width:100%; margin-bottom:.75rem; font-size:.85rem; }
  @media (max-width:768px){ .oqd-stats,.oqd-links{ grid-template-columns:repeat(2,1fr);} .oqd-table{ font-size:.78rem; } }
`;
