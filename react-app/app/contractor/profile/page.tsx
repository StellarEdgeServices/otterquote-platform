'use client';

/**
 * Contractor Profile — D-211 Phase 4 (port of contractor-profile.html, the contractor's
 * profile/credentials hub). Wrapped by the reusable ContractorShell (auth +
 * contractor-role gate + nav). Reuses the shared auth scaffolding and the contractor-track
 * shell — does NOT re-implement auth.
 *
 * Gating parity with the static init() (contractor-profile.html initProfile):
 *   1. auth + contractor-role            → ContractorShell
 *   2. stale CPA                         → enforceCpaRedirect (anti-loop → /contractor/dashboard)
 *   NOTE: the static profile page has NO pending-approval gate — a pending contractor can
 *   complete their profile while under review. We deliberately do NOT add one (the brief:
 *   "match the static page's actual gating order — do NOT invent new gates"). isPendingApproval
 *   is therefore intentionally unused on this page (unlike /contractor/opportunities).
 *
 * Folded §6.1 client concern: every DB-sourced credential value (company_name, license,
 * review links, certs, template filenames) renders as React text/JSX — never innerHTML —
 * closing the static page's company_name innerHTML XSS surface on the client. The matching
 * RLS defects (contractors self-writable company_name/status; contractor_cert_verifications
 * wrong-column policy) are Tier-3 and filed for migration-author; this page never writes a
 * privilege column and does not depend on the permissive RLS.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { ContractorShell } from '../_shell/ContractorShell';
import { useContractorRecordGate, type ContractorRecord } from '../_shell/use-contractor-record';
import { enforceCpaRedirect } from '../_shell/cpa-guard';
import { ServiceAreaEditor } from './ServiceAreaEditor';
import { ManufacturerCerts } from './ManufacturerCerts';
import { ContractTemplates } from './ContractTemplates';
import { PcTemplates } from './PcTemplates';
import { PROFILE_COPY as T } from './copy';
import {
  formatPhone, tradesDisplay, brandsDisplay, normalizeWebsiteHref, serviceAreaSummary,
  storagePathFromValue, validateIntroVideo, type ContractTemplate,
} from './utils';

const DASHBOARD_ROUTE = '/contractor/dashboard';

/** Coerce an index-signature (`unknown`) contractors column to a display string. */
function str(v: unknown): string {
  return v == null ? '' : String(v);
}
function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

export default function ContractorProfilePage() {
  return (
    <ContractorShell active="profile">
      <style>{STYLES}</style>
      <ProfileContent />
    </ContractorShell>
  );
}

function ProfileContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;
  const { contractor, loading: contractorLoading } = useContractorRecordGate(userId);
  const router = useRouter();

  const [record, setRecord] = useState<ContractorRecord | null>(null);
  const [gateResolved, setGateResolved] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  // Gating — order mirrors the static initProfile: CPA guard only (no pending gate).
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
    return <div className="oqp-loading"><div className="oqp-spin" /></div>;
  }

  return <ProfileView record={record} setRecord={setRecord} userId={userId as string} />;
}

function ProfileView({ record, setRecord, userId }: {
  record: ContractorRecord; setRecord: (r: ContractorRecord) => void; userId: string;
}) {
  // Update the contractors row and sync local state. Returns true on success.
  async function updateContractor(updates: Record<string, unknown>): Promise<boolean> {
    const { data, error } = await supabase
      .from('contractors')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', record.id)
      .select()
      .single();
    if (error || !data) {
      console.error('Error saving profile:', error);
      return false;
    }
    setRecord(data as ContractorRecord);
    return true;
  }

  return (
    <div className="oqp-wrap">
      <h1 className="oqp-page-title">{T.pageTitle}</h1>

      <CompanyCard record={record} onUpdate={updateContractor} />
      <PhotosCard record={record} userId={userId} onUpdate={updateContractor} />
      <IntroVideoCard record={record} userId={userId} onUpdate={updateContractor} />
      <CredentialsCard record={record} onUpdate={updateContractor} />
      <ReviewsCard record={record} onUpdate={updateContractor} />
      <ServiceAreaCard record={record} onUpdate={updateContractor} />
      <ManufacturerCerts contractorId={record.id} userId={userId} />
      <ContractTemplates contractorId={record.id} initialTemplates={asArray(record.contract_templates) as unknown as ContractTemplate[]} />
      <PcTemplates contractorId={record.id} />
      <StatsCard contractorId={record.id} />
    </div>
  );
}

