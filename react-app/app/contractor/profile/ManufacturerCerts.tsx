'use client';

/**
 * Manufacturer Certifications card (D-204) — port of the contractor-profile.html
 * cert-verification card + helpers (__d204*, renderD204CertBadges, submitCertClaim).
 *
 * Reads warranty_options (cert tiers) + contractor_cert_verifications. Submit uploads
 * the cert letter to the cert-letters bucket and inserts a pending verification row —
 * BOTH contracts UNCHANGED from the static page. All DB-sourced strings render as React
 * text (never innerHTML) — the static page hand-escaped via __d204EscHtml; JSX makes it
 * safe by construction.
 *
 * ⚠️ The contractor_cert_verifications RLS policy compares contractor_id to auth.uid()
 * (wrong column) — a Tier-3 backend defect filed for migration-author. This page does
 * not work around it; it issues the same insert the static page does (contract unchanged).
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { PROFILE_COPY as T } from './copy';
import {
  manufacturersWithCert, certTiersFor, splitCertVerifications, certStatusStyle,
  certSourceLabel, isCertExpiringSoon, certLetterPath, validateCertClaim,
  type WarrantyOption, type CertVerification,
} from './utils';

export function ManufacturerCerts({ contractorId, userId }: { contractorId: string; userId: string }) {
  const [editing, setEditing] = useState(false);
  const [options, setOptions] = useState<WarrantyOption[]>([]);
  const [rows, setRows] = useState<CertVerification[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [mfr, setMfr] = useState('');
  const [certName, setCertName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<{ msg: string; color: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadVerifications = useCallback(async () => {
    const { data } = await supabase
      .from('contractor_cert_verifications')
      .select('id,manufacturer,cert_name,status,source,source_url,verified_at,expires_at,notes,created_at')
      .eq('contractor_id', contractorId)
      .order('created_at', { ascending: false });
    setRows((data as CertVerification[]) ?? []);
  }, [contractorId]);

  useEffect(() => {
    let active = true;
    (async () => {
      const [optRes] = await Promise.all([
        supabase
          .from('warranty_options')
          .select('id,manufacturer,tier,cert_required,cert_lookup_url,active')
          .eq('active', true)
          .order('manufacturer', { ascending: true })
          .order('tier', { ascending: true }),
        loadVerifications(),
      ]);
      if (!active) return;
      setOptions((optRes.data as WarrantyOption[]) ?? []);
      setLoaded(true);
    })();
    return () => { active = false; };
  }, [loadVerifications]);

  const manufacturers = manufacturersWithCert(options);
  const tiers = certTiersFor(options, mfr);
  const { verified, other } = splitCertVerifications(rows);

  async function submit() {
    const err = validateCertClaim(mfr, certName, file);
    if (err) { setStatus({ msg: err, color: '#FCA5A5' }); return; }
    if (!file) return;
    setSubmitting(true);
    setStatus({ msg: T.certVerifications.uploading, color: '#94a3b8' });
    try {
      const path = certLetterPath(userId, mfr, certName, file.name, Date.now());
      const { error: upErr } = await supabase.storage.from('cert-letters').upload(path, file, { cacheControl: '3600', upsert: false });
      if (upErr) { setStatus({ msg: 'Upload error: ' + upErr.message, color: '#FCA5A5' }); return; }

      setStatus({ msg: T.certVerifications.submitting, color: '#94a3b8' });
      const { error: insErr } = await supabase.from('contractor_cert_verifications').insert({
        contractor_id: contractorId,
        manufacturer: mfr,
        cert_name: certName,
        status: 'pending',
        source: 'admin_upload',
        evidence_storage_path: path,
        notes: 'Submitted by contractor; awaiting admin review.',
      });
      if (insErr) { setStatus({ msg: 'Submit error: ' + insErr.message, color: '#FCA5A5' }); return; }

      setStatus({ msg: T.certVerifications.submitted, color: '#6EE7B7' });
      await loadVerifications();
      setMfr(''); setCertName(''); setFile(null);
      setTimeout(() => { setEditing(false); setStatus(null); }, 1200);
    } catch (e) {
      setStatus({ msg: 'Error: ' + (e instanceof Error ? e.message : String(e)), color: '#FCA5A5' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="oqp-card" id="cert-verifications">
      <h2 className="oqp-card-title"><span aria-hidden="true">🛡️</span>{T.certVerifications.title}</h2>
      <p className="oqp-card-intro">{T.certVerifications.intro}</p>

      {!editing ? (
        <>
          <div className="oqp-cert-badges">
            {!loaded ? (
              <div className="oqp-cert-empty">Loading certifications…</div>
            ) : rows.length === 0 ? (
              <div className="oqp-cert-empty">{T.certVerifications.empty}</div>
            ) : (
              <>
                {verified.map((r, i) => {
                  const expSoon = isCertExpiringSoon(r.expires_at);
                  const verifiedDate = r.verified_at ? new Date(r.verified_at).toLocaleDateString() : '—';
                  const expiresDate = r.expires_at ? new Date(r.expires_at).toLocaleDateString() : '—';
                  return (
                    <div className="oqp-cert oqp-cert-verified" key={r.id ?? `v${i}`}>
                      <div>
                        <strong>{r.manufacturer} — {r.cert_name}</strong>
                        <div className="oqp-cert-sub">
                          {certSourceLabel(r.source)} • verified {verifiedDate} • expires {expiresDate}
                          {expSoon && <span className="oqp-cert-soon"> — renewal due soon</span>}
                        </div>
                      </div>
                      <span className="oqp-cert-tag oqp-cert-tag-verified">{T.certVerifications.verifiedTag}</span>
                    </div>
                  );
                })}
                {other.map((r, i) => {
                  const st = certStatusStyle(r.status);
                  const created = r.created_at ? new Date(r.created_at).toLocaleDateString() : '—';
                  return (
                    <div className="oqp-cert" key={r.id ?? `o${i}`} style={{ background: st.bg, border: `1px solid ${st.border}` }}>
                      <div>
                        <strong style={{ color: st.text }}>{r.manufacturer} — {r.cert_name}</strong>
                        <div className="oqp-cert-sub" style={{ color: st.text }}>
                          {r.notes || 'Awaiting verification'} • submitted {created}
                        </div>
                      </div>
                      <span className="oqp-cert-tag" style={{ background: st.text }}>{st.tag}</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
          <button type="button" className="oqp-btn oqp-btn-primary" onClick={() => setEditing(true)}>{T.certVerifications.add}</button>
        </>
      ) : (
        <div className="oqp-form">
          <div className="oqp-form-group">
            <label className="oqp-label" htmlFor="certMfr">{T.certVerifications.manufacturerLabel}</label>
            <select id="certMfr" className="oqp-input" value={mfr} onChange={(e) => { setMfr(e.target.value); setCertName(''); }}>
              <option value="">{T.certVerifications.manufacturerPlaceholder}</option>
              {manufacturers.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="oqp-form-group">
            <label className="oqp-label" htmlFor="certTier">{T.certVerifications.tierLabel}</label>
            <select id="certTier" className="oqp-input" value={certName} disabled={!mfr} onChange={(e) => setCertName(e.target.value)}>
              <option value="">{mfr ? T.certVerifications.tierPlaceholder : T.certVerifications.tierPlaceholderFirst}</option>
              {tiers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <p className="oqp-help">{T.certVerifications.tierHelp}</p>
          </div>
          <div className="oqp-form-group">
            <label className="oqp-label" htmlFor="certFile">{T.certVerifications.fileLabel}</label>
            <input id="certFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="oqp-input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="oqp-help">{T.certVerifications.fileHelp}</p>
          </div>
          {status && <div className="oqp-cert-status" style={{ color: status.color }}>{status.msg}</div>}
          <div className="oqp-actions">
            <button type="button" className="oqp-btn oqp-btn-primary" disabled={submitting} onClick={submit}>{T.certVerifications.submit}</button>
            <button type="button" className="oqp-btn oqp-btn-secondary" disabled={submitting} onClick={() => { setEditing(false); setStatus(null); }}>{T.certVerifications.cancel}</button>
          </div>
        </div>
      )}
    </section>
  );
}
