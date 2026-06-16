'use client';

/**
 * Contractor Settings — D-211 Phase 5 (port of contractor-settings.html, the contractor's
 * account-settings hub). Wrapped by the reusable ContractorShell (auth + contractor-role
 * gate + nav). Reuses the shared auth scaffolding + contractor-track shell — does NOT
 * re-implement auth.
 *
 * Gating parity with the static initSettings (contractor-settings.html:2171-2192):
 *   1. auth + contractor-role  → ContractorShell
 *   2. stale CPA               → enforceCpaRedirect (anti-loop → /contractor/dashboard)
 *   NOTE: like contractor-profile, initSettings has NO pending-approval gate — a pending
 *   contractor can manage settings while under review. We deliberately do NOT add one
 *   (brief: "match the static page's actual gating order — do NOT invent new gates").
 *   isPendingApproval is therefore intentionally unused here.
 *
 * Scope (matches the static page's ACTUAL save behaviour):
 *   PORTED  — notification prefs, bid auto-renew, public-directory opt-in, repair opt-in +
 *             show-up guarantee, payment methods (Stripe, ./StripePaymentMethods), IC 24-5-11
 *             attestation, CGL/COI, CRM (coming-soon), feature request, pricing info.
 *   OMITTED — the "Auto-Bid Settings" value-adds editor + "Bid Preview": saveSettings wraps
 *             that whole block in `if (false)` (D-193 — owned by contractor-auto-bids.html /
 *             the React /contractor/auto-bids route), so it persists nothing here. The repair
 *             "diagnostic fee / notes-to-customer" inputs live in that same dead block and are
 *             likewise omitted. (Mirrors C4 omitting the dead "Your Documents" card.) The
 *             auto-RENEW default toggle IS kept — it is saved here.
 *
 * Tier-3 handling: the attestation + COI legal copy is ported VERBATIM (copy.ts); the
 * record_attestation_ip RPC + create-setup-intent EF + contractor_payment_methods contracts
 * are called UNCHANGED. The §6.1 Phase-5 backend findings (create-payment-intent missing
 * Idempotency-Key; stripe-webhook event idempotency) are filed for migration-author — NOT
 * touched here. All DB-/user-sourced values render as JSX text (no innerHTML).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { ContractorShell } from '../_shell/ContractorShell';
import { useContractorRecord, type ContractorRecord } from '../_shell/use-contractor-record';
import { enforceCpaRedirect } from '../_shell/cpa-guard';
import { StripePaymentMethods } from './StripePaymentMethods';
import { SETTINGS_COPY as T } from './copy';
import {
  str, bool, NOTIFICATION_TYPES,
  getNotificationEmails, getNotificationPhones, resolveNotificationPrefs, buildSettingsPayload,
  billingName, shouldShowAttestationCard, validateAttestation, buildAttestationPayload,
  buildAttestationContractorUpdate, validateCoi, coiNeedsFile, coiFilePath, buildCoiUpdate,
  coiBannerState, validateFeatureRequest, buildFeatureRequestInsert,
  type SettingsFormState,
} from './utils';

const DASHBOARD_ROUTE = '/contractor/dashboard';

export default function ContractorSettingsPage() {
  return (
    <ContractorShell active="settings">
      <style>{STYLES}</style>
      <SettingsContent />
    </ContractorShell>
  );
}

function SettingsContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;
  const { contractor, loading: contractorLoading } = useContractorRecord(userId);
  const router = useRouter();

  const [record, setRecord] = useState<ContractorRecord | null>(null);
  const [gateResolved, setGateResolved] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  // Gating — order mirrors the static initSettings: CPA guard only (no pending gate).
  useEffect(() => {
    if (!contractor) return;
    setRecord(contractor);
    if (enforceCpaRedirect(contractor, router.replace, DASHBOARD_ROUTE)) {
      setRedirecting(true);
      return;
    }
    setGateResolved(true);
  }, [contractor, router]);

  if (contractorLoading || !record || redirecting || !gateResolved) {
    return <div className="oqs-loading"><div className="oqs-spin" /></div>;
  }

  return <SettingsView record={record} setRecord={setRecord} userId={userId as string} />;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function SettingsView({ record, setRecord, userId }: {
  record: ContractorRecord; setRecord: (r: ContractorRecord) => void; userId: string;
}) {
  // ── Lifted settings-bundle form state (any "Save" button persists the whole bundle,
  //    matching the static saveSettings). ──
  const [emails, setEmails] = useState<string[]>(() => {
    const e = getNotificationEmails(record); return e.length ? e : [''];
  });
  const [phones, setPhones] = useState<string[]>(() => {
    const p = getNotificationPhones(record); return p.length ? p : [''];
  });
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>(() => resolveNotificationPrefs(record));
  const [repairsAccepted, setRepairsAccepted] = useState<boolean>(() => bool(record.repairs_accepted));
  const [guaranteeChecked, setGuaranteeChecked] = useState<boolean>(() => bool(record.guarantee_accepted));
  const [autoRenewBids, setAutoRenewBids] = useState<boolean>(() => record.auto_renew_bids == null ? true : bool(record.auto_renew_bids));
  const [directoryOptin, setDirectoryOptin] = useState<boolean>(() => bool(record.public_directory_optin));
  const [saveState, setSaveState] = useState<SaveState>('idle');

  async function saveSettings(): Promise<void> {
    setSaveState('saving');
    const form: SettingsFormState = {
      emails, phones, notifPrefs, repairsAccepted, guaranteeChecked,
      autoRenewBids, publicDirectoryOptin: directoryOptin,
    };
    const payload = buildSettingsPayload(form, new Date().toISOString());
    try {
      const { error } = await supabase.from('contractors').update(payload).eq('id', record.id);
      if (error) throw error;
      setRecord({ ...record, ...payload } as ContractorRecord);
      setSaveState('saved');
    } catch (err) {
      console.error('Error saving settings:', err);
      setSaveState('error');
    }
    setTimeout(() => setSaveState('idle'), 2200);
  }

  return (
    <div className="oqs-wrap">
      <h1 className="oqs-page-title">{T.pageTitle}</h1>
      <p className="oqs-page-sub">{T.pageSubtitle}</p>

      <NotificationsCard
        emails={emails} setEmails={setEmails} phones={phones} setPhones={setPhones}
        notifPrefs={notifPrefs} setNotifPrefs={setNotifPrefs} saveState={saveState} onSave={saveSettings}
      />
      <BidAutoRenewCard value={autoRenewBids} setValue={setAutoRenewBids} saveState={saveState} onSave={saveSettings} />
      <DirectoryCard value={directoryOptin} setValue={setDirectoryOptin} saveState={saveState} onSave={saveSettings} />

      <StripePaymentMethods
        contractorId={record.id}
        billingName={billingName(record)}
        billingEmail={str(record.email)}
      />

      <PricingCard />

      <RepairWorkCard
        repairsAccepted={repairsAccepted} setRepairsAccepted={setRepairsAccepted}
        guaranteeChecked={guaranteeChecked} setGuaranteeChecked={setGuaranteeChecked}
        saveState={saveState} onSave={saveSettings}
      />

      {shouldShowAttestationCard(record) && (
        <AttestationCard record={record} setRecord={setRecord} />
      )}

      <CoiCard record={record} setRecord={setRecord} userId={userId} />
      <CrmCard />
      <FeatureRequestCard record={record} />

      <div className="oqs-action-bar">
        <button type="button" className="oqs-btn oqs-btn-primary" onClick={saveSettings} disabled={saveState === 'saving'}>
          {saveLabel(saveState, T.actionBar.save)}
        </button>
        <div className="oqs-action-note">{T.actionBar.note}</div>
      </div>
    </div>
  );
}

function saveLabel(state: SaveState, idle: string): string {
  if (state === 'saving') return T.actionBar.saving;
  if (state === 'saved') return T.actionBar.saved;
  if (state === 'error') return T.actionBar.saveError;
  return idle;
}

// ── Notification Preferences ──
function NotificationsCard({ emails, setEmails, phones, setPhones, notifPrefs, setNotifPrefs, saveState, onSave }: {
  emails: string[]; setEmails: (v: string[]) => void; phones: string[]; setPhones: (v: string[]) => void;
  notifPrefs: Record<string, boolean>; setNotifPrefs: (v: Record<string, boolean>) => void;
  saveState: SaveState; onSave: () => void;
}) {
  const setEmail = (i: number, v: string) => setEmails(emails.map((e, j) => (j === i ? v : e)));
  const setPhone = (i: number, v: string) => setPhones(phones.map((p, j) => (j === i ? v : p)));
  return (
    <section className="oqs-card">
      <h2 className="oqs-card-title">{T.notifications.title}</h2>

      <div className="oqs-section-head">{T.notifications.emailHeading}</div>
      <div className="oqs-notif-list">
        {emails.map((e, i) => (
          <div className="oqs-notif-item" key={'e' + i}>
            <input className="oqs-input" placeholder={T.notifications.emailPlaceholder} value={e} onChange={(ev) => setEmail(i, ev.target.value)} />
            <button type="button" className="oqs-remove-btn" onClick={() => setEmails(emails.filter((_, j) => j !== i))}>{T.notifications.remove}</button>
          </div>
        ))}
      </div>
      <button type="button" className="oqs-add-btn" onClick={() => setEmails([...emails, ''])}>{T.notifications.addEmail}</button>

      <div className="oqs-section-head">{T.notifications.phoneHeading}</div>
      <div className="oqs-notif-list">
        {phones.map((p, i) => (
          <div className="oqs-notif-item" key={'p' + i}>
            <input className="oqs-input" placeholder={T.notifications.phonePlaceholder} value={p} onChange={(ev) => setPhone(i, ev.target.value)} />
            <button type="button" className="oqs-remove-btn" onClick={() => setPhones(phones.filter((_, j) => j !== i))}>{T.notifications.remove}</button>
          </div>
        ))}
      </div>
      <button type="button" className="oqs-add-btn" onClick={() => setPhones([...phones, ''])}>{T.notifications.addPhone}</button>

      <div className="oqs-section-head">{T.notifications.typesHeading}</div>
      <div className="oqs-checks">
        {NOTIFICATION_TYPES.map((t) => (
          <label key={t.prefKey} className={'oqs-check' + (t.disabled ? ' is-disabled' : '')}>
            <input
              type="checkbox"
              checked={!!notifPrefs[t.prefKey]}
              disabled={t.disabled}
              onChange={(ev) => setNotifPrefs({ ...notifPrefs, [t.prefKey]: ev.target.checked })}
            />
            <span>{t.label}{t.disabled && <span className="oqs-badge-soon">{T.notifications.comingSoon}</span>}</span>
          </label>
        ))}
      </div>

      <SaveRow saveState={saveState} onSave={onSave} label={T.notifications.save} />
    </section>
  );
}

// ── Bid Auto-Renew ──
function BidAutoRenewCard({ value, setValue, saveState, onSave }: { value: boolean; setValue: (v: boolean) => void; saveState: SaveState; onSave: () => void }) {
  return (
    <section className="oqs-card">
      <h2 className="oqs-card-title">{T.autoRenew.title}</h2>
      <p className="oqs-card-sub">{T.autoRenew.subtitle}</p>
      <Toggle checked={value} onChange={setValue} label={T.autoRenew.toggleLabel} />
      <p className="oqs-note">{T.autoRenew.note}</p>
      <SaveRow saveState={saveState} onSave={onSave} label={T.autoRenew.save} />
    </section>
  );
}

// ── Public Contractor Directory ──
function DirectoryCard({ value, setValue, saveState, onSave }: { value: boolean; setValue: (v: boolean) => void; saveState: SaveState; onSave: () => void }) {
  return (
    <section className="oqs-card">
      <h2 className="oqs-card-title">{T.directory.title}</h2>
      <p className="oqs-card-sub">{T.directory.subtitle}</p>
      <Toggle checked={value} onChange={setValue} label={T.directory.toggleLabel} />
      <p className="oqs-note">{T.directory.note}</p>
      <SaveRow saveState={saveState} onSave={onSave} label={T.directory.save} />
    </section>
  );
}

// ── How Our Pricing Works (informational) ──
function PricingCard() {
  return (
    <section className="oqs-card">
      <h2 className="oqs-card-title">{T.pricing.title}</h2>
      <p className="oqs-card-sub">{T.pricing.subtitle}</p>
      <div className="oqs-pricing-tier">
        <div className="oqs-pricing-content">
          <div className="oqs-pricing-label">{T.pricing.tierLabel}</div>
          <div className="oqs-pricing-desc">{T.pricing.tierDescription}</div>
        </div>
        <div className="oqs-pricing-fee">{T.pricing.tierFee}</div>
      </div>
      <div className="oqs-fee-summary">
        <div className="oqs-fee-label">{T.pricing.summaryLabel}</div>
        <div className="oqs-fee-amount">{T.pricing.summaryAmount}</div>
        <div className="oqs-fee-note">{T.pricing.summaryNote}</div>
      </div>
    </section>
  );
}

// ── Repair Work ──
function RepairWorkCard({ repairsAccepted, setRepairsAccepted, guaranteeChecked, setGuaranteeChecked, saveState, onSave }: {
  repairsAccepted: boolean; setRepairsAccepted: (v: boolean) => void;
  guaranteeChecked: boolean; setGuaranteeChecked: (v: boolean) => void; saveState: SaveState; onSave: () => void;
}) {
  return (
    <section className="oqs-card">
      <h2 className="oqs-card-title">{T.repair.title}</h2>
      <p className="oqs-card-sub">{T.repair.intro}</p>
      <div className="oqs-toggle-row">
        <div>
          <div className="oqs-toggle-strong">{T.repair.toggleLabel}</div>
          <div className="oqs-toggle-sub">{T.repair.toggleSub}</div>
        </div>
        <Toggle checked={repairsAccepted} onChange={setRepairsAccepted} statusOn={T.repair.statusOn} statusOff={T.repair.statusOff} />
      </div>
      {repairsAccepted && (
        <div className="oqs-guarantee">
          <div className="oqs-guarantee-title">{T.repair.guaranteeTitle}</div>
          <p className="oqs-guarantee-body">{T.repair.guaranteeBody}</p>
          <label className="oqs-check">
            <input type="checkbox" checked={guaranteeChecked} onChange={(e) => setGuaranteeChecked(e.target.checked)} />
            <span>{T.repair.guaranteeCheckLabel}</span>
          </label>
        </div>
      )}
      <SaveRow saveState={saveState} onSave={onSave} label={T.repair.save} />
    </section>
  );
}

// ── IC 24-5-11 Attestation (D-170) — verbatim legal copy ──
function AttestationCard({ record, setRecord }: { record: ContractorRecord; setRecord: (r: ContractorRecord) => void }) {
  const [name, setName] = useState<string>(() => str(record.contact_name));
  const [title, setTitle] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);

  async function save() {
    const err = validateAttestation(name, title, accepted);
    if (err) { alert(err); return; }
    setBusy(true);
    setStatus(null);
    const now = new Date().toISOString();
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const payload = buildAttestationPayload(name, title, ua, now);
    try {
      const { data, error } = await supabase.from('contractors')
        .update(buildAttestationContractorUpdate(payload, now))
        .eq('id', record.id).select().single();
      if (error) throw error;
      // Stamp IP server-side so the on-record IP is trustworthy (RPC contract UNCHANGED).
      try {
        await supabase.rpc('record_attestation_ip', { p_contractor_id: record.id });
      } catch (ipErr) {
        console.warn('record_attestation_ip RPC failed (non-fatal):', ipErr);
      }
      setRecord(data as ContractorRecord);
      setStatus({ msg: T.attestation.savedMsg, ok: true });
    } catch (e) {
      console.error('Error saving attestation:', e);
      setStatus({ msg: 'Failed: ' + (e instanceof Error ? e.message : String(e)), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="oqs-card oqs-card-warn">
      <h2 className="oqs-card-title oqs-title-warn">{T.attestation.title}</h2>
      <p className="oqs-card-sub">{T.attestation.subtitle}</p>

      <div className="oqs-att-box">
        <p>{T.attestation.introP1}</p>
        <p>{T.attestation.introP2}</p>
        <ul>
          {T.attestation.bullets.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
        <p className="oqs-att-esign">{T.attestation.esignLine}</p>
      </div>

      <div className="oqs-grid2">
        <div className="oqs-form-group">
          <label className="oqs-label">{T.attestation.signerNameLabel}</label>
          <input className="oqs-input" placeholder={T.attestation.signerNamePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="oqs-form-group">
          <label className="oqs-label">{T.attestation.signerTitleLabel}</label>
          <input className="oqs-input" placeholder={T.attestation.signerTitlePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>

      <label className="oqs-check">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        <span>{T.attestation.acceptCheckLabel}</span>
      </label>

      <div className="oqs-save-row">
        <button type="button" className="oqs-btn oqs-btn-primary" disabled={busy} onClick={save}>{busy ? '…' : T.attestation.save}</button>
        {status && <span className={'oqs-status ' + (status.ok ? 'is-ok' : 'is-err')}>{status.msg}</span>}
      </div>
    </section>
  );
}

// ── CGL Certificate of Insurance (D-170) ──
function CoiCard({ record, setRecord, userId }: { record: ContractorRecord; setRecord: (r: ContractorRecord) => void; userId: string }) {
  const [insurer, setInsurer] = useState<string>(() => str(record.coi_insurer));
  const [policy, setPolicy] = useState<string>(() => str(record.coi_policy_number));
  const [expires, setExpires] = useState<string>(() => str(record.coi_expires_at).slice(0, 10));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const banner = coiBannerState(record, today);
  const hasCert = !!str(record.coi_file_url) && !!str(record.coi_expires_at);

  async function viewPdf() {
    const path = str(record.coi_file_url);
    if (!path) return;
    try {
      const { data, error } = await supabase.storage.from('contractor-documents').createSignedUrl(path, 300);
      if (error) throw error;
      window.open(data.signedUrl, '_blank');
    } catch (err) {
      alert('Could not open certificate: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function save() {
    const err = validateCoi(insurer, policy, expires);
    if (err) { alert(err); return; }
    const needFile = coiNeedsFile(record, expires);
    if (needFile && !file) { alert(T.coi.needFileMsg); return; }
    if (new Date(expires + 'T00:00:00') < today && !confirm(T.coi.pastDateConfirm)) return;

    setBusy(true);
    setStatus(null);
    try {
      let filePath = str(record.coi_file_url);
      if (file) {
        filePath = coiFilePath(userId, file.name, Date.now());
        const { error: upErr } = await supabase.storage.from('contractor-documents')
          .upload(filePath, file, { contentType: file.type || 'application/pdf', upsert: true });
        if (upErr) throw upErr;
      }
      const { data, error } = await supabase.from('contractors')
        .update(buildCoiUpdate(filePath, insurer, policy, expires, new Date().toISOString()))
        .eq('id', record.id).select().single();
      if (error) throw error;
      setRecord(data as ContractorRecord);
      setFile(null);
      setStatus({ msg: T.coi.savedMsg, ok: true });
    } catch (e) {
      console.error('Error saving COI:', e);
      setStatus({ msg: 'Failed: ' + (e instanceof Error ? e.message : String(e)), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="oqs-card">
      <h2 className="oqs-card-title">{T.coi.title}</h2>
      <p className="oqs-card-sub">{T.coi.subtitle}</p>

      <div className="oqs-coi-req">
        <div className="oqs-coi-req-head">{T.coi.requirementsHeading}</div>
        <ul>{T.coi.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul>
        <p className="oqs-note">{T.coi.requirementsNote}</p>
      </div>

      <div className={'oqs-coi-banner is-' + banner.kind}>{coiBannerText(banner)}</div>

      {hasCert && (
        <div className="oqs-coi-summary">
          <CoiField label={T.coi.insurerLabel} value={str(record.coi_insurer) || '—'} />
          <CoiField label={T.coi.policyShort} value={str(record.coi_policy_number) || '—'} />
          <CoiField label={T.coi.expiresShort} value={banner.expiresLabel ?? '—'} />
          <div className="oqs-coi-cell">
            <div className="oqs-coi-cell-label">{T.coi.certificate}</div>
            <button type="button" className="oqs-link" onClick={viewPdf}>{T.coi.viewPdf}</button>
          </div>
        </div>
      )}

      <div className="oqs-grid2">
        <div className="oqs-form-group">
          <label className="oqs-label">{T.coi.insurerLabel}</label>
          <input className="oqs-input" placeholder={T.coi.insurerPlaceholder} value={insurer} onChange={(e) => setInsurer(e.target.value)} />
        </div>
        <div className="oqs-form-group">
          <label className="oqs-label">{T.coi.policyLabel}</label>
          <input className="oqs-input" placeholder={T.coi.policyPlaceholder} value={policy} onChange={(e) => setPolicy(e.target.value)} />
        </div>
        <div className="oqs-form-group">
          <label className="oqs-label">{T.coi.expiresLabel}</label>
          <input className="oqs-input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </div>
        <div className="oqs-form-group">
          <label className="oqs-label">{T.coi.fileLabel}</label>
          <input className="oqs-input" type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
      </div>

      <div className="oqs-save-row">
        <button type="button" className="oqs-btn oqs-btn-primary" disabled={busy} onClick={save}>{busy ? '…' : T.coi.save}</button>
        {status && <span className={'oqs-status ' + (status.ok ? 'is-ok' : 'is-err')}>{status.msg}</span>}
      </div>
    </section>
  );
}

function coiBannerText(b: ReturnType<typeof coiBannerState>): string {
  if (b.kind === 'none') return T.coi.bannerNone;
  if (b.kind === 'expired') return T.coi.bannerExpired;
  if (b.kind === 'expiring') return T.coi.bannerExpiringPrefix + b.daysLeft + T.coi.bannerExpiringSuffix;
  return T.coi.bannerCurrentPrefix + (b.expiresLabel ?? '') + '.';
}

function CoiField({ label, value }: { label: string; value: string }) {
  return (
    <div className="oqs-coi-cell">
      <div className="oqs-coi-cell-label">{label}</div>
      <div className="oqs-coi-cell-value">{value}</div>
    </div>
  );
}

// ── CRM Integration (coming soon) ──
function CrmCard() {
  return (
    <section className="oqs-card">
      <h2 className="oqs-card-title">{T.crm.title}</h2>
      <div className="oqs-crm-head">{T.crm.heading}</div>
      <div className="oqs-crm-grid">
        {T.crm.providers.map((p) => (
          <div className="oqs-crm-provider" key={p}>
            <div className="oqs-crm-name">{p}</div>
            <button type="button" className="oqs-crm-connect" disabled>{T.crm.connect}</button>
          </div>
        ))}
      </div>
      <div className="oqs-crm-soon">{T.crm.comingSoon}</div>
    </section>
  );
}

// ── Feature Request ──
function FeatureRequestCard({ record }: { record: ContractorRecord }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);

  async function submit() {
    const err = validateFeatureRequest(text);
    if (err) { setStatus({ msg: err, ok: false }); return; }
    setBusy(true);
    try {
      await supabase.from('feature_requests').insert(buildFeatureRequestInsert(record, text, new Date().toISOString()));
      setText('');
      setStatus({ msg: T.feature.thankYou, ok: true });
    } catch (e) {
      console.error('Feature request error:', e);
      setStatus({ msg: T.feature.error, ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="oqs-card">
      <h2 className="oqs-card-title">{T.feature.title}</h2>
      <p className="oqs-card-sub">{T.feature.subtitle}</p>
      <textarea className="oqs-input oqs-textarea" maxLength={2000} placeholder={T.feature.placeholder} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="oqs-save-row">
        <button type="button" className="oqs-btn oqs-btn-navy" disabled={busy} onClick={submit}>{busy ? T.feature.sending : T.feature.send}</button>
        {status && <span className={'oqs-status ' + (status.ok ? 'is-ok' : 'is-err')}>{status.msg}</span>}
      </div>
    </section>
  );
}

// ── Small shared bits ──
function SaveRow({ saveState, onSave, label }: { saveState: SaveState; onSave: () => void; label: string }) {
  return (
    <div className="oqs-save-row oqs-save-row-top">
      <button type="button" className="oqs-btn oqs-btn-primary oqs-btn-sm" onClick={onSave} disabled={saveState === 'saving'}>
        {saveLabel(saveState, label)}
      </button>
    </div>
  );
}

function Toggle({ checked, onChange, label, statusOn, statusOff }: {
  checked: boolean; onChange: (v: boolean) => void; label?: string; statusOn?: string; statusOff?: string;
}) {
  return (
    <div className="oqs-toggle-wrap">
      <label className="oqs-switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="oqs-slider" />
      </label>
      {label && <span className="oqs-toggle-label">{label}</span>}
      {(statusOn || statusOff) && <span className={'oqs-toggle-status ' + (checked ? 'is-on' : 'is-off')}>{checked ? statusOn : statusOff}</span>}
    </div>
  );
}

const STYLES = `
  .oqs-loading { display:flex; align-items:center; justify-content:center; min-height:50vh; }
  .oqs-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:oqs-spin .8s linear infinite; }
  @keyframes oqs-spin { to { transform:rotate(360deg); } }
  .oqs-wrap { max-width:900px; margin:0 auto; padding:2rem 1.5rem 3rem; color:var(--white,#fff); }
  .oqs-page-title { font-size:1.8rem; margin:0 0 .35rem; }
  .oqs-page-sub { color:var(--slate,#94a3b8); font-size:.9rem; margin:0 0 1.5rem; line-height:1.55; }
  .oqs-card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:1.5rem; margin-bottom:1.5rem; }
  .oqs-card-warn { border-left:4px solid #dc2626; }
  .oqs-card-title { font-size:1.2rem; margin:0 0 .5rem; }
  .oqs-title-warn { color:#FCA5A5; }
  .oqs-card-sub { color:var(--slate,#94a3b8); font-size:.88rem; margin:0 0 1rem; line-height:1.6; }
  .oqs-muted { color:var(--slate,#94a3b8); font-size:.88rem; }
  .oqs-note { font-size:.8rem; color:var(--slate,#94a3b8); margin:.5rem 0 0; line-height:1.5; }
  .oqs-section-head { font-weight:600; margin:1rem 0 .5rem; font-size:.92rem; }
  .oqs-form-group { display:flex; flex-direction:column; gap:.35rem; }
  .oqs-label { font-size:.8rem; color:var(--slate,#94a3b8); font-weight:600; }
  .oqs-input { padding:.55rem .75rem; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.05); color:var(--white,#fff); font-family:inherit; font-size:.9rem; width:100%; box-sizing:border-box; }
  .oqs-textarea { min-height:90px; resize:vertical; margin-bottom:.75rem; }
  .oqs-grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:1rem; margin:0 0 1rem; }
  .oqs-actions { display:flex; gap:.75rem; flex-wrap:wrap; margin-top:.75rem; }
  .oqs-save-row { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; margin-top:.5rem; }
  .oqs-save-row-top { margin-top:1rem; padding-top:1rem; border-top:1px solid rgba(255,255,255,0.08); }
  .oqs-status { font-size:.82rem; }
  .oqs-status.is-ok { color:#6EE7B7; }
  .oqs-status.is-err { color:#FCA5A5; }
  .oqs-btn { border:none; border-radius:8px; padding:.55rem 1.1rem; font-size:.85rem; font-weight:700; cursor:pointer; font-family:inherit; }
  .oqs-btn-sm { padding:.45rem .9rem; font-size:.82rem; }
  .oqs-btn-primary { background:var(--amber,#E07B00); color:var(--navy,#0B1929); }
  .oqs-btn-secondary { background:transparent; color:var(--white,#fff); border:1.5px solid rgba(255,255,255,0.25); }
  .oqs-btn-navy { background:var(--navy,#0B1929); color:var(--amber,#E07B00); border:1px solid rgba(255,255,255,0.15); }
  .oqs-btn-green { background:#166534; color:#fff; }
  .oqs-btn:disabled { opacity:.55; cursor:default; }
  .oqs-link { background:none; border:none; color:#7DD3FC; cursor:pointer; font-size:.8rem; font-family:inherit; text-decoration:underline; padding:0; }
  .oqs-link-danger { color:#FCA5A5; }
  .oqs-notif-list { display:flex; flex-direction:column; gap:.5rem; }
  .oqs-notif-item { display:flex; gap:.5rem; align-items:center; }
  .oqs-remove-btn { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); color:var(--white,#fff); border-radius:6px; padding:.4rem .7rem; font-size:.78rem; cursor:pointer; font-family:inherit; }
  .oqs-add-btn { background:none; border:none; color:var(--amber,#E07B00); cursor:pointer; font-size:.85rem; font-weight:600; font-family:inherit; padding:.4rem 0 0; }
  .oqs-checks { display:flex; flex-direction:column; gap:.55rem; }
  .oqs-check { display:flex; align-items:flex-start; gap:.5rem; font-size:.88rem; cursor:pointer; line-height:1.45; }
  .oqs-check.is-disabled { opacity:.55; cursor:default; }
  .oqs-check input { margin-top:3px; accent-color:var(--amber,#E07B00); flex-shrink:0; }
  .oqs-badge-soon { font-size:.65rem; background:rgba(148,163,184,0.25); color:#CBD5E1; border-radius:4px; padding:1px 5px; margin-left:6px; }
  .oqs-toggle-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; padding:.85rem 1rem; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:8px; margin-top:.5rem; }
  .oqs-toggle-strong { font-weight:600; }
  .oqs-toggle-sub { font-size:.82rem; color:var(--slate,#94a3b8); margin-top:.2rem; }
  .oqs-toggle-wrap { display:flex; align-items:center; gap:.75rem; margin-top:.5rem; }
  .oqs-toggle-label { font-size:.88rem; }
  .oqs-toggle-status { font-size:.72rem; font-weight:800; padding:2px 8px; border-radius:999px; }
  .oqs-toggle-status.is-on { background:rgba(21,128,61,0.2); color:#86EFAC; }
  .oqs-toggle-status.is-off { background:rgba(148,163,184,0.2); color:#CBD5E1; }
  .oqs-switch { position:relative; display:inline-block; width:42px; height:24px; flex-shrink:0; }
  .oqs-switch input { opacity:0; width:0; height:0; }
  .oqs-slider { position:absolute; cursor:pointer; inset:0; background:rgba(255,255,255,0.2); border-radius:999px; transition:.2s; }
  .oqs-slider:before { content:''; position:absolute; height:18px; width:18px; left:3px; bottom:3px; background:#fff; border-radius:50%; transition:.2s; }
  .oqs-switch input:checked + .oqs-slider { background:var(--amber,#E07B00); }
  .oqs-switch input:checked + .oqs-slider:before { transform:translateX(18px); }
  /* payment methods */
  .oqs-pm-amber { background:rgba(224,123,0,0.08); border:1px solid rgba(224,123,0,0.5); border-radius:8px; padding:1rem; margin-bottom:1rem; font-size:.86rem; }
  .oqs-pm-amber-title { font-weight:700; color:#FCD34D; margin-bottom:.35rem; }
  .oqs-pm-list { display:flex; flex-direction:column; gap:.6rem; margin-bottom:1rem; }
  .oqs-pm-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.85rem 1rem; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:8px; flex-wrap:wrap; }
  .oqs-pm-row.is-default { border-color:rgba(134,239,172,0.5); background:rgba(21,128,61,0.12); }
  .oqs-pm-info { display:flex; align-items:center; gap:.85rem; }
  .oqs-pm-icon { font-size:1.4rem; }
  .oqs-pm-label { font-weight:600; font-size:.9rem; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .oqs-pm-added { font-size:.78rem; color:var(--slate,#94a3b8); margin-top:2px; }
  .oqs-pm-badge-default { font-size:.66rem; background:var(--navy,#0B1929); color:var(--amber,#E07B00); border-radius:4px; padding:2px 7px; font-weight:700; }
  .oqs-pm-badge-fee { font-size:.66rem; background:rgba(224,123,0,0.18); color:#FCD34D; border-radius:4px; padding:2px 6px; }
  .oqs-pm-badge-free { font-size:.66rem; background:rgba(21,128,61,0.22); color:#86EFAC; border-radius:4px; padding:2px 6px; }
  .oqs-pm-actions { display:flex; gap:.85rem; align-items:center; }
  .oqs-pm-encourage { background:rgba(59,130,246,0.08); border:1px solid rgba(59,130,246,0.35); border-radius:8px; padding:1rem; margin-bottom:1rem; }
  .oqs-pm-encourage-title { font-weight:600; margin-bottom:.5rem; }
  .oqs-pm-encourage p { font-size:.84rem; color:#CBD5E1; line-height:1.65; margin:0 0 .65rem; }
  .oqs-pm-success { background:rgba(21,128,61,0.14); border:1px solid rgba(134,239,172,0.4); border-radius:8px; padding:.75rem 1rem; margin-bottom:1rem; font-size:.85rem; color:#86EFAC; }
  .oqs-pm-add-buttons { display:flex; gap:.75rem; flex-wrap:wrap; }
  .oqs-pm-add { flex:1; min-width:200px; display:flex; flex-direction:column; align-items:center; gap:2px; }
  .oqs-pm-add-sub { font-size:.72rem; font-weight:400; opacity:.85; }
  .oqs-pm-feenote { font-size:.78rem; color:var(--slate,#94a3b8); margin:.75rem 0 0; }
  .oqs-pm-form { margin-top:1rem; padding:1rem; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.12); border-radius:8px; }
  .oqs-pm-form-ach { background:rgba(21,128,61,0.1); border-color:rgba(134,239,172,0.35); }
  .oqs-pm-form-title { font-weight:600; margin-bottom:.75rem; font-size:.9rem; }
  .oqs-pm-ach-body { font-size:.84rem; color:#CBD5E1; line-height:1.55; margin:0 0 .75rem; }
  .oqs-pm-card-element { border:1px solid #CBD5E1; border-radius:6px; padding:.75rem; background:#fff; min-height:40px; margin-bottom:.75rem; }
  .oqs-pm-error { color:#FCA5A5; font-size:.84rem; margin-bottom:.5rem; }
  .oqs-pm-notice { color:#FCD34D; font-size:.84rem; margin-bottom:.5rem; }
  /* pricing */
  .oqs-pricing-tier { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1rem; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:8px; }
  .oqs-pricing-label { font-weight:700; }
  .oqs-pricing-desc { font-size:.84rem; color:var(--slate,#94a3b8); margin-top:.35rem; line-height:1.55; }
  .oqs-pricing-fee { font-size:1.6rem; font-weight:800; color:var(--amber,#E07B00); }
  .oqs-fee-summary { margin-top:1rem; padding:1rem; background:rgba(224,123,0,0.08); border:1px solid rgba(224,123,0,0.3); border-radius:8px; }
  .oqs-fee-label { font-size:.82rem; color:var(--slate,#94a3b8); }
  .oqs-fee-amount { font-size:1.2rem; font-weight:800; color:var(--amber,#E07B00); margin:.2rem 0; }
  .oqs-fee-note { font-size:.8rem; color:var(--slate,#94a3b8); }
  /* repair */
  .oqs-guarantee { margin-top:1rem; padding:1rem; background:rgba(224,123,0,0.08); border:1px solid rgba(224,123,0,0.4); border-radius:8px; }
  .oqs-guarantee-title { font-weight:700; margin-bottom:.5rem; }
  .oqs-guarantee-body { font-size:.85rem; color:#CBD5E1; line-height:1.6; margin:0 0 .75rem; }
  /* attestation */
  .oqs-att-box { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:1rem; margin-bottom:1rem; font-size:.9rem; line-height:1.7; }
  .oqs-att-box ul { margin:0 0 .85rem 1.2rem; padding:0; }
  .oqs-att-box li { margin-bottom:.5rem; }
  .oqs-att-box p { margin:0 0 .85rem; }
  .oqs-att-esign { font-weight:600; }
  /* coi */
  .oqs-coi-req { background:rgba(14,116,144,0.08); border:1px solid rgba(14,116,144,0.3); border-radius:8px; padding:.85rem 1rem; margin-bottom:1rem; }
  .oqs-coi-req-head { font-size:.78rem; text-transform:uppercase; letter-spacing:.06em; color:#67E8F9; font-weight:700; margin-bottom:.5rem; }
  .oqs-coi-req ul { margin:0 0 .5rem 1.1rem; padding:0; font-size:.85rem; line-height:1.6; color:#CBD5E1; }
  .oqs-coi-banner { padding:.75rem 1rem; border-radius:8px; margin-bottom:1rem; font-size:.88rem; }
  .oqs-coi-banner.is-none, .oqs-coi-banner.is-expired { background:rgba(220,38,38,0.12); border:1px solid rgba(248,113,113,0.5); color:#FCA5A5; }
  .oqs-coi-banner.is-expiring { background:rgba(224,123,0,0.12); border:1px solid rgba(224,123,0,0.5); color:#FCD34D; }
  .oqs-coi-banner.is-current { background:rgba(21,128,61,0.14); border:1px solid rgba(134,239,172,0.4); color:#86EFAC; }
  .oqs-coi-summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1rem; padding:1rem; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:8px; margin-bottom:1rem; }
  .oqs-coi-cell-label { font-size:.72rem; color:var(--slate,#94a3b8); text-transform:uppercase; letter-spacing:.05em; font-weight:600; margin-bottom:4px; }
  .oqs-coi-cell-value { font-weight:600; font-size:.9rem; }
  /* crm */
  .oqs-crm-head { font-weight:600; margin-bottom:.75rem; }
  .oqs-crm-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:.75rem; opacity:.6; }
  .oqs-crm-provider { padding:1rem; background:rgba(255,255,255,0.04); border-radius:8px; text-align:center; }
  .oqs-crm-name { font-weight:600; margin-bottom:.5rem; font-size:.88rem; }
  .oqs-crm-connect { padding:.4rem .8rem; background:rgba(255,255,255,0.1); color:var(--slate,#94a3b8); border:1px solid rgba(255,255,255,0.15); border-radius:6px; font-weight:600; font-size:.82rem; cursor:not-allowed; }
  .oqs-crm-soon { margin-top:.75rem; text-align:center; font-size:.8rem; color:var(--slate,#94a3b8); font-weight:600; letter-spacing:.05em; text-transform:uppercase; }
  /* action bar */
  .oqs-action-bar { margin-top:1.5rem; padding:1.25rem; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; text-align:center; }
  .oqs-action-note { margin-top:.6rem; font-size:.82rem; color:var(--slate,#94a3b8); }
  @media (max-width:768px){ .oqs-pm-row, .oqs-toggle-row { flex-direction:column; align-items:flex-start; } }
`;