// ── Company Information ──
function CompanyCard({ record, onUpdate }: { record: ContractorRecord; onUpdate: (u: Record<string, unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => seed(record));
  function seed(r: ContractorRecord) {
    return {
      company_name: str(r.company_name), contact_name: str(r.contact_name), phone: str(r.phone),
      email: str(r.email), website_url: str(r.website_url), years_in_business: str(r.years_in_business),
      num_employees: str(r.num_employees), about_us: str(r.about_us), why_choose_us: str(r.why_choose_us),
    };
  }
  function open() { setForm(seed(record)); setEditing(true); }
  async function save() {
    setSaving(true);
    const ok = await onUpdate({
      company_name: form.company_name, contact_name: form.contact_name, phone: form.phone, email: form.email,
      website_url: form.website_url, years_in_business: parseInt(form.years_in_business) || null,
      num_employees: parseInt(form.num_employees) || null, about_us: form.about_us, why_choose_us: form.why_choose_us,
    });
    setSaving(false);
    if (ok) setEditing(false); else alert(T.company.saveError);
  }
  const website = str(record.website_url);
  return (
    <section className="oqp-card">
      <h2 className="oqp-card-title"><span aria-hidden="true">🏢</span>{T.company.title}</h2>
      {!editing ? (
        <>
          <ViewField label="Business Name" value={str(record.company_name) || '—'} />
          <ViewField label="Owner / Contact" value={str(record.contact_name) || '—'} />
          <ViewField label="Phone" value={formatPhone(str(record.phone))} />
          <ViewField label="Email" value={str(record.email) || '—'} />
          <div className="oqp-view-field">
            <label>Website</label>
            <div className="oqp-view-value">
              {website ? <a href={normalizeWebsiteHref(website)} target="_blank" rel="noreferrer">{website}</a> : '—'}
            </div>
          </div>
          <ViewField label="Years in Business" value={str(record.years_in_business) || '—'} />
          <ViewField label="Team Size" value={str(record.num_employees) || '—'} />
          <ViewField label="About Us" value={str(record.about_us) || 'Not yet provided.'} />
          <ViewField label="Why Choose Us" value={str(record.why_choose_us) || 'Not yet provided.'} />
          <button type="button" className="oqp-btn oqp-btn-primary" onClick={open}>{T.company.edit}</button>
        </>
      ) : (
        <div className="oqp-form">
          <Field label="Business Name"><input className="oqp-input" value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} /></Field>
          <Field label="Owner / Contact"><input className="oqp-input" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} /></Field>
          <Field label="Phone"><input className="oqp-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><input className="oqp-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Website"><input className="oqp-input" type="url" placeholder="https://example.com" value={form.website_url} onChange={(e) => setForm({ ...form, website_url: e.target.value })} /></Field>
          <Field label="Years in Business"><input className="oqp-input" type="number" value={form.years_in_business} onChange={(e) => setForm({ ...form, years_in_business: e.target.value })} /></Field>
          <Field label="Team Size"><input className="oqp-input" type="number" value={form.num_employees} onChange={(e) => setForm({ ...form, num_employees: e.target.value })} /></Field>
          <Field label="About Us"><textarea className="oqp-input oqp-textarea" value={form.about_us} onChange={(e) => setForm({ ...form, about_us: e.target.value })} /></Field>
          <Field label="Why Choose Us"><textarea className="oqp-input oqp-textarea" value={form.why_choose_us} onChange={(e) => setForm({ ...form, why_choose_us: e.target.value })} /></Field>
          <div className="oqp-actions">
            <button type="button" className="oqp-btn oqp-btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : T.company.save}</button>
            <button type="button" className="oqp-btn oqp-btn-secondary" disabled={saving} onClick={() => setEditing(false)}>{T.company.cancel}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Photos (owner/team photo upload → contractor-documents) ──
function PhotosCard({ record, userId, onUpdate }: { record: ContractorRecord; userId: string; onUpdate: (u: Record<string, unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) { setEditing(false); return; }
    setBusy(true);
    try {
      const filePath = `${userId}/profile/${file.name}`;
      const { error: upErr } = await supabase.storage.from('contractor-documents').upload(filePath, file, { contentType: file.type, upsert: true });
      if (upErr) throw upErr;
      await onUpdate({ owner_photo_url: filePath });
    } catch (err) {
      console.error('Error uploading owner photo:', err);
      alert(T.photos.uploadError);
    } finally {
      setBusy(false);
      setEditing(false);
    }
  };
  return (
    <section className="oqp-card">
      <h2 className="oqp-card-title"><span aria-hidden="true">📸</span>{T.photos.title}</h2>
      {!editing ? (
        <>
          <ViewField label={T.photos.ownerLabel} value={record.owner_photo_url ? 'On file' : 'Not uploaded'} />
          <button type="button" className="oqp-btn oqp-btn-primary" onClick={() => setEditing(true)}>{T.photos.edit}</button>
        </>
      ) : (
        <div className="oqp-form">
          <Field label={T.photos.ownerLabel}><input className="oqp-input" type="file" accept="image/*" disabled={busy} onChange={onFile} /></Field>
          <div className="oqp-actions">
            <button type="button" className="oqp-btn oqp-btn-secondary" disabled={busy} onClick={() => setEditing(false)}>{T.photos.cancel}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Intro Video (MP4/MOV → contractor-documents; signed-URL <video> in view) ──
function IntroVideoCard({ record, userId, onUpdate }: { record: ContractorRecord; userId: string; onUpdate: (u: Record<string, unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<{ msg: string; color: string } | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const path = str(record.intro_video_path);
    if (!path) { setVideoUrl(null); return; }
    (async () => {
      const storagePath = storagePathFromValue(path, 'contractor-documents');
      const { data } = await supabase.storage.from('contractor-documents').createSignedUrl(storagePath, 3600);
      if (active && data?.signedUrl) setVideoUrl(data.signedUrl);
    })();
    return () => { active = false; };
  }, [record.intro_video_path]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) { setStatus({ msg: T.introVideo.choose, color: '#94a3b8' }); return; }
    const err = validateIntroVideo(file);
    if (err) { setStatus({ msg: err, color: '#FCA5A5' }); return; }
    setStatus({ msg: T.introVideo.uploading, color: '#94a3b8' });
    try {
      const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
      const filePath = `${userId}/intro-video/intro-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('contractor-documents').upload(filePath, file, { contentType: file.type, upsert: true });
      if (upErr) throw upErr;
      const ok = await onUpdate({ intro_video_path: filePath });
      if (!ok) throw new Error('db update failed');
      setStatus({ msg: T.introVideo.saved, color: '#6EE7B7' });
      setEditing(false);
    } catch (err2) {
      console.error('Error uploading intro video:', err2);
      setStatus({ msg: T.introVideo.uploadFailed, color: '#FCA5A5' });
    }
  };

  return (
    <section className="oqp-card">
      <h2 className="oqp-card-title"><span aria-hidden="true">🎥</span>{T.introVideo.title}</h2>
      {!editing ? (
        <>
          {videoUrl ? (
            <video src={videoUrl} controls preload="metadata" playsInline className="oqp-video" />
          ) : (
            <p className="oqp-help">{T.introVideo.help}</p>
          )}
          <button type="button" className="oqp-btn oqp-btn-primary" onClick={() => setEditing(true)}>{T.introVideo.edit}</button>
        </>
      ) : (
        <div className="oqp-form">
          <p className="oqp-help">{T.introVideo.help}</p>
          <Field label="Video file (MP4 or MOV)"><input className="oqp-input" type="file" accept="video/mp4,video/quicktime" onChange={onFile} /></Field>
          {status && <div className="oqp-cert-status" style={{ color: status.color }}>{status.msg}</div>}
          <div className="oqp-actions">
            <button type="button" className="oqp-btn oqp-btn-secondary" onClick={() => { setEditing(false); setStatus(null); }}>{T.introVideo.cancel}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Credentials & Verification (licenses read-only + WC/GL + free-text certs) ──
interface License { id?: string; municipality?: string | null; license_number?: string | null; verified?: boolean | null }
interface Certification { id: string; certification_name: string }

function CredentialsCard({ record, onUpdate }: { record: ContractorRecord; onUpdate: (u: Record<string, unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [certs, setCerts] = useState<Certification[]>([]);
  const [wc, setWc] = useState(!!record.has_workers_comp);
  const [gl, setGl] = useState(!!record.has_general_liability);
  const [newCert, setNewCert] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const [licRes, certRes] = await Promise.all([
        supabase.from('contractor_licenses').select('*').eq('contractor_id', record.id),
        supabase.from('contractor_certifications').select('*').eq('contractor_id', record.id).order('created_at', { ascending: true }),
      ]);
      if (!active) return;
      setLicenses((licRes.data as License[]) ?? []);
      setCerts((certRes.data as Certification[]) ?? []);
    })();
    return () => { active = false; };
  }, [record.id]);

  async function saveInsurance() {
    setSaving(true);
    const ok = await onUpdate({ has_workers_comp: wc, has_general_liability: gl });
    setSaving(false);
    if (ok) alert(T.credentials.insuranceSaved); else alert(T.credentials.saveError);
  }
  async function addCert() {
    const name = newCert.trim();
    if (!name) return;
    const { data, error } = await supabase.from('contractor_certifications').insert({ contractor_id: record.id, certification_name: name }).select().single();
    if (error || !data) { alert(T.credentials.addCertError); return; }
    setCerts((c) => [...c, data as Certification]);
    setNewCert('');
  }
  async function removeCert(id: string) {
    const { error } = await supabase.from('contractor_certifications').delete().eq('id', id);
    if (error) { alert(T.credentials.removeCertError); return; }
    setCerts((c) => c.filter((x) => x.id !== id));
  }

  const hasWC = editing ? wc : !!record.has_workers_comp;
  const hasGL = editing ? gl : !!record.has_general_liability;

  return (
    <section className="oqp-card">
      <h2 className="oqp-card-title"><span aria-hidden="true">✓</span>{T.credentials.title}</h2>

      {/* Licenses — read-only display */}
      {licenses.length > 0 ? (
        licenses.map((lic, i) => (
          <div className="oqp-view-field" key={lic.id ?? i}>
            <label>{T.credentials.licenseLabelPrefix}{str(lic.municipality) || T.credentials.licenseGeneral}</label>
            <div className="oqp-view-value">
              <span>{str(lic.license_number) || T.credentials.licenseOnFile}</span>
              <span className={'oqp-badge ' + (lic.verified ? 'oqp-badge-ok' : 'oqp-badge-pending')}>{lic.verified ? T.credentials.verified : T.credentials.pendingVerification}</span>
            </div>
          </div>
        ))
      ) : record.no_license_required ? (
        <ViewField label="Contractor License" value={T.credentials.noLicenseRequired} />
      ) : (
        <ViewField label="Contractor License" value={T.credentials.noLicenses} />
      )}

      <div className="oqp-view-field">
        <label>{T.credentials.wcLabel}</label>
        <div className="oqp-view-value"><span className={'oqp-badge ' + (hasWC ? 'oqp-badge-ok' : 'oqp-badge-pending')}>{hasWC ? T.credentials.onFile : T.credentials.notOnFile}</span></div>
      </div>
      <div className="oqp-view-field">
        <label>{T.credentials.glLabel}</label>
        <div className="oqp-view-value"><span className={'oqp-badge ' + (hasGL ? 'oqp-badge-ok' : 'oqp-badge-pending')}>{hasGL ? T.credentials.onFile : T.credentials.notOnFile}</span></div>
      </div>

      <div className="oqp-view-field">
        <label>{T.credentials.certsLabel}</label>
        <div className="oqp-view-value">
          {certs.length === 0 ? T.credentials.noCerts : <ul className="oqp-cert-list">{certs.map((c) => <li key={c.id}>{c.certification_name}</li>)}</ul>}
        </div>
      </div>

      {!editing ? (
        <button type="button" className="oqp-btn oqp-btn-primary" onClick={() => { setWc(!!record.has_workers_comp); setGl(!!record.has_general_liability); setEditing(true); }}>{T.credentials.edit}</button>
      ) : (
        <div className="oqp-form">
          <label className="oqp-check"><input type="checkbox" checked={wc} onChange={(e) => setWc(e.target.checked)} /> {T.credentials.wcLabel}</label>
          <label className="oqp-check"><input type="checkbox" checked={gl} onChange={(e) => setGl(e.target.checked)} /> {T.credentials.glLabel}</label>
          <button type="button" className="oqp-btn oqp-btn-primary" disabled={saving} onClick={saveInsurance}>{T.credentials.saveInsurance}</button>

          <Field label={T.credentials.certsLabel}>
            <div className="oqp-cert-add">
              <input className="oqp-input" placeholder={T.credentials.addCertPlaceholder} value={newCert} onChange={(e) => setNewCert(e.target.value)} />
              <button type="button" className="oqp-btn-sm oqp-btn-sm-secondary" onClick={addCert}>{T.credentials.addCertBtn}</button>
            </div>
          </Field>
          {certs.length > 0 && (
            <ul className="oqp-cert-edit-list">
              {certs.map((c) => (
                <li key={c.id}><span>{c.certification_name}</span><button type="button" className="oqp-link-btn" onClick={() => removeCert(c.id)}>{T.credentials.removeBtn}</button></li>
              ))}
            </ul>
          )}
          <div className="oqp-actions">
            <button type="button" className="oqp-btn oqp-btn-secondary" onClick={() => setEditing(false)}>{T.credentials.close}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Reviews & Ratings ──
function ReviewsCard({ record, onUpdate }: { record: ContractorRecord; onUpdate: (u: Record<string, unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(() => seed());
  function seed() {
    const o: Record<string, string> = {};
    for (const f of T.reviews.fields) o[f.id] = str(record[f.id]);
    return o;
  }
  function open() { setForm(seed()); setEditing(true); }
  async function save() {
    setSaving(true);
    const updates: Record<string, unknown> = {};
    for (const f of T.reviews.fields) updates[f.id] = form[f.id] || null;
    const ok = await onUpdate(updates);
    setSaving(false);
    if (ok) setEditing(false); else alert(T.reviews.cancel && T.company.saveError);
  }
  return (
    <section className="oqp-card">
      <h2 className="oqp-card-title"><span aria-hidden="true">⭐</span>{T.reviews.title}</h2>
      {!editing ? (
        <>
          {T.reviews.fields.map((f) => {
            const val = str(record[f.id]);
            return (
              <div className="oqp-view-field" key={f.id}>
                <label>{f.label}</label>
                <div className="oqp-view-value">{val ? <a href={val} target="_blank" rel="noreferrer">{f.text}</a> : <span className="oqp-muted">{T.reviews.notProvided}</span>}</div>
              </div>
            );
          })}
          <button type="button" className="oqp-btn oqp-btn-primary" onClick={open}>{T.reviews.edit}</button>
        </>
      ) : (
        <div className="oqp-form">
          {T.reviews.fields.map((f) => (
            <Field label={f.label} key={f.id}>
              <input className="oqp-input" type="url" placeholder={f.placeholder} value={form[f.id] ?? ''} onChange={(e) => setForm({ ...form, [f.id]: e.target.value })} />
            </Field>
          ))}
          <div className="oqp-actions">
            <button type="button" className="oqp-btn oqp-btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : T.reviews.save}</button>
            <button type="button" className="oqp-btn oqp-btn-secondary" disabled={saving} onClick={() => setEditing(false)}>{T.reviews.cancel}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Service Area & Trades (D-192) ──
function ServiceAreaCard({ record, onUpdate }: { record: ContractorRecord; onUpdate: (u: Record<string, unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const states = asArray(record.service_states);
  const counties = asArray(record.service_counties);

  async function save(newCounties: string[]) {
    setSaving(true);
    // D4: persist ONLY service_counties (service_states is not a real column).
    const ok = await onUpdate({ service_counties: newCounties });
    setSaving(false);
    if (ok) { setEditing(false); alert(T.serviceArea.saved); } else alert(T.serviceArea.saveError);
  }

  return (
    <section className="oqp-card">
      <h2 className="oqp-card-title"><span aria-hidden="true">📍</span>{T.serviceArea.title}</h2>
      {!editing ? (
        <>
          <ViewField label={T.serviceArea.tradesLabel} value={tradesDisplay(asArray(record.trades))} />
          <ViewField label={T.serviceArea.brandsLabel} value={brandsDisplay(asArray(record.preferred_brands))} />
          <ViewField label={T.serviceArea.areaLabel} value={serviceAreaSummary(states, counties, str(record.service_area_description) || null)} />
          <button type="button" className="oqp-btn oqp-btn-primary" onClick={() => setEditing(true)}>{T.serviceArea.edit}</button>
        </>
      ) : (
        <ServiceAreaEditor initialStates={states} initialCounties={counties} saving={saving} onSave={save} onCancel={() => setEditing(false)} />
      )}
    </section>
  );
}

// ── Platform Statistics ──
function StatsCard({ contractorId }: { contractorId: string }) {
  const [jobs, setJobs] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    (async () => {
      const { count } = await supabase.from('quotes').select('id', { count: 'exact', head: true }).eq('contractor_id', contractorId);
      if (active) setJobs(count ?? 0);
    })();
    return () => { active = false; };
  }, [contractorId]);
  return (
    <section className="oqp-card">
      <h2 className="oqp-card-title"><span aria-hidden="true">📊</span>{T.stats.title}</h2>
      <div className="oqp-stats">
        <div className="oqp-stat">
          <div className="oqp-stat-label">{T.stats.jobsLabel}</div>
          <div className="oqp-stat-value">{jobs ?? 0}</div>
        </div>
      </div>
    </section>
  );
}

// ── Small shared bits ──
function ViewField({ label, value }: { label: string; value: string }) {
  return (
    <div className="oqp-view-field">
      <label>{label}</label>
      <div className="oqp-view-value">{value}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="oqp-form-group">
      <label className="oqp-label">{label}</label>
      {children}
    </div>
  );
}

const STYLES = `
  .oqp-loading { display:flex; align-items:center; justify-content:center; min-height:50vh; }
  .oqp-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:oqp-spin .8s linear infinite; }
  @keyframes oqp-spin { to { transform:rotate(360deg); } }
  .oqp-wrap { max-width:900px; margin:0 auto; padding:2rem 1.5rem 3rem; color:var(--white,#fff); }
  .oqp-page-title { font-size:1.8rem; margin:0 0 1.5rem; }
  .oqp-card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:1.5rem; margin-bottom:1.5rem; }
  .oqp-card-title { display:flex; align-items:center; gap:.5rem; font-size:1.2rem; margin:0 0 1rem; }
  .oqp-card-intro { color:var(--slate,#94a3b8); font-size:.88rem; margin:0 0 1rem; line-height:1.55; }
  .oqp-info-box { background:rgba(255,255,255,0.04); border-radius:8px; padding:.85rem 1rem; font-size:.85rem; color:var(--slate,#cbd5e1); margin-bottom:1rem; line-height:1.5; }
  .oqp-info-box-warn { background:rgba(245,158,11,0.08); border-left:3px solid var(--amber,#E07B00); }
  .oqp-view-field { padding:.55rem 0; border-bottom:1px solid rgba(255,255,255,0.06); }
  .oqp-view-field label { display:block; font-size:.72rem; color:var(--slate,#94a3b8); text-transform:uppercase; letter-spacing:.03em; margin-bottom:.25rem; }
  .oqp-view-value { font-size:.92rem; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
  .oqp-view-value a { color:var(--amber,#E07B00); text-decoration:none; }
  .oqp-muted { color:var(--slate,#94a3b8); }
  .oqp-form { display:flex; flex-direction:column; gap:1rem; margin-top:.5rem; }
  .oqp-form-group { display:flex; flex-direction:column; gap:.35rem; }
  .oqp-label { font-size:.8rem; color:var(--slate,#94a3b8); font-weight:600; }
  .oqp-input { padding:.55rem .75rem; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.05); color:var(--white,#fff); font-family:inherit; font-size:.9rem; width:100%; box-sizing:border-box; }
  .oqp-textarea { min-height:80px; resize:vertical; }
  .oqp-check { display:flex; align-items:center; gap:.5rem; font-size:.9rem; }
  .oqp-help { font-size:.8rem; color:var(--slate,#94a3b8); margin:.25rem 0 0; line-height:1.5; }
  .oqp-actions { display:flex; gap:.75rem; flex-wrap:wrap; margin-top:.5rem; }
  .oqp-btn { border:none; border-radius:8px; padding:.55rem 1.1rem; font-size:.85rem; font-weight:700; cursor:pointer; font-family:inherit; }
  .oqp-btn-primary { background:var(--amber,#E07B00); color:var(--navy,#0B1929); }
  .oqp-btn-secondary { background:transparent; color:var(--white,#fff); border:1.5px solid rgba(255,255,255,0.25); }
  .oqp-btn:disabled { opacity:.6; cursor:default; }
  .oqp-btn-sm { border:none; border-radius:6px; padding:.35rem .7rem; font-size:.78rem; font-weight:600; cursor:pointer; font-family:inherit; }
  .oqp-btn-sm-primary { background:var(--amber,#E07B00); color:var(--navy,#0B1929); }
  .oqp-btn-sm-secondary { background:rgba(255,255,255,0.06); color:var(--white,#fff); border:1px solid rgba(255,255,255,0.15); }
  .oqp-btn-sm-amber { background:#E07B00; color:#fff; }
  .oqp-btn-sm:disabled { opacity:.6; cursor:default; }
  .oqp-link-btn { background:none; border:none; color:#FCA5A5; cursor:pointer; font-size:.8rem; font-family:inherit; }
  .oqp-badge { display:inline-block; padding:.2rem .55rem; border-radius:999px; font-size:.72rem; font-weight:700; }
  .oqp-badge-ok { background:rgba(21,128,61,0.18); color:#86EFAC; }
  .oqp-badge-pending { background:rgba(148,163,184,0.2); color:#CBD5E1; }
  .oqp-cert-list, .oqp-cert-edit-list { margin:.25rem 0 0; padding-left:1.1rem; }
  .oqp-cert-edit-list { list-style:none; padding-left:0; display:flex; flex-direction:column; gap:.4rem; }
  .oqp-cert-edit-list li { display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.04); border-radius:6px; padding:.4rem .7rem; font-size:.85rem; }
  .oqp-cert-add { display:flex; gap:.5rem; }
  .oqp-video { width:100%; max-width:480px; aspect-ratio:16/9; border-radius:8px; display:block; margin:0 0 1rem; background:#000; }
  .oqp-cert-status { font-size:.85rem; min-height:1.2em; }
  .oqp-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:1rem; }
  .oqp-stat { background:rgba(255,255,255,0.04); border-radius:8px; padding:1rem; text-align:center; }
  .oqp-stat-label { font-size:.72rem; color:var(--slate,#94a3b8); text-transform:uppercase; }
  .oqp-stat-value { font-size:1.8rem; font-weight:800; color:var(--amber,#E07B00); }
  /* service-area editor */
  .oqp-svc-intro { font-size:.85rem; color:var(--slate,#94a3b8); margin:0 0 1rem; }
  .oqp-svc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:.4rem; max-height:210px; overflow-y:auto; border:1px solid rgba(255,255,255,0.12); border-radius:8px; padding:.75rem; margin-bottom:1rem; }
  .oqp-svc-state { display:flex; align-items:center; gap:.4rem; font-size:.8rem; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .oqp-cb { accent-color:var(--amber,#E07B00); width:14px; height:14px; flex-shrink:0; }
  .oqp-svc-configs { display:flex; flex-direction:column; gap:1rem; margin-bottom:1.5rem; }
  .oqp-svc-config { border:1px solid rgba(255,255,255,0.12); border-radius:8px; padding:1rem; background:rgba(255,255,255,0.03); }
  .oqp-svc-config-name { font-weight:600; margin-bottom:.75rem; }
  .oqp-svc-modes { display:flex; gap:1.5rem; margin-bottom:.75rem; }
  .oqp-svc-mode { display:flex; align-items:center; gap:.4rem; font-size:.85rem; cursor:pointer; }
  .oqp-svc-county-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:3px; max-height:190px; overflow-y:auto; border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:.5rem; }
  .oqp-svc-county { display:flex; align-items:center; gap:5px; font-size:.78rem; cursor:pointer; }
  .oqp-svc-county-actions { margin-top:.5rem; display:flex; gap:.75rem; }
  .oqp-svc-county-actions button { font-size:.75rem; color:var(--amber,#E07B00); background:none; border:none; cursor:pointer; padding:0; }
  .oqp-svc-hint { font-size:.8rem; color:var(--slate,#94a3b8); padding:.5rem; }
  .oqp-svc-err { font-size:.8rem; color:#FCA5A5; padding:.5rem; }
  /* template grids */
  .oqp-autofill { margin-bottom:1.5rem; }
  .oqp-autofill h3 { font-size:1rem; margin:0 0 .5rem; color:var(--slate,#cbd5e1); }
  .oqp-autofill-grid { display:grid; grid-template-columns:1fr 1fr; gap:.4rem; font-size:.85rem; }
  .oqp-template-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:1rem; margin-top:1rem; }
  .oqp-slot { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:1rem; }
  .oqp-slot-head { font-weight:600; margin-bottom:.6rem; font-size:.9rem; }
  .oqp-slot-sub { color:var(--slate,#94a3b8); font-size:.8rem; margin-bottom:.5rem; }
  .oqp-slot-file-name { font-size:.85rem; font-weight:600; word-break:break-all; }
  .oqp-slot-file-date { font-size:.75rem; color:var(--slate,#94a3b8); margin-bottom:.5rem; }
  .oqp-slot-btns { display:flex; gap:.4rem; flex-wrap:wrap; }
  .oqp-upload-box { display:flex; flex-direction:column; align-items:center; gap:.25rem; width:100%; background:rgba(255,255,255,0.03); border:1px dashed rgba(255,255,255,0.2); border-radius:8px; padding:1rem; cursor:pointer; color:var(--white,#fff); font-family:inherit; }
  .oqp-upload-box:disabled { opacity:.6; cursor:default; }
  .oqp-upload-icon { font-size:1.5rem; }
  .oqp-upload-text { font-size:.85rem; font-weight:600; }
  .oqp-upload-hint { font-size:.72rem; color:var(--slate,#94a3b8); }
  /* D-199 validation */
  .oqp-val { margin-top:.75rem; padding:.6rem .75rem; border-radius:6px; font-size:.82rem; }
  .oqp-val.val-pending { background:#FEF3C7; color:#92400E; }
  .oqp-val.val-ok { background:#D1FAE5; color:#065F46; }
  .oqp-val.val-needs { background:#FEE2E2; color:#991B1B; }
  .oqp-val.val-review { background:#DBEAFE; color:#1E40AF; }
  .oqp-val.val-rejected { background:#FCE7F3; color:#9F1239; }
  .oqp-val-row { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
  .oqp-val-icon { font-weight:700; }
  .oqp-val-toggle { background:none; border:none; color:inherit; font-weight:600; cursor:pointer; text-decoration:underline; font-size:.82rem; font-family:inherit; }
  .oqp-val-anchors { margin-top:.5rem; }
  .oqp-val-anchors-head { font-weight:600; margin-bottom:.25rem; }
  .oqp-anchor { padding:3px 6px; border-radius:3px; display:inline-block; margin:2px 3px 2px 0; font-family:ui-monospace,monospace; font-size:.72rem; }
  .oqp-anchor.found { background:#D1FAE5; color:#065F46; }
  .oqp-anchor.missing { background:#FEE2E2; color:#991B1B; }
  .oqp-val-actions { margin-top:.5rem; display:flex; gap:.5rem; flex-wrap:wrap; }
  /* modals */
  .oqp-modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:1000; display:flex; align-items:flex-start; justify-content:center; padding:40px 16px; overflow-y:auto; }
  .oqp-modal { background:#fff; color:#0D1B2E; border-radius:10px; max-width:600px; width:100%; box-shadow:0 18px 50px rgba(0,0,0,0.35); }
  .oqp-modal-wide { max-width:760px; }
  .oqp-modal-head { padding:1.1rem 1.4rem; border-bottom:1px solid #E5E7EB; display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; }
  .oqp-modal-head h3 { margin:0; font-size:1.15rem; }
  .oqp-modal-head p { margin:.35rem 0 0; font-size:.88rem; color:#4B5563; }
  .oqp-modal-x { background:none; border:none; font-size:1.4rem; cursor:pointer; color:#6B7280; line-height:1; }
  .oqp-modal-body { padding:1.1rem 1.4rem; max-height:60vh; overflow-y:auto; }
  .oqp-modal-foot { padding:.9rem 1.4rem; border-top:1px solid #E5E7EB; display:flex; justify-content:flex-end; gap:.6rem; flex-wrap:wrap; }
  .oqp-fm-intro { font-size:.88rem; color:#475569; margin:0 0 1rem; }
  .oqp-fm-headings, .oqp-fm-row { display:grid; grid-template-columns:1fr auto 1fr; gap:.5rem; align-items:center; }
  .oqp-fm-headings { font-size:.72rem; font-weight:600; color:#6B7280; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.5rem; }
  .oqp-fm-rows { display:flex; flex-direction:column; gap:.5rem; }
  .oqp-fm-row .oqp-input { color:#0D1B2E; background:#fff; border:1px solid #D1D5DB; }
  .oqp-fm-arrow { color:#6B7280; text-align:center; }
  .oqp-fm-desc { font-size:.85rem; color:#374151; }
  .oqp-fm-status { padding:0 1.4rem 1rem; font-size:.85rem; text-align:right; }
  .oqp-modal-summary { background:#F3F4F6; border-radius:6px; padding:.6rem .75rem; font-size:.85rem; margin-bottom:.9rem; color:#374151; }
  .oqp-anchor-row { padding:.9rem; border:1px solid #E5E7EB; border-radius:6px; margin-bottom:.75rem; background:#F9FAFB; }
  .oqp-anchor-row.choice-have { border-color:#10B981; background:#ECFDF5; }
  .oqp-anchor-row.choice-missing { border-color:#DC2626; background:#FEF2F2; }
  .oqp-anchor-row code { font-family:ui-monospace,monospace; font-size:.85rem; background:#fff; border:1px solid #E5E7EB; padding:2px 6px; border-radius:3px; }
  .oqp-anchor-field { font-size:.78rem; color:#6B7280; margin-top:.15rem; }
  .oqp-anchor-choices { display:flex; gap:.5rem; margin-top:.6rem; flex-wrap:wrap; }
  .oqp-choice { padding:.4rem .75rem; border-radius:4px; border:1px solid #D1D5DB; background:#fff; font-size:.82rem; font-weight:600; cursor:pointer; color:#0D1B2E; }
  .oqp-choice.active { background:#0D1B2E; color:#fff; border-color:#0D1B2E; }
  .oqp-choice.missing.active { background:#DC2626; border-color:#DC2626; }
  .oqp-anchor-input { margin-top:.6rem; }
  .oqp-anchor-input label { display:block; font-size:.82rem; color:#374151; margin-bottom:.25rem; font-weight:600; }
  .oqp-anchor-input input { width:100%; padding:.5rem .6rem; border:1px solid #D1D5DB; border-radius:4px; font-size:.9rem; box-sizing:border-box; }
  .oqp-anchor-input small { display:block; margin-top:.25rem; font-size:.75rem; color:#6B7280; }
  .oqp-modal-err { color:#B91C1C; font-size:.85rem; margin-top:.5rem; }
  @media (max-width:768px){ .oqp-autofill-grid{ grid-template-columns:1fr; } }
`;
