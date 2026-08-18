'use client';

/**
 * Contractor Pre-Approval — D-211 Phase 6 (port of contractor-pre-approval.html, the
 * contractor onboarding / pre-approval gate). Multi-step wizard (License & Insurance ->
 * Agreements -> Contract Template) + the IC 24-5-11 attestation. Reuses the shared auth
 * scaffolding (AuthProvider via useAuthReady) — does NOT re-implement auth.
 *
 * GATING (matches the static init's ACTUAL order — brief: "do NOT invent gates"):
 *   - This is the PENDING contractor's landing page. The static page uses the minimal site
 *     header (data-auth="false"), NOT the contractor app nav — so we do NOT wrap it in
 *     <ContractorShell>. We gate directly on AuthProvider `settled` (the hardened cold-load
 *     signal) + load/create the contractors row ourselves (the static init creates the row
 *     on first arrival, which useContractorRecord's .single() cannot).
 *   - settled && no user  -> mirror the hardened shell: drop the loop-proof gate marker +
 *     router.replace('/contractor/login'). (The static page shows an error panel because it
 *     is the raw magic-link landing; the React route is reached via in-app nav where the
 *     contractor is authed — bouncing to the React login is the normalized auth-failure
 *     target, consistent with every other contractor route.)
 *   - status === 'active'  -> redirect to /contractor/dashboard (the ONLY redirect; a pending
 *     contractor STAYS here — the opposite of the dashboard/opportunities gate).
 *   - onboarding_step >= 4 -> "Application Submitted" panel; else show the resolved step.
 *
 * MAGIC-LINK LANDING STAYS STATIC (ADR-011, Tier-3): the index.html bounce still routes a
 * contractor magic-link to the STATIC contractor-pre-approval.html. This React route COEXISTS
 * and is reached via in-app navigation. We do NOT touch the index.html bounce.
 *
 * Tier-3 handling: the IC 24-5-11 attestation + indemnity legal copy is ported VERBATIM
 * (copy.ts); the record-attestation / create-hubspot-contact / send-support-email EFs and the
 * contractors / contractor_licenses table writes + contractor-documents/contractor-templates
 * storage are called UNCHANGED. The §6.1 Phase-6 backend findings (record-attestation
 * unverified JWT + CORS; send-support-email open relay; create-hubspot-contact homeowner-mode
 * PII; hardcoded HubSpot bootstrap secret) are filed for migration-author — NOT touched here.
 * All DB-/user-sourced values render as JSX text (no innerHTML).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { markContractorGateBounce } from '@/lib/contractor-gate';
import { type ContractorRecord } from '../_shell/use-contractor-record';
import { PRE_APPROVAL_COPY as T, PROFILE_TRADES, JURISDICTION_LEVELS, CONTRACTOR_DASHBOARD_ROUTE, CONTRACTOR_JOIN_URL, CONTRACTOR_FAQ_URL, CONTRACTOR_AGREEMENT_URL, CONTRACTOR_SETTINGS_URL, SUPPORT_EMAIL } from './copy';
import {
  str, parseSignup, buildInitialContractorInsert, resolveInitialState,
  evaluateProfileBasics, wcSatisfied, coiSatisfied, licenseSatisfied, step2Complete,
  validateLicenseEntry, licenseEntrySummary, buildLicenseInsert,
  docPath, wce1Path, licenseDocPath, buildStep2ContractorUpdate, buildStep2FallbackCreate,
  buildHubspotContactBody, buildSupportEmailBody,
  buildAttestationPayload, step3Complete, buildStep3ContractorUpdate, buildRecordAttestationBody, buildFinishSubmitUpdate,
  type LicenseEntry, type WcChoice,
} from './utils';

const CONTRACTOR_LOGIN_ROUTE = '/contractor/login';
const SIGNUP_LS_KEY = 'cs_contractor_signup';

type Panel = 'loading' | 'error' | 'submitted' | 'wizard';

function fireGtag(event: string, params: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const g = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
  if (typeof g === 'function') g('event', event, params);
}

export default function ContractorPreApprovalPage() {
  const { user, settled } = useAuthReady();
  const router = useRouter();
  const initRan = useRef(false);

  const [panel, setPanel] = useState<Panel>('loading');
  const [step, setStep] = useState<2 | 3>(2);
  const [contractor, setContractor] = useState<ContractorRecord | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [errorView, setErrorView] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    // Gate ONLY once auth hydration is definitively resolved (`settled`) — never act on the
    // provider's transient blank-screen fallback (postmortem 2026-06-16). The settle-safety
    // backstop guarantees `settled` flips within 6s even if getSession hangs, so this never
    // spins forever: a hung auth resolves to no-user and fails safe to /contractor/login.
    if (!settled) return;
    if (!user) {
      markContractorGateBounce();
      router.replace(CONTRACTOR_LOGIN_ROUTE);
      return;
    }
    if (initRan.current) return;
    initRan.current = true;

    void (async () => {
      const email = user.email ?? '';
      try {
        const { data: ct, error } = await supabase
          .from('contractors')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();
        if (error && (error as { code?: string }).code !== 'PGRST116') throw error;

        let rec = ct as ContractorRecord | null;
        if (!rec) {
          // No row yet (brand-new contractor) — create the stub from the signup blob.
          const signup = parseSignup(typeof localStorage !== 'undefined' ? localStorage.getItem(SIGNUP_LS_KEY) : null);
          const ins = await supabase
            .from('contractors')
            .insert(buildInitialContractorInsert(user.id, email, signup))
            .select()
            .single();
          if (ins.error) throw ins.error;
          rec = ins.data as ContractorRecord;
        }

        const state = resolveInitialState(rec);
        if (state.kind === 'active-redirect') {
          router.replace(CONTRACTOR_DASHBOARD_ROUTE);
          return;
        }
        setContractor(rec);
        if (state.kind === 'submitted') {
          setSubmittedEmail(email);
          setPanel('submitted');
          return;
        }
        setStep(state.step);
        setPanel('wizard');
      } catch (e) {
        console.error('Pre-approval init error:', e);
        setErrorView(null); // default session-not-found copy
        setPanel('error');
      }
    })();
  }, [settled, user, router]);

  function showError(title: string, body: string) {
    setErrorView({ title, body });
    setPanel('error');
  }
  function showSubmitted(email: string) {
    setSubmittedEmail(email);
    setPanel('submitted');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="oqp-root">
      <style>{STYLES}</style>
      <main className="oqp-main">
        <div className="oqp-outer">
          {panel === 'loading' && <LoadingPanel />}
          {panel === 'error' && <ErrorPanel view={errorView} />}
          {panel === 'submitted' && <SubmittedPanel email={submittedEmail} />}
          {panel === 'wizard' && contractor && user && (
            <>
              <ProgressHeader step={step} />
              {step === 2 && (
                <Step2Card
                  contractor={contractor}
                  userEmail={user.email ?? ''}
                  onLoading={() => setPanel('loading')}
                  onError={showError}
                  onAdvance={(rec) => { setContractor(rec); setStep(3); setPanel('wizard'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                />
              )}
              {step === 3 && (
                <Step3Card
                  contractor={contractor}
                  onSubmitted={() => showSubmitted(user.email ?? '')}
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panels
// ─────────────────────────────────────────────────────────────────────────────

function LoadingPanel() {
  return (
    <div className="oqp-state" role="status" aria-live="polite">
      <div className="oqp-spin" />
      <p className="oqp-muted">{T.loading}</p>
    </div>
  );
}

function ErrorPanel({ view }: { view: { title: string; body: string } | null }) {
  const title = view?.title ?? T.error.title;
  const body = view?.body ?? T.error.body;
  return (
    <div className="oqp-state">
      <div className="oqp-state-icon">⚠️</div>
      <h2 className="oqp-state-title">{title}</h2>
      <p className="oqp-muted oqp-state-body">{body}</p>
      <a href={CONTRACTOR_JOIN_URL} className="oqp-link-amber">{T.error.cta}</a>
    </div>
  );
}

function SubmittedPanel({ email }: { email: string }) {
  return (
    <div className="oqp-state">
      <div className="oqp-state-emoji">🎉</div>
      <h2 className="oqp-submitted-title">{T.submitted.title}</h2>
      <p className="oqp-muted oqp-submitted-conf">{T.submitted.confirmationPrefix}<strong className="oqp-white">{email}</strong></p>
      <p className="oqp-submitted-body">{T.submitted.body}</p>
      <div className="oqp-while-box">
        <strong className="oqp-while-title">{T.submitted.whileYouWait}</strong>
        <ul className="oqp-while-list">
          <li>{T.submitted.reviewFaqPre}<a href={CONTRACTOR_FAQ_URL} className="oqp-link-amber">{T.submitted.reviewFaqLink}</a></li>
          <li>{T.submitted.contractsPre}<a href={CONTRACTOR_SETTINGS_URL} className="oqp-link-amber">{T.submitted.contractsLink}</a></li>
          <li>{T.submitted.questionsPre}<a href={`mailto:${SUPPORT_EMAIL}`} className="oqp-link-amber">{SUPPORT_EMAIL}</a></li>
          <li><a href={CONTRACTOR_DASHBOARD_ROUTE} className="oqp-link-amber">{T.submitted.dashboardLink}</a></li>
        </ul>
      </div>
    </div>
  );
}

function ProgressHeader({ step }: { step: 2 | 3 }) {
  return (
    <div className="oqp-progress">
      <h1 className="oqp-progress-title">{T.progress.title}</h1>
      <div className="oqp-steps">
        {T.progress.steps.map((s, i) => {
          const status = s.n < step ? 'done' : s.n === step ? 'active' : '';
          return (
            <span key={s.n} className="oqp-step-cell">
              {i > 0 && <span className={'oqp-line' + (s.n <= step ? ' done' : '')} />}
              <span className="oqp-step-inner">
                <span className={'oqp-dot ' + status}>{s.n < step ? '✓' : s.n}</span>
                <span className={'oqp-step-label ' + status}>{s.label}</span>
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Profile & Documentation
// ─────────────────────────────────────────────────────────────────────────────

interface LicenseEntryUI extends LicenseEntry {
  file: File | null;
}

async function uploadDoc(path: string, file: File): Promise<void> {
  const { error } = await supabase.storage.from('contractor-documents').upload(path, file, { upsert: true });
  if (error) throw new Error(error.message);
}

function Step2Card({ contractor, userEmail, onLoading, onError, onAdvance }: {
  contractor: ContractorRecord;
  userEmail: string;
  onLoading: () => void;
  onError: (title: string, body: string) => void;
  onAdvance: (rec: ContractorRecord) => void;
}) {
  const [phone, setPhone] = useState<string>(() => str(contractor.phone));
  const [trades, setTrades] = useState<string[]>(() => Array.isArray(contractor.trades) ? (contractor.trades as string[]) : []);
  const [countiesRaw, setCountiesRaw] = useState<string>(() => Array.isArray(contractor.service_counties) ? (contractor.service_counties as string[]).join(', ') : '');

  const [coiFile, setCoiFile] = useState<File | null>(null);
  const [coiExpiry, setCoiExpiry] = useState('');

  const [wcChoice, setWcChoice] = useState<WcChoice>(null);
  const [wcFile, setWcFile] = useState<File | null>(null);
  const [wcExpiry, setWcExpiry] = useState('');
  const [wce1File, setWce1File] = useState<File | null>(null);
  const [wce1Expiry, setWce1Expiry] = useState('');

  const [licenses, setLicenses] = useState<LicenseEntryUI[]>([]);
  const [noLicense, setNoLicense] = useState(false);
  const [showLicForm, setShowLicForm] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const [submitting, setSubmitting] = useState(false);

  const profile = evaluateProfileBasics(phone, trades, countiesRaw);
  const coiOk = coiSatisfied(!!coiFile, coiExpiry);
  const wcOk = wcSatisfied(wcChoice, !!wcFile, wcExpiry, !!wce1File, wce1Expiry);
  const licenseOk = licenseSatisfied(licenses.length, noLicense);
  const canAdvance = step2Complete(profile, coiOk, wcOk, licenseOk) && !submitting;

  function toggleTrade(value: string, checked: boolean) {
    setTrades((prev) => (checked ? [...prev, value] : prev.filter((t) => t !== value)));
  }

  async function submitStep2() {
    if (submitting) return;
    if (!profile.phoneOk) { alert('Please enter a valid phone number (at least 10 digits).'); return; }
    if (!profile.tradesOk) { alert('Please select at least one trade you serve.'); return; }
    if (!profile.countyOk) { alert('Please enter at least one county in the format CountyName-StateCode (e.g. Marion-IN, Hamilton-IN).'); return; }
    if (!coiFile) { alert('Please upload your CGL certificate.'); return; }
    if (!coiExpiry) { alert('Please enter the CGL certificate expiry date.'); return; }
    if (!wcOk) { alert("Please provide workers' compensation info or exemption."); return; }
    if (licenses.length === 0 && !noLicense) { alert('Please add a contractor license or check "I don\'t have a license for this work".'); return; }

    setSubmitting(true);
    onLoading();
    try {
      // Derive the storage-path UID from the LIVE session (D-212 / pfw-1780341475 guard:
      // contractor-documents RLS requires path segment[1] === auth.uid()).
      const { data: sess } = await supabase.auth.getSession();
      const liveUserId = sess.session?.user?.id;
      const accessToken = sess.session?.access_token ?? '';
      if (!liveUserId) throw new Error('No active session — please sign in again and retry.');

      const nowMs = Date.now();
      const nowIso = new Date().toISOString();

      // COI upload
      const coiFileUrl = docPath(liveUserId, coiFile.name, nowMs);
      await uploadDoc(coiFileUrl, coiFile);
      fireGtag('artifact_uploaded', { artifact_type: 'coi' });

      // WC file or WCE-1 exemption document
      let wcCertFileRef: string | null = null;
      let wcCertExpiry: string | null = null;
      if (wcChoice === 'file' && wcFile) {
        wcCertFileRef = docPath(liveUserId, wcFile.name, nowMs);
        await uploadDoc(wcCertFileRef, wcFile);
        fireGtag('artifact_uploaded', { artifact_type: 'wc_cert' });
        if (wcExpiry) wcCertExpiry = new Date(wcExpiry).toISOString();
      } else if (wcChoice === 'exemption' && wce1File) {
        wcCertFileRef = wce1Path(liveUserId, wce1File.name, nowMs);
        await uploadDoc(wcCertFileRef, wce1File);
        fireGtag('artifact_uploaded', { artifact_type: 'wc_cert' });
        if (wce1Expiry) wcCertExpiry = new Date(wce1Expiry).toISOString();
      }

      const step2Update = buildStep2ContractorUpdate({
        coiFileUrl, coiExpiry, phone: profile.phone, trades: profile.trades, counties: profile.counties,
        wcChoice, wcCertFileRef, wcCertExpiry, noLicense,
      }, nowIso);

      // UPDATE keyed on user_id; if 0 rows (init never created the stub) create it (86e1p4pre).
      const { data: updatedRows, error: updErr } = await supabase
        .from('contractors').update(step2Update).eq('user_id', liveUserId).select();
      if (updErr) throw updErr;

      let rec: ContractorRecord;
      if (!updatedRows || updatedRows.length === 0) {
        const signup = parseSignup(typeof localStorage !== 'undefined' ? localStorage.getItem(SIGNUP_LS_KEY) : null);
        const createObj = buildStep2FallbackCreate(liveUserId, sess.session?.user?.email ?? userEmail, signup, step2Update);
        const createRes = await supabase.from('contractors').insert(createObj).select().single();
        if (createRes.error) throw createRes.error;
        rec = createRes.data as ContractorRecord;
      } else {
        rec = updatedRows[0] as ContractorRecord;
      }
      rec.onboarding_step = 2;

      // contractor_licenses inserts (D-218). Per-entry license file upload is non-fatal.
      if (!noLicense) {
        for (const entry of licenses) {
          let docUrl: string | null = null;
          if (entry.file) {
            try {
              const path = licenseDocPath(liveUserId, entry.file.name, Date.now());
              await uploadDoc(path, entry.file);
              docUrl = path;
              fireGtag('artifact_uploaded', { artifact_type: 'license' });
            } catch { /* non-fatal: save row with doc_url = null */ }
          }
          const { error: insErr } = await supabase.from('contractor_licenses').insert(buildLicenseInsert(rec.id, entry, docUrl));
          if (insErr) throw new Error(`License insert failed: ${insErr.message}`);
        }
      }

      // Sync to HubSpot (create-hubspot-contact, contractor mode) — contract UNCHANGED, non-fatal.
      // supabase.functions.invoke attaches the contractor's JWT automatically (the EF requires it),
      // matching the static page's manual `Authorization: Bearer <accessToken>` without relying on a
      // Netlify /functions/v1 proxy on the React origin.
      try {
        void accessToken; // session presence already validated above
        await supabase.functions.invoke('create-hubspot-contact', { body: buildHubspotContactBody(userEmail, rec.id) });
      } catch (e) { console.warn('HubSpot sync failed (non-fatal):', e); }

      // Admin notification (send-support-email) — admin-routed (no to_email), contract UNCHANGED, non-fatal.
      try {
        await supabase.functions.invoke('send-support-email', { body: buildSupportEmailBody(rec, userEmail) });
      } catch (e) { console.warn('Support email failed (non-fatal):', e); }

      onAdvance(rec);
    } catch (e) {
      setSubmitting(false);
      const msg = e instanceof Error ? e.message : String(e);
      onError(T.uploadFailedTitle, msg);
    }
  }

  return (
    <div className="oqp-card">
      <h2 className="oqp-card-title">{T.step2.title}</h2>
      <p className="oqp-card-sub">{T.step2.subtitle}</p>

      {/* Profile basics */}
      <DocCard title={T.step2.profile.title} complete={profile.phoneOk && profile.tradesOk && profile.countyOk}>
        <p className="oqp-doc-help">{T.step2.profile.subtitle}</p>
        <div className="oqp-field">
          <label className="oqp-doc-label" htmlFor="oqp-phone">{T.step2.profile.phoneLabel} <span className="oqp-req">*</span></label>
          <input id="oqp-phone" type="tel" autoComplete="tel" className="oqp-light-input" placeholder={T.step2.profile.phonePlaceholder} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="oqp-field">
          <label className="oqp-doc-label">{T.step2.profile.tradesLabel} <span className="oqp-req">*</span></label>
          <div className="oqp-trade-grid">
            {PROFILE_TRADES.map((tr) => (
              <label key={tr.value} className="oqp-trade-chip">
                <input type="checkbox" checked={trades.includes(tr.value)} onChange={(e) => toggleTrade(tr.value, e.target.checked)} /> {tr.label}
              </label>
            ))}
          </div>
        </div>
        <div className="oqp-field oqp-field-last">
          <label className="oqp-doc-label" htmlFor="oqp-counties">{T.step2.profile.countiesLabel} <span className="oqp-req">*</span></label>
          <input id="oqp-counties" type="text" autoComplete="off" className="oqp-light-input" placeholder={T.step2.profile.countiesPlaceholder} value={countiesRaw} onChange={(e) => setCountiesRaw(e.target.value)} />
          <p className="oqp-doc-help oqp-doc-help-sm">{T.step2.profile.countiesHelp}</p>
        </div>
      </DocCard>

      {/* CGL COI */}
      <DocCard title={T.step2.coi.title} complete={coiOk}>
        <p className="oqp-doc-help">{T.step2.coi.subtitle}</p>
        <FilePick label={T.step2.coi.chooseFile} file={coiFile} accept=".pdf,.png,.jpg,.jpeg" onPick={setCoiFile} />
        <div className="oqp-field oqp-field-last">
          <label className="oqp-doc-label" htmlFor="oqp-coi-exp">{T.step2.coi.expiryLabel} <span className="oqp-req">*</span></label>
          <input id="oqp-coi-exp" type="date" className="oqp-light-input oqp-date" value={coiExpiry} onChange={(e) => setCoiExpiry(e.target.value)} />
        </div>
      </DocCard>

      {/* Workers' Comp */}
      <DocCard title={T.step2.wc.title} complete={wcOk}>
        <p className="oqp-doc-help">{T.step2.wc.subtitle}</p>
        <label className="oqp-radio">
          <input type="radio" name="wc-choice" checked={wcChoice === 'file'} onChange={() => setWcChoice('file')} />
          <span>{T.step2.wc.uploadChoice}</span>
        </label>
        {wcChoice === 'file' && (
          <div className="oqp-indent">
            <FilePick label={T.step2.wc.chooseFile} file={wcFile} accept=".pdf,.png,.jpg,.jpeg" onPick={setWcFile} />
            <div className="oqp-field oqp-field-last">
              <label className="oqp-doc-label" htmlFor="oqp-wc-exp">{T.step2.wc.expiryLabel} <span className="oqp-req">*</span></label>
              <input id="oqp-wc-exp" type="date" className="oqp-light-input oqp-date" value={wcExpiry} onChange={(e) => setWcExpiry(e.target.value)} />
            </div>
          </div>
        )}
        <div className="oqp-wc-divider">
          <label className="oqp-radio">
            <input type="radio" name="wc-choice" checked={wcChoice === 'exemption'} onChange={() => setWcChoice('exemption')} />
            <span>{T.step2.wc.exemptionChoice}</span>
          </label>
          {wcChoice === 'exemption' && (
            <div className="oqp-indent">
              <p className="oqp-doc-help">{T.step2.wc.exemptionHelp}</p>
              <FilePick label={T.step2.wc.chooseFile} file={wce1File} accept=".pdf,.png,.jpg,.jpeg" onPick={(f) => {
                if (f && f.size > 10 * 1024 * 1024) { alert('WCE-1 certificate must be 10MB or less.'); setWce1File(null); return; }
                setWce1File(f);
              }} />
              <div className="oqp-field oqp-field-last">
                <label className="oqp-doc-label" htmlFor="oqp-wce1-exp">{T.step2.wc.exemptionExpiryLabel} <span className="oqp-req">*</span></label>
                <input id="oqp-wce1-exp" type="date" className="oqp-light-input oqp-date" value={wce1Expiry} onChange={(e) => setWce1Expiry(e.target.value)} />
              </div>
            </div>
          )}
        </div>
      </DocCard>

      {/* Contractor License (D-218 multi-license) */}
      <DocCard title={T.step2.license.title} complete={licenseOk}>
        <p className="oqp-doc-help">{T.step2.license.subtitle}</p>
        <LicenseSection
          licenses={licenses} setLicenses={setLicenses}
          noLicense={noLicense} setNoLicense={setNoLicense}
          showForm={showLicForm} setShowForm={setShowLicForm}
          editingIndex={editingIndex} setEditingIndex={setEditingIndex}
        />
      </DocCard>

      <button type="button" className="oqp-btn-primary" disabled={!canAdvance} onClick={submitStep2}>
        {T.step2.advance}
      </button>
    </div>
  );
}

