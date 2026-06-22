'use client';

/**
 * Contractor Auto-Bid Settings — D-211 Phase 3 (port of contractor-auto-bids.html).
 * Auto-bid value-adds the process-auto-bids cron consumes. Wrapped by the reusable
 * ContractorShell. Reuses the shared auth scaffolding + contractor-track shell —
 * does NOT re-implement auth or the CPA gate.
 *
 * Nav (Tier-A call): auto-bid configuration is settings-natured and the static
 * top-level contractor nav (Home/Opportunities/Profile/Settings) has no auto-bids
 * entry, so this page nests under "settings" (active="settings"). The shared shell
 * + nav are NOT modified (lower blast radius; one page = one PR).
 *
 * Gating parity: the static initAutoBids() applies ONLY the CPA guard (no status
 * redirect). So → enforceCpaRedirect; a pending contractor sees a NON-blocking
 * notice (isPendingApproval) and can still configure (settings only fire once the
 * cron sees status='active'). NO Edge Function is called from this page.
 *
 * §6.1 client fold: the static page nulls + re-creates the global `sb` behind a
 * guard on CONFIG.SUPABASE_ANON — this port uses the shared supabase singleton and
 * does NOT replicate that pattern (so a contractor is never bounced to login here).
 *
 * One intentional Tier-B fold: the static page hides the Save button when the
 * toggle is OFF (so "disable auto-bid" can't be persisted). Here the Save button
 * is always visible so toggling off can be saved.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { ContractorShell } from '../_shell/ContractorShell';
import { useContractorRecordGate, type ContractorRecord } from '../_shell/use-contractor-record';
import { enforceCpaRedirect } from '../_shell/cpa-guard';
import { isPendingApproval } from '../_shell/contractor-gating';
import { AB_COPY as T,
  GUTTER_OPTIONS, CHIMNEY_FLASHING_OPTIONS, GUTTER_GUARD_OPTIONS, GUTTER_GUARD_TYPES,
  CHIMNEY_REFLASH_OPTIONS, UNDERLAYMENT_OPTIONS, STARTER_STRIP_OPTIONS, OTHER_TRADES_OPTIONS,
  WARRANTY_ROWS, OTHER_SHINGLE_BRANDS, type Opt,
} from './copy';
import {
  emptyAutoBidForm, hydrateAutoBidForm, buildAutoBidPayload, buildBidPreview,
  type AutoBidForm, type WarrantyKey, type WarrantyRow,
} from './utils';

const DASHBOARD_ROUTE = '/contractor/dashboard';
type SaveState = 'idle' | 'saving' | 'saved' | 'error-conn' | 'error';

export default function ContractorAutoBidsPage() {
  return (
    <ContractorShell active="settings">
      <AutoBidsContent />
    </ContractorShell>
  );
}

function AutoBidsContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;
  const { contractor, loading: contractorLoading } = useContractorRecordGate(userId);
  const router = useRouter();

  const [gateResolved, setGateResolved] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  // Gating — matches the static initAutoBids(): CPA guard only (no status redirect).
  useEffect(() => {
    if (!contractor) return;
    if (enforceCpaRedirect(contractor, router.replace, DASHBOARD_ROUTE)) {
      setRedirecting(true);
      return;
    }
    setGateResolved(true);
  }, [contractor, router]);

  if (contractorLoading || !contractor || redirecting || !gateResolved) {
    return <div className="oqa-loading"><div className="oqa-spin" /><style>{STYLES}</style></div>;
  }

  return <AutoBidsForm contractor={contractor} />;
}

function AutoBidsForm({ contractor }: { contractor: ContractorRecord }) {
  const [form, setForm] = useState<AutoBidForm>(() =>
    hydrateAutoBidForm(contractor.auto_bid_enabled, contractor.auto_bid_value_adds),
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const pending = isPendingApproval(contractor);

  const set = <K extends keyof AutoBidForm>(k: K, v: AutoBidForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const toggleArr = (k: 'otherShingles' | 'otherTrades', val: string) =>
    setForm((f) => {
      const has = f[k].includes(val);
      return { ...f, [k]: has ? f[k].filter((x) => x !== val) : [...f[k], val] };
    });
  const setWarranty = (key: WarrantyKey, patch: Partial<WarrantyRow>) =>
    setForm((f) => ({ ...f, warranty: { ...f.warranty, [key]: { ...f.warranty[key], ...patch } } }));

  const preview = useMemo(() => buildBidPreview(form, contractor), [form, contractor]);

  const save = async () => {
    if (!contractor.id) {
      setSaveState('error-conn');
      window.setTimeout(() => setSaveState('idle'), 2000);
      return;
    }
    setSaveState('saving');
    try {
      const payload = buildAutoBidPayload(form);
      const { error } = await supabase.from('contractors').update(payload).eq('id', contractor.id);
      if (error) throw error;
      if (typeof window !== 'undefined' && typeof (window as unknown as { gtag?: unknown }).gtag === 'function') {
        (window as unknown as { gtag: (...a: unknown[]) => void }).gtag('event', 'auto_bid_settings_saved', {
          contractor_id: contractor.id, auto_bid_enabled: payload.auto_bid_enabled,
        });
      }
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 2000);
    } catch (e) {
      console.error('Error saving auto-bid settings:', e);
      setSaveState('error');
      window.setTimeout(() => setSaveState('idle'), 2000);
    }
  };

  const saveLabel =
    saveState === 'saving' ? T.saving
    : saveState === 'saved' ? T.saved
    : saveState === 'error-conn' ? T.saveErrorNotConnected
    : saveState === 'error' ? T.saveErrorRetry
    : T.saveButton;

  return (
    <div className="oqa-wrap">
      <style>{STYLES}</style>

      <div className="oqa-header">
        <h1>{T.pageTitle}</h1>
        <p>{T.pageSubtitle}</p>
      </div>

      {pending && <div className="oqa-pending" role="status">{T.pendingNotice}</div>}

      <div className="oqa-card">
        <div className="oqa-card-title">{T.cardTitle}</div>
        <p className="oqa-card-sub">{T.cardSubtitle}</p>

        <div className="oqa-toggle-row">
          <label className="oqa-switch">
            <input type="checkbox" checked={form.autoBidEnabled} onChange={(e) => set('autoBidEnabled', e.target.checked)} />
            <span className="oqa-slider" />
          </label>
          <div className="oqa-toggle-label">{T.toggleLabel} <span className="oqa-toggle-suffix">{T.toggleSuffix}</span></div>
          <span className={'oqa-status ' + (form.autoBidEnabled ? 'is-on' : 'is-off')}>
            {form.autoBidEnabled ? T.statusOn : T.statusOff}
          </span>
        </div>

        {form.autoBidEnabled && (
          <div className="oqa-details">
            <div className="oqa-infobox">{T.howItWorks}</div>

            <div className="oqa-summary">
              <div className="oqa-summary-title">{T.summaryTitle}</div>
              {T.summaryItems.map((it) => (
                <div className="oqa-summary-item" key={it.k}>
                  <span className="oqa-check">✓</span>
                  <span><strong>{it.k}</strong> {it.v}
                    {it.k === 'Location:' && (
                      <> &nbsp;<a className="oqa-inline-link" href={T.manageServiceAreaHref}>{T.manageServiceAreaLabel}</a></>
                    )}
                  </span>
                </div>
              ))}
            </div>

            <div className="oqa-infobox">{T.tip}</div>

            <div className="oqa-preview-wrap">
              <button type="button" className="oqa-preview-toggle" onClick={() => setPreviewOpen((v) => !v)}>
                {previewOpen ? T.previewToggleHide : T.previewToggleShow}
              </button>
              {previewOpen && <BidPreviewPanel preview={preview} />}
            </div>

            <div className="oqa-valueadds">
              <div className="oqa-section-heading">{T.valueAddsHeading}</div>
              <p className="oqa-warn-note"><strong>{T.valueAddsWarning}</strong></p>

              {/* Gutters */}
              <Section title="Gutters">
                <div className="oqa-radio-col">
                  {GUTTER_OPTIONS.map((o) => (
                    <label className="oqa-radio" key={o.value}>
                      <input type="radio" name="abGutterOption" checked={form.gutterOption === o.value} onChange={() => set('gutterOption', o.value as AutoBidForm['gutterOption'])} />
                      {o.value === 'other' ? (
                        <>Other: <input type="text" className="oqa-inline-text" placeholder="Describe..." value={form.gutterOther} onChange={(e) => set('gutterOther', e.target.value)} /></>
                      ) : o.label}
                    </label>
                  ))}
                </div>
              </Section>

              {/* Chimney Flashing */}
              <Section title="Chimney Flashing">
                <RadioGroup name="abChimneyFlashing" value={form.chimneyFlashing} options={CHIMNEY_FLASHING_OPTIONS} onChange={(v) => set('chimneyFlashing', v as AutoBidForm['chimneyFlashing'])} />
              </Section>

              {/* Gutter Guards */}
              <Section title="Gutter Guards">
                <div className="oqa-radio-col">
                  {GUTTER_GUARD_OPTIONS.map((o) => (
                    <label className="oqa-radio" key={o.value}>
                      <input type="radio" name="abGutterGuards" checked={form.gutterGuards === o.value} onChange={() => set('gutterGuards', o.value as AutoBidForm['gutterGuards'])} />
                      {o.value === 'included' ? (
                        <>Included — Type:&nbsp;
                          <select className="oqa-inline-select" value={form.gutterGuardType} onChange={(e) => set('gutterGuardType', e.target.value as AutoBidForm['gutterGuardType'])}>
                            {GUTTER_GUARD_TYPES.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                          </select>
                        </>
                      ) : o.value === 'other' ? (
                        <>Other: <input type="text" className="oqa-inline-text" placeholder="Describe your gutter guard offering..." value={form.gutterGuardsOther} onChange={(e) => set('gutterGuardsOther', e.target.value)} /></>
                      ) : o.label}
                    </label>
                  ))}
                </div>
              </Section>

              {/* Chimney Reflash */}
              <Section title="Chimney Reflash">
                <div className="oqa-radio-col">
                  {CHIMNEY_REFLASH_OPTIONS.map((o) => (
                    <label className="oqa-radio" key={o.value}>
                      <input type="radio" name="abChimneyReflash" checked={form.chimneyReflash === o.value} onChange={() => set('chimneyReflash', o.value as AutoBidForm['chimneyReflash'])} />
                      {o.value === 'oop' ? (
                        <>OOP cost of $<input type="number" min="0" step="1" className="oqa-inline-num" placeholder="0" value={form.chimneyReflashOop} onChange={(e) => set('chimneyReflashOop', e.target.value)} /></>
                      ) : o.label}
                    </label>
                  ))}
                </div>
              </Section>

              {/* Preferred Shingle */}
              <Section title={T.preferredShingleHeading} hint={T.preferredShingleHint}>
                <TextField label={T.preferredBrandLabel} placeholder={T.preferredBrandPlaceholder} value={form.preferredShingleBrand} onChange={(v) => set('preferredShingleBrand', v)} />
                <TextField label={T.preferredLineLabel} placeholder={T.preferredLinePlaceholder} value={form.preferredShingleLine} onChange={(v) => set('preferredShingleLine', v)} />
              </Section>

              {/* Other Shingles */}
              <Section title={T.otherShinglesHeading} hint={T.otherShinglesHint}>
                {OTHER_SHINGLE_BRANDS.map((b) => (
                  <div className="oqa-shingle-brand" key={b.brand}>
                    <div className="oqa-brand-label">{b.brand}</div>
                    <div className="oqa-checkgrid">
                      {b.items.map((it) => (
                        <label className="oqa-check" key={it.value}>
                          <input type="checkbox" checked={form.otherShingles.includes(it.value)} onChange={() => toggleArr('otherShingles', it.value)} /> {it.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </Section>

              {/* Underlayment */}
              <Section title="Underlayment">
                <RadioGroup name="abUnderlayment" value={form.underlayment} options={UNDERLAYMENT_OPTIONS} onChange={(v) => set('underlayment', v as AutoBidForm['underlayment'])} />
              </Section>

              {/* Starter Strip */}
              <Section title="Starter Strip">
                <RadioGroup name="abStarterStrip" value={form.starterStrip} options={STARTER_STRIP_OPTIONS} onChange={(v) => set('starterStrip', v as AutoBidForm['starterStrip'])} />
              </Section>

              {/* Ventilation */}
              <Section title="Ventilation">
                <CheckRow checked={form.ventRidgeUpgrade} onChange={(c) => set('ventRidgeUpgrade', c)} label="Free Ridge Vent Upgrade" />
                <label className="oqa-check">
                  <input type="checkbox" checked={form.ventOtherCheck} onChange={(e) => set('ventOtherCheck', e.target.checked)} />
                  Other: <input type="text" className="oqa-inline-text" placeholder="Describe ventilation offering..." value={form.ventOtherText} onChange={(e) => set('ventOtherText', e.target.value)} />
                </label>
              </Section>

              {/* Attic / Other Services */}
              <Section title="Attic Inspection & Other Services">
                <CheckRow checked={form.freeAtticInspection} onChange={(c) => set('freeAtticInspection', c)} label="Free Attic Inspection" />
                <TextArea label="Other Services Included" placeholder="Describe any other services included with your bid (e.g., free annual roof inspection, satellite measurement, photos documenting damage)..." value={form.otherServices} onChange={(v) => set('otherServices', v)} maxLength={1000} />
              </Section>

              {/* Cleanup */}
              <Section title="Cleanup Guarantee" hint="Describe your cleanup commitment to homeowners.">
                <TextArea placeholder="e.g., We perform a thorough magnetic nail sweep, remove all debris, and leave your property cleaner than we found it. Guaranteed." value={form.cleanupGuarantee} onChange={(v) => set('cleanupGuarantee', v)} maxLength={1000} />
              </Section>

              {/* Property Protection */}
              <Section title="Property Protection Services">
                <CheckRow checked={form.propEquipter} onChange={(c) => set('propEquipter', c)} label="Equipter (debris containment lift)" />
                <CheckRow checked={form.propCatchAll} onChange={(c) => set('propCatchAll', c)} label="Catch-All (ground protection tarps / containment system)" />
                <label className="oqa-check">
                  <input type="checkbox" checked={form.propOtherCheck} onChange={(e) => set('propOtherCheck', e.target.checked)} />
                  Other: <input type="text" className="oqa-inline-text" placeholder="Describe other property protection..." value={form.propOtherText} onChange={(e) => set('propOtherText', e.target.value)} />
                </label>
              </Section>

              {/* Warranty */}
              <Section title={T.warrantyHeading} hint={T.warrantyHint}>
                <div className="oqa-warn-note">⚠️ {T.warrantyDisclaimerBanner}</div>
                {WARRANTY_ROWS.map((row) => {
                  const w = form.warranty[row.key];
                  return (
                    <div className="oqa-warr-row" key={row.key}>
                      <label className="oqa-check oqa-check-strong">
                        <input type="checkbox" checked={w.offered} onChange={(e) => setWarranty(row.key, { offered: e.target.checked })} /> {row.label}
                      </label>
                      <textarea className="oqa-textarea" placeholder={row.placeholder} maxLength={500} value={w.description} onChange={(e) => setWarranty(row.key, { description: e.target.value })} />
                    </div>
                  );
                })}
                <TextArea label={T.warrantyNotesLabel} placeholder="Any additional notes about your warranty terms, registration requirements, transferability, etc." value={form.warrantyNotes} onChange={(v) => set('warrantyNotes', v)} maxLength={1000} />
              </Section>

              {/* Other Offers */}
              <Section title={T.otherOffersHeading} hint={T.otherOffersHint}>
                <TextArea placeholder="e.g., 0% financing for 12 months, free annual inspection for 5 years..." value={form.otherOffers} onChange={(v) => set('otherOffers', v)} maxLength={2000} />
              </Section>

              {/* Other Trades */}
              <Section title={T.otherTradesHeading} hint={T.otherTradesHint}>
                {OTHER_TRADES_OPTIONS.map((o) => (
                  <CheckRow key={o.value} checked={form.otherTrades.includes(o.value)} onChange={() => toggleArr('otherTrades', o.value)} label={o.label} />
                ))}
              </Section>
            </div>
          </div>
        )}

        <div className="oqa-save-row">
          <button type="button" className={'oqa-save' + (saveState === 'saved' ? ' is-saved' : (saveState === 'error' || saveState === 'error-conn') ? ' is-error' : '')}
            disabled={saveState === 'saving'} onClick={save}>
            {saveLabel}
          </button>
        </div>
      </div>

      <div className="oqa-future">
        <div className="oqa-future-title">{T.futureTitle} <span className="oqa-soon">{T.futureBadge}</span></div>
        <div className="oqa-future-desc">{T.futureDescription}</div>
      </div>
    </div>
  );
}

function BidPreviewPanel({ preview }: { preview: ReturnType<typeof buildBidPreview> }) {
  return (
    <div className="oqa-preview">
      <div className="oqa-preview-head">{T.previewHeader}</div>
      <div className="oqa-preview-body">
        <div className="oqa-preview-top">
          <div>
            <div className="oqa-preview-company">{preview.companyName}</div>
            <div className="oqa-preview-sub">{T.previewBidSubtitle}</div>
          </div>
          <div className="oqa-preview-amt">
            <div className="oqa-preview-amt-label">{T.previewBidAmountLabel}</div>
            <div className="oqa-preview-amt-val">{T.previewBidAmountValue}</div>
          </div>
        </div>
        <p className="oqa-preview-intro">{T.previewIntro.replace('{company}', preview.companyName)}</p>
        <p className="oqa-preview-acv">{T.previewAcvWarning}</p>
        <div className="oqa-preview-includes-h">{T.previewIncludesHeading}</div>
        <div className="oqa-preview-list">
          {preview.includes.length
            ? preview.includes.map((i, idx) => <div key={idx}>{i}</div>)
            : <div className="oqa-preview-empty">{T.previewEmpty}</div>}
        </div>
        {preview.warranty.length > 0 && (
          <div className="oqa-preview-warr">
            <div className="oqa-preview-includes-h">{T.previewWarrantyHeading}</div>
            <div className="oqa-preview-list">{preview.warranty.map((i, idx) => <div key={idx}>{i}</div>)}</div>
            {preview.warrantyDisclaimer && <div className="oqa-preview-disclaimer">{preview.warrantyDisclaimer}</div>}
          </div>
        )}
        <div className="oqa-preview-foot">{T.previewFootnote}</div>
      </div>
    </div>
  );
}

// ── small input building blocks ──
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="oqa-sec">
      <h4 className="oqa-sec-title">{title}</h4>
      {hint && <p className="oqa-sec-hint">{hint}</p>}
      {children}
    </div>
  );
}
function RadioGroup({ name, value, options, onChange }: { name: string; value: string; options: Opt[]; onChange: (v: string) => void }) {
  return (
    <div className="oqa-radio-col">
      {options.map((o) => (
        <label className="oqa-radio" key={o.value}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} /> {o.label}
        </label>
      ))}
    </div>
  );
}
function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (c: boolean) => void; label: string }) {
  return (
    <label className="oqa-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}
function TextField({ label, placeholder, value, onChange }: { label?: string; placeholder?: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="oqa-field">
      {label && <label className="oqa-field-label">{label}</label>}
      <input type="text" className="oqa-text" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function TextArea({ label, placeholder, value, onChange, maxLength }: { label?: string; placeholder?: string; value: string; onChange: (v: string) => void; maxLength?: number }) {
  return (
    <div className="oqa-field">
      {label && <label className="oqa-field-label">{label}</label>}
      <textarea className="oqa-textarea" placeholder={placeholder} maxLength={maxLength} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const STYLES = `
  .oqa-loading { display:flex; align-items:center; justify-content:center; min-height:50vh; }
  .oqa-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:oqa-spin .8s linear infinite; }
  @keyframes oqa-spin { to { transform:rotate(360deg); } }
  .oqa-wrap { max-width:860px; margin:0 auto; padding:2rem 1.5rem 3rem; color:var(--white,#fff); }
  .oqa-header h1 { font-size:1.8rem; margin:0 0 .25rem; }
  .oqa-header p { color:var(--slate,#94a3b8); margin:0 0 1.5rem; }
  .oqa-pending { background:rgba(224,123,0,0.1); border:1px solid rgba(224,123,0,0.4); border-radius:.6rem; padding:.85rem 1.1rem; margin-bottom:1.25rem; font-size:.88rem; }
  .oqa-card { background:#fff; color:#0F172A; border:1px solid #E2E8F0; border-radius:14px; padding:1.75rem; }
  .oqa-card-title { font-weight:700; font-size:1.05rem; color:#0B1929; }
  .oqa-card-sub { color:#475569; font-size:.9rem; margin:.4rem 0 1.25rem; line-height:1.5; }
  .oqa-toggle-row { display:flex; align-items:center; gap:1rem; padding:.5rem 0; flex-wrap:wrap; }
  .oqa-switch { position:relative; display:inline-block; width:46px; height:26px; flex-shrink:0; }
  .oqa-switch input { opacity:0; width:0; height:0; }
  .oqa-slider { position:absolute; cursor:pointer; inset:0; background:#CBD5E1; border-radius:999px; transition:.2s; }
  .oqa-slider:before { content:''; position:absolute; height:20px; width:20px; left:3px; bottom:3px; background:#fff; border-radius:50%; transition:.2s; }
  .oqa-switch input:checked + .oqa-slider { background:var(--amber,#E07B00); }
  .oqa-switch input:checked + .oqa-slider:before { transform:translateX(20px); }
  .oqa-toggle-label { font-weight:600; color:#0B1929; font-size:.95rem; }
  .oqa-toggle-suffix { font-weight:400; font-size:.82rem; color:#64748B; }
  .oqa-status { font-size:.75rem; font-weight:700; padding:.2rem .6rem; border-radius:6px; margin-left:auto; }
  .oqa-status.is-on { background:#D1FAE5; color:#065F46; }
  .oqa-status.is-off { background:#FEE2E2; color:#991B1B; }
  .oqa-details { margin-top:1.25rem; }
  .oqa-infobox { background:#F1F5F9; border-radius:8px; padding:1rem 1.1rem; font-size:.85rem; color:#334155; line-height:1.55; margin-bottom:1rem; }
  .oqa-summary { background:#0B1929; color:#E0E7FF; border-radius:10px; padding:1.1rem 1.25rem; margin-bottom:1rem; }
  .oqa-summary-title { font-weight:700; font-size:.9rem; color:var(--amber,#E07B00); margin-bottom:.6rem; }
  .oqa-summary-item { font-size:.85rem; padding:.25rem 0; display:flex; gap:.6rem; }
  .oqa-check { color:#34D399; font-weight:700; }
  .oqa-inline-link { color:var(--amber,#E07B00); font-weight:600; text-decoration:none; }
  .oqa-preview-wrap { margin:1rem 0; }
  .oqa-preview-toggle { width:100%; background:#0B1929; color:var(--amber,#E07B00); border:none; border-radius:8px; padding:.7rem 1rem; font-size:.875rem; font-weight:600; cursor:pointer; font-family:inherit; }
  .oqa-preview { margin-top:1rem; border:2px solid var(--amber,#E07B00); border-radius:10px; overflow:hidden; }
  .oqa-preview-head { background:#0B1929; color:var(--amber,#E07B00); padding:.7rem 1rem; font-size:.75rem; font-weight:700; letter-spacing:.5px; text-transform:uppercase; }
  .oqa-preview-body { background:#fff; padding:1.25rem; }
  .oqa-preview-top { display:flex; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
  .oqa-preview-company { font-weight:700; font-size:1.1rem; color:#0B1929; }
  .oqa-preview-sub { font-size:.85rem; color:#64748B; }
  .oqa-preview-amt { text-align:right; }
  .oqa-preview-amt-label { font-size:.8rem; color:#64748B; }
  .oqa-preview-amt-val { font-size:1.25rem; font-weight:700; color:#0B1929; }
  .oqa-preview-intro { font-size:.85rem; color:#374151; line-height:1.6; margin:.5rem 0; }
  .oqa-preview-acv { font-size:.8rem; font-weight:700; color:#991B1B; letter-spacing:.3px; margin:.5rem 0 1rem; }
  .oqa-preview-includes-h { font-size:.85rem; font-weight:700; color:#0B1929; margin:.5rem 0 .3rem; }
  .oqa-preview-list { font-size:.85rem; color:#374151; line-height:1.9; }
  .oqa-preview-empty { color:#94A3B8; }
  .oqa-preview-disclaimer { font-size:.75rem; color:#64748B; margin-top:.4rem; font-style:italic; }
  .oqa-preview-foot { margin-top:1rem; padding:.6rem .8rem; background:#FFFBEB; border-radius:6px; font-size:.8rem; color:#92400E; }
  .oqa-valueadds { margin-top:1.25rem; border-top:1px solid #E2E8F0; padding-top:1.25rem; }
  .oqa-section-heading { font-size:1rem; font-weight:700; color:#0B1929; margin-bottom:.5rem; }
  .oqa-warn-note { font-size:.82rem; color:#92400E; background:#FFFBEB; border-left:3px solid var(--amber,#E07B00); border-radius:6px; padding:.7rem .9rem; margin-bottom:1rem; line-height:1.55; }
  .oqa-sec { margin-bottom:1rem; padding:1rem; background:#F8FAFC; border:1px solid #E2E8F0; border-radius:10px; }
  .oqa-sec-title { font-size:.9rem; font-weight:700; color:#0B1929; margin:0 0 .5rem; }
  .oqa-sec-hint { font-size:.8rem; color:#6B7280; margin:0 0 .75rem; line-height:1.5; }
  .oqa-radio-col { display:flex; flex-direction:column; gap:.5rem; }
  .oqa-radio, .oqa-check { display:flex; align-items:center; gap:.5rem; font-size:.875rem; color:#0F172A; cursor:pointer; flex-wrap:wrap; }
  .oqa-check-strong { font-weight:600; margin-bottom:.5rem; }
  .oqa-inline-text { flex:1; min-width:140px; padding:.25rem .5rem; border:1px solid #CBD5E1; border-radius:4px; font-size:.85rem; font-family:inherit; }
  .oqa-inline-num { width:90px; padding:.25rem .4rem; border:1px solid #CBD5E1; border-radius:4px; font-size:.85rem; font-family:inherit; }
  .oqa-inline-select { padding:.25rem .5rem; border:1px solid #CBD5E1; border-radius:4px; font-size:.85rem; font-family:inherit; }
  .oqa-field { margin-bottom:.75rem; }
  .oqa-field-label { display:block; font-size:.82rem; font-weight:600; color:#0B1929; margin-bottom:.3rem; }
  .oqa-text, .oqa-textarea { width:100%; box-sizing:border-box; padding:.6rem .75rem; border:1px solid #CBD5E1; border-radius:8px; font-family:inherit; font-size:.875rem; }
  .oqa-textarea { min-height:64px; resize:vertical; }
  .oqa-shingle-brand { margin-bottom:1rem; }
  .oqa-brand-label { font-size:.85rem; font-weight:700; color:#0B1929; margin-bottom:.4rem; padding-bottom:.25rem; border-bottom:1px solid #E2E8F0; }
  .oqa-checkgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:.5rem; }
  .oqa-warr-row { border:1px solid #E2E8F0; border-radius:8px; padding:.75rem; margin-bottom:.75rem; background:#fff; }
  .oqa-save-row { margin-top:1.25rem; border-top:1px solid #E2E8F0; padding-top:1.25rem; }
  .oqa-save { background:var(--amber,#E07B00); color:#0B1929; border:none; border-radius:8px; padding:.7rem 1.5rem; font-size:.875rem; font-weight:700; cursor:pointer; font-family:inherit; }
  .oqa-save:disabled { opacity:.7; cursor:default; }
  .oqa-save.is-saved { background:#10B981; color:#fff; }
  .oqa-save.is-error { background:#EF4444; color:#fff; }
  .oqa-future { margin-top:1.5rem; background:rgba(255,255,255,0.03); border:1px dashed rgba(255,255,255,0.2); border-radius:12px; padding:1.25rem; }
  .oqa-future-title { font-weight:700; color:var(--white,#fff); display:flex; align-items:center; gap:.5rem; }
  .oqa-soon { font-size:.7rem; font-weight:700; background:rgba(224,123,0,0.2); color:var(--amber,#E07B00); padding:.15rem .5rem; border-radius:999px; }
  .oqa-future-desc { color:var(--slate,#94a3b8); font-size:.85rem; margin-top:.4rem; }
  @media (max-width:768px){ .oqa-checkgrid { grid-template-columns:1fr 1fr; } }
`;