function DocCard({ title, complete, children }: { title: string; complete: boolean; children: React.ReactNode }) {
  return (
    <div className="oqp-doc-card">
      <div className="oqp-doc-head">
        <h3 className="oqp-doc-title">{title}</h3>
        <span className={'oqp-doc-status' + (complete ? ' is-ok' : '')}>{complete ? T.step2.statusComplete : T.step2.statusRequired}</span>
      </div>
      {children}
    </div>
  );
}

function FilePick({ label, file, accept, onPick }: { label: string; file: File | null; accept: string; onPick: (f: File | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="oqp-field">
      <input ref={ref} type="file" accept={accept} className="oqp-hidden-file" onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
      <button type="button" className="oqp-btn-secondary" onClick={() => ref.current?.click()}>{label}</button>
      {file && <div className="oqp-filename">📎 {file.name}</div>}
    </div>
  );
}

function LicenseSection({ licenses, setLicenses, noLicense, setNoLicense, showForm, setShowForm, editingIndex, setEditingIndex }: {
  licenses: LicenseEntryUI[]; setLicenses: React.Dispatch<React.SetStateAction<LicenseEntryUI[]>>;
  noLicense: boolean; setNoLicense: (v: boolean) => void;
  showForm: boolean; setShowForm: (v: boolean) => void;
  editingIndex: number | null; setEditingIndex: (v: number | null) => void;
}) {
  const [level, setLevel] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [verificationUrl, setVerificationUrl] = useState('');
  const [licFile, setLicFile] = useState<File | null>(null);

  function openForm(idx: number | null) {
    setEditingIndex(idx);
    if (idx !== null && licenses[idx]) {
      const e = licenses[idx];
      setLevel(e.jurisdictionLevel); setJurisdiction(e.jurisdiction); setNumber(e.licenseNumber);
      setExpiry(e.expiryDate ?? ''); setVerificationUrl(e.verificationUrl ?? ''); setLicFile(null);
    } else {
      setLevel(''); setJurisdiction(''); setNumber(''); setExpiry(''); setVerificationUrl(''); setLicFile(null);
    }
    setShowForm(true);
  }
  function cancelForm() { setEditingIndex(null); setShowForm(false); }
  function saveEntry() {
    const err = validateLicenseEntry({ jurisdictionLevel: level, jurisdiction, licenseNumber: number });
    if (err) { alert(err); return; }
    if (licFile && licFile.size > 10 * 1024 * 1024) { alert('License document must be 10MB or less.'); return; }
    const base: LicenseEntryUI = {
      id: editingIndex !== null && licenses[editingIndex] ? licenses[editingIndex].id : Date.now(),
      jurisdictionLevel: level as LicenseEntryUI['jurisdictionLevel'],
      jurisdiction: jurisdiction.trim(), licenseNumber: number.trim(),
      expiryDate: expiry || null, verificationUrl: verificationUrl.trim() || null,
      file: licFile ?? (editingIndex !== null && licenses[editingIndex] ? licenses[editingIndex].file : null),
    };
    setLicenses((prev) => {
      if (editingIndex !== null) { const next = [...prev]; next[editingIndex] = base; return next; }
      return [...prev, base];
    });
    setEditingIndex(null); setShowForm(false);
  }
  function deleteEntry(idx: number) { setLicenses((prev) => prev.filter((_, i) => i !== idx)); }

  return (
    <>
      <div className="oqp-lic-list">
        {licenses.map((e, idx) => (
          <div key={e.id} className="oqp-lic-row">
            <span className="oqp-lic-summary">{licenseEntrySummary(e)}</span>
            <span className="oqp-lic-actions">
              <button type="button" className="oqp-lic-edit" onClick={() => openForm(idx)}>{T.step2.license.editBtn}</button>
              <button type="button" className="oqp-lic-del" onClick={() => deleteEntry(idx)}>{T.step2.license.deleteBtn}</button>
            </span>
          </div>
        ))}
      </div>
      {licenses.length === 0 && <div className="oqp-doc-help">{T.step2.license.empty}</div>}

      {showForm && (
        <div className="oqp-lic-form">
          <div className="oqp-lic-grid">
            <div className="oqp-field oqp-field-last">
              <label className="oqp-doc-label">{T.step2.license.levelLabel} <span className="oqp-req">*</span></label>
              <select className="oqp-light-input" value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="">{T.step2.license.levelPlaceholder}</option>
                {JURISDICTION_LEVELS.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}
              </select>
            </div>
            <div className="oqp-field oqp-field-last">
              <label className="oqp-doc-label">{T.step2.license.jurisdictionLabel} <span className="oqp-req">*</span></label>
              <input className="oqp-light-input" placeholder={T.step2.license.jurisdictionPlaceholder} value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
            </div>
            <div className="oqp-field oqp-field-last">
              <label className="oqp-doc-label">{T.step2.license.numberLabel} <span className="oqp-req">*</span></label>
              <input className="oqp-light-input" placeholder={T.step2.license.numberPlaceholder} value={number} onChange={(e) => setNumber(e.target.value)} />
            </div>
            <div className="oqp-field oqp-field-last">
              <label className="oqp-doc-label">{T.step2.license.expiryLabel} <span className="oqp-opt">{T.step2.license.expiryOptional}</span></label>
              <input type="date" className="oqp-light-input oqp-date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </div>
            <div className="oqp-field oqp-field-last">
              <label className="oqp-doc-label">{T.step2.license.docLabel} <span className="oqp-opt">{T.step2.license.docOptional}</span></label>
              <FilePick label={T.step2.license.chooseFile} file={licFile} accept=".pdf,.png,.jpg,.jpeg" onPick={setLicFile} />
            </div>
            <div className="oqp-field oqp-field-last">
              <label className="oqp-doc-label">{T.step2.license.verificationLabel} <span className="oqp-opt">{T.step2.license.verificationOptional}</span> <span className="oqp-help-dot" title={T.step2.license.verificationHelp}>?</span></label>
              <input type="url" className="oqp-light-input" placeholder={T.step2.license.verificationPlaceholder} value={verificationUrl} onChange={(e) => setVerificationUrl(e.target.value)} />
            </div>
          </div>
          <div className="oqp-lic-form-actions">
            <button type="button" className="oqp-lic-save" onClick={saveEntry}>{T.step2.license.saveBtn}</button>
            <button type="button" className="oqp-lic-cancel" onClick={cancelForm}>{T.step2.license.cancelBtn}</button>
          </div>
        </div>
      )}

      {!showForm && (
        <button type="button" className="oqp-lic-add" disabled={noLicense} onClick={() => openForm(null)}>{T.step2.license.addBtn}</button>
      )}

      <hr className="oqp-lic-hr" />

      <label className={'oqp-radio' + (licenses.length > 0 ? ' is-disabled' : '')}>
        <input type="checkbox" disabled={licenses.length > 0} checked={noLicense} onChange={(e) => setNoLicense(e.target.checked)} />
        <span>{T.step2.license.noLicenseLabel}</span>
      </label>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Platform Agreements (VERBATIM legal copy)
// ─────────────────────────────────────────────────────────────────────────────

function Step3Card({ contractor, onSubmitted }: { contractor: ContractorRecord; onSubmitted: () => void }) {
  const [partner, setPartner] = useState(false);
  const [cancellation, setCancellation] = useState(false);
  const [attestation, setAttestation] = useState(false);
  const [tcpa, setTcpa] = useState(false);
  const [busy, setBusy] = useState(false);

  // gh-590: Step 3 is now the final wizard step (Step 4 contract-upload, D-209, removed —
  // templates move to profile → Settings → Contract Templates). The agreements UPDATE and
  // the former finishAndSubmit()'s non-contract fields (buildFinishSubmitUpdate) are merged
  // into ONE contractors write; status stays 'pending_approval' from the Step-1 insert and
  // is re-asserted here for parity with the static page.
  async function submitStep3() {
    if (busy) return;
    if (!step3Complete(partner, cancellation, attestation)) {
      alert(T.step3.incompleteAlert);
      return;
    }
    setBusy(true);
    const nowIso = new Date().toISOString();
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const payload = buildAttestationPayload(ua, nowIso);
    try {
      const { error } = await supabase.from('contractors')
        .update({ ...buildStep3ContractorUpdate(contractor, payload, tcpa, nowIso), ...buildFinishSubmitUpdate(nowIso) })
        .eq('user_id', contractor.user_id);
      if (error) throw error;

      // Server-side IP capture (record-attestation) — contract UNCHANGED, non-fatal (parity:
      // the static page sends this same payload, which the EF rejects 400; the authoritative
      // record is the contractors UPDATE above).
      try {
        await supabase.functions.invoke('record-attestation', { body: buildRecordAttestationBody(contractor.id, nowIso) });
      } catch (fnErr) {
        console.warn('record-attestation edge function error (non-fatal):', fnErr);
      }

      fireGtag('contractor_signup_complete', { event_category: 'contractor_funnel' });
      onSubmitted();
    } catch (err) {
      console.error('Step 3 error:', err);
      setBusy(false);
      alert(T.step3.saveError);
    }
  }

  return (
    <div className="oqp-card">
      <h2 className="oqp-card-title">{T.step3.title}</h2>
      <p className="oqp-card-sub">{T.step3.subtitle}</p>

      <div className="oqp-info-box">
        <strong>{T.step3.partnerAgreement.heading}</strong>
        <p>{T.step3.partnerAgreement.bodyPre}<a href={CONTRACTOR_AGREEMENT_URL} target="_blank" rel="noreferrer" className="oqp-link-amber-strong">{T.step3.partnerAgreement.linkText}</a>{T.step3.partnerAgreement.bodyPost}</p>
      </div>
      <label className="oqp-check">
        <input type="checkbox" checked={partner} onChange={(e) => setPartner(e.target.checked)} />
        <span>{T.step3.partnerAgreement.checkLabel}</span>
      </label>

      <div className="oqp-info-box">
        <strong>{T.step3.cancellation.heading}</strong>
        <p>{T.step3.cancellation.body}</p>
        <p><strong className="oqp-white">{T.step3.cancellation.bodyStrong}</strong></p>
      </div>
      <label className="oqp-check">
        <input type="checkbox" checked={cancellation} onChange={(e) => setCancellation(e.target.checked)} />
        <span>{T.step3.cancellation.checkLabel}</span>
      </label>

      <div className="oqp-info-box">
        <strong>{T.step3.attestation.heading}</strong>
        <p>{T.step3.attestation.intro}</p>
        <ul>
          {T.step3.attestation.bullets.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
        <p><strong className="oqp-white">{T.step3.attestation.esignLine}</strong></p>
      </div>
      <label className="oqp-check">
        <input type="checkbox" checked={attestation} onChange={(e) => setAttestation(e.target.checked)} />
        <span>{T.step3.attestation.checkLabel}</span>
      </label>

      <div className="oqp-info-box">
        <strong>{T.step3.tcpa.heading}</strong>
        <p>{T.step3.tcpa.body}</p>
      </div>
      <label className="oqp-check">
        <input type="checkbox" checked={tcpa} onChange={(e) => setTcpa(e.target.checked)} />
        <span>{T.step3.tcpa.checkLabel}</span>
      </label>

      <button type="button" className="oqp-btn-primary" disabled={busy} onClick={submitStep3}>{T.step3.advance}</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles (ported from contractor-pre-approval.html — navy theme + light doc cards)
// ─────────────────────────────────────────────────────────────────────────────

const STYLES = `
  .oqp-root { --navy:#0D1B2E; --navy-2:#0F2440; --amber:#E07B00; --white:#FFFFFF; --slate:#94A3B8; --light:#E2E8F0; font-family:'Rubik',sans-serif; color:var(--white); background:var(--navy); min-height:100vh; }
  .oqp-main { min-height:calc(100vh - 64px); padding:4rem 1.5rem; box-sizing:border-box; }
  .oqp-outer { max-width:680px; margin:0 auto; }
  .oqp-muted { color:var(--slate); }
  .oqp-white { color:var(--white); }
  .oqp-req { color:#EF4444; }
  .oqp-opt { font-weight:400; color:var(--slate); }
  /* states */
  .oqp-state { text-align:center; padding:4rem 1.5rem; }
  .oqp-spin { width:40px; height:40px; border:3px solid rgba(255,255,255,0.1); border-top:3px solid var(--amber); border-radius:50%; animation:oqp-spin .8s linear infinite; margin:0 auto 1.5rem; }
  @keyframes oqp-spin { to { transform:rotate(360deg); } }
  .oqp-state-icon { font-size:2rem; margin-bottom:1rem; }
  .oqp-state-emoji { font-size:3rem; margin-bottom:1.5rem; }
  .oqp-state-title { font-size:1.5rem; margin-bottom:1rem; }
  .oqp-state-body { margin-bottom:2rem; }
  .oqp-link-amber { color:var(--amber); font-weight:600; text-decoration:none; }
  .oqp-link-amber-strong { color:var(--amber); font-weight:600; }
  .oqp-submitted-title { font-size:2rem; margin-bottom:1rem; }
  .oqp-submitted-conf { max-width:520px; margin:0 auto 1rem; font-size:.95rem; }
  .oqp-submitted-body { color:var(--white); max-width:560px; margin:0 auto 2rem; font-size:1.05rem; line-height:1.6; }
  .oqp-while-box { background:rgba(224,123,0,0.07); border-left:4px solid var(--amber); border-radius:.5rem; padding:1.5rem; max-width:480px; margin:0 auto; text-align:left; }
  .oqp-while-title { color:var(--amber); display:block; margin-bottom:.75rem; }
  .oqp-while-list { color:var(--slate); margin-left:1.25rem; line-height:2; }
  /* progress */
  .oqp-progress { text-align:center; margin-bottom:3rem; }
  .oqp-progress-title { font-size:1.75rem; margin-bottom:1rem; }
  .oqp-steps { display:flex; align-items:flex-start; justify-content:center; }
  .oqp-step-cell { display:flex; align-items:flex-start; }
  .oqp-line { height:2px; width:48px; background:rgba(255,255,255,0.12); margin-top:15px; }
  .oqp-line.done { background:var(--amber); }
  .oqp-step-inner { display:flex; flex-direction:column; align-items:center; width:80px; }
  .oqp-dot { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:.85rem; font-weight:700; border:2px solid rgba(255,255,255,0.2); color:var(--slate); background:transparent; }
  .oqp-dot.active { border-color:var(--amber); color:var(--amber); background:rgba(224,123,0,0.12); }
  .oqp-dot.done { border-color:var(--amber); background:var(--amber); color:var(--navy); }
  .oqp-step-label { font-size:.7rem; color:var(--slate); text-align:center; line-height:1.3; margin-top:.5rem; }
  .oqp-step-label.active { color:var(--amber); }
  .oqp-step-label.done { color:rgba(255,255,255,0.6); }
  /* card */
  .oqp-card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:.75rem; padding:3rem; box-shadow:0 8px 40px rgba(0,0,0,0.3); }
  .oqp-card-title { font-size:1.5rem; margin-bottom:.5rem; }
  .oqp-card-sub { color:var(--slate); font-size:.9rem; margin-bottom:2rem; }
  /* doc cards (light) */
  .oqp-doc-card { border:2px solid var(--slate); border-radius:.75rem; padding:1.5rem; margin-bottom:1.5rem; background:#f8fafc; }
  .oqp-doc-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; }
  .oqp-doc-title { margin:0; font-size:1.125rem; color:var(--navy); }
  .oqp-doc-status { font-weight:600; color:var(--slate); }
  .oqp-doc-status.is-ok { color:#10b981; }
  .oqp-doc-help { font-size:.9rem; color:var(--slate); margin:0 0 1rem 0; }
  .oqp-doc-help-sm { font-size:.8rem; margin:.4rem 0 0 0; }
  .oqp-field { margin-bottom:1rem; }
  .oqp-field-last { margin-bottom:0; }
  .oqp-doc-label { display:block; font-size:.9rem; font-weight:600; color:var(--navy); margin-bottom:.4rem; }
  .oqp-form-label { display:block; font-weight:600; color:var(--white); margin-bottom:.5rem; font-size:.95rem; }
  .oqp-light-input { width:100%; padding:.5rem .75rem; background:#fff; color:#1e293b; border:1px solid #cbd5e1; border-radius:.375rem; font-size:.95rem; box-sizing:border-box; font-family:inherit; }
  .oqp-date { max-width:200px; }
  .oqp-hidden-file { display:none; }
  .oqp-filename { font-size:.85rem; color:var(--slate); margin-top:.5rem; }
  .oqp-trade-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:.5rem; }
  .oqp-trade-chip { display:flex; align-items:center; gap:.5rem; padding:.5rem .75rem; background:#fff; border:1px solid #cbd5e1; border-radius:.375rem; cursor:pointer; font-size:.9rem; color:#1e293b; }
  .oqp-trade-chip input { accent-color:var(--amber); }
  .oqp-radio { display:flex; align-items:center; gap:.75rem; cursor:pointer; font-size:.95rem; color:#1e293b; margin-bottom:.75rem; }
  .oqp-radio.is-disabled { opacity:.45; cursor:not-allowed; }
  .oqp-indent { padding-left:1.5rem; margin-bottom:.75rem; }
  .oqp-wc-divider { border-top:1px solid var(--light); padding-top:1rem; margin-top:.5rem; }
  .oqp-btn-primary { background:var(--amber); color:var(--navy); padding:1rem 2rem; border:none; border-radius:.5rem; font-size:1rem; font-weight:700; cursor:pointer; font-family:inherit; width:100%; margin-top:1.5rem; transition:background .2s; }
  .oqp-btn-primary:hover:not(:disabled) { background:#C06900; color:var(--white); }
  .oqp-btn-primary:disabled { opacity:.5; cursor:not-allowed; }
  .oqp-btn-secondary { background:var(--amber); color:var(--navy); padding:.5rem; border:none; border-radius:.375rem; font-size:.9rem; font-weight:700; cursor:pointer; font-family:inherit; width:100%; }
  /* license */
  .oqp-lic-list { margin-bottom:.75rem; }
  .oqp-lic-row { display:flex; justify-content:space-between; align-items:center; padding:.6rem .75rem; background:#fff; border:1px solid #e2e8f0; border-radius:.375rem; margin-bottom:.5rem; font-size:.9rem; color:var(--navy); }
  .oqp-lic-actions { display:flex; gap:.5rem; flex-shrink:0; }
  .oqp-lic-edit { border:none; background:none; cursor:pointer; color:var(--amber); font-size:.85rem; font-weight:600; }
  .oqp-lic-del { border:none; background:none; cursor:pointer; color:#ef4444; font-size:.85rem; font-weight:600; }
  .oqp-lic-form { background:#f1f5f9; border-radius:.5rem; padding:1rem; margin-bottom:1rem; }
  .oqp-lic-grid { display:grid; gap:.75rem; }
  .oqp-lic-form-actions { display:flex; gap:.5rem; margin-top:1rem; }
  .oqp-lic-save { flex:1; padding:.5rem; background:var(--amber); color:#fff; border:none; border-radius:.375rem; font-weight:600; cursor:pointer; font-size:.9rem; }
  .oqp-lic-cancel { flex:1; padding:.5rem; background:#e2e8f0; color:var(--navy); border:none; border-radius:.375rem; font-weight:600; cursor:pointer; font-size:.9rem; }
  .oqp-lic-add { width:100%; padding:.6rem; margin-bottom:1rem; background:var(--amber); color:#fff; border:none; border-radius:.375rem; font-weight:600; cursor:pointer; font-size:.9rem; }
  .oqp-lic-add:disabled { opacity:.45; cursor:not-allowed; }
  .oqp-lic-hr { border:none; border-top:1px solid #e2e8f0; margin:.5rem 0 1rem 0; }
  .oqp-help-dot { display:inline-flex; align-items:center; justify-content:center; width:1rem; height:1rem; border-radius:50%; border:1px solid var(--slate); color:var(--slate); font-size:.7rem; font-weight:700; cursor:help; }
  /* step 3 info boxes + checks */
  .oqp-info-box { background:rgba(224,123,0,0.07); border-left:4px solid var(--amber); padding:1.5rem; border-radius:.5rem; margin-bottom:1.5rem; font-size:.9rem; color:var(--slate); line-height:1.7; }
  .oqp-info-box strong { color:var(--white); }
  .oqp-info-box p { margin-top:.5rem; }
  .oqp-info-box ul { margin:.5rem 0 0 1.25rem; padding:0; }
  .oqp-info-box li { margin-bottom:.5rem; }
  .oqp-check { display:flex; align-items:flex-start; gap:.75rem; margin-bottom:2rem; }
  .oqp-check input { width:18px; height:18px; min-width:18px; cursor:pointer; accent-color:var(--amber); margin-top:2px; }
  .oqp-check span { cursor:pointer; font-size:.9rem; color:var(--slate); line-height:1.5; }
  @media (max-width:600px) { .oqp-card { padding:1.5rem; } .oqp-main { padding:2rem 1rem; } }
`;
