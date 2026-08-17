'use client';

/**
 * Contractor Opportunities — D-211 Phase 3 (port of contractor-opportunities.html,
 * the contractor revenue loop: browse open opportunities, view docs, deep-link
 * into the bid form). Wrapped by the reusable ContractorShell (auth +
 * contractor-role gate + nav). Reuses the shared auth scaffolding and the
 * contractor-track shell — does NOT re-implement auth or the CPA/pending gates.
 *
 * Gating parity with the static page (init(), :463-505):
 *   1. pending (status !== 'active')      → redirect /contractor/dashboard?msg=pending_approval
 *   2. stale CPA                          → enforceCpaRedirect (anti-loop, → /contractor/dashboard)
 *   3. D-178 state not in OPEN_STATES     → parked-state UI (no redirect)
 *
 * Folded §6.1 finding: the get-hover-pdf IDOR is a BACKEND gate item (Tier-3,
 * filed for migration-author/EF). This page calls get-hover-pdf with its contract
 * UNCHANGED — the supabase.functions.invoke({ claim_id, format:'url' }) shape is
 * preserved exactly; no client-side change can or should address the backend IDOR.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { ContractorShell } from '../_shell/ContractorShell';
import { useContractorRecordGate, type ContractorRecord } from '../_shell/use-contractor-record';
import { enforceCpaRedirect } from '../_shell/cpa-guard';
import { isPendingApproval } from '../_shell/contractor-gating';
import { useOpportunitiesData } from './use-opportunities-data';
import {
  OPP_COPY as T,
  JOB_TYPE_OPTIONS, TRADE_OPTIONS, MATERIAL_OPTIONS, DISTANCE_OPTIONS, SORT_OPTIONS,
  submitBidHref, renewBidHref, detailBidHref, type SelectOption,
} from './copy';
import {
  applyOppFilters, resolveStateGate, resultsCountLabel,
  valueDisplay, calcFees, expiryCountdown, tradeReleaseBadges, tradeDisplay,
  JOB_TYPE_BADGE_LABELS, JOB_TYPE_DETAIL_LABELS, URGENCY_DETAIL_LABELS,
  TRADE_ICONS, TRADE_LABELS, fmtCurrency,
  type Opportunity, type OppFilters,
} from './utils';

const DASHBOARD_ROUTE = '/contractor/dashboard';

export default function ContractorOpportunitiesPage() {
  return (
    <ContractorShell active="opportunities">
      <OpportunitiesContent />
    </ContractorShell>
  );
}

function OpportunitiesContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;
  const { contractor, loading: contractorLoading } = useContractorRecordGate(userId);
  const router = useRouter();

  const [gateResolved, setGateResolved] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  // Gating effect — order matches the static init() exactly.
  useEffect(() => {
    if (!contractor) return;
    if (isPendingApproval(contractor)) {
      setRedirecting(true);
      router.replace(`${DASHBOARD_ROUTE}?msg=pending_approval`);
      return;
    }
    if (enforceCpaRedirect(contractor, router.replace, DASHBOARD_ROUTE)) {
      setRedirecting(true);
      return;
    }
    setGateResolved(true);
  }, [contractor, router]);

  if (contractorLoading || !contractor || redirecting || !gateResolved) {
    return <div className="oqo-loading"><div className="oqo-spin" /><style>{STYLES}</style></div>;
  }

  const stateGate = resolveStateGate(contractor);
  if (stateGate.parked) {
    return <ParkedState stateName={stateGate.stateName} />;
  }

  return <OpportunitiesView contractor={contractor} />;
}

function ParkedState({ stateName }: { stateName: string }) {
  return (
    <div className="oqo-wrap">
      <style>{STYLES}</style>
      <div className="oqo-empty-early">
        <span className="oqo-otter" aria-hidden="true">🦦</span>
        <h2 className="oqo-esa-headline">{T.parked.headPrefix}<em>{stateName}</em>{T.parked.headSuffix}</h2>
        <p className="oqo-esa-sub">{T.parked.sub}</p>
        <div className="oqo-notify-pill">{T.parked.notifyPill}</div>
      </div>
    </div>
  );
}

function OpportunitiesView({ contractor }: { contractor: ContractorRecord }) {
  const { opportunities, loading } = useOpportunitiesData(contractor, true);
  const [filters, setFilters] = useState<OppFilters>({
    jobType: '', trade: '', material: '', distance: '', sort: 'newest',
  });
  const [detail, setDetail] = useState<Opportunity | null>(null);

  const filtered = useMemo(() => applyOppFilters(opportunities, filters), [opportunities, filters]);
  const setField = (k: keyof OppFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="oqo-wrap">
      <style>{STYLES}</style>

      <div className="oqo-sales-banner">
        <span aria-hidden="true">💼</span>
        <p><strong>{T.salesBanner}</strong></p>
      </div>

      <div className="oqo-header">
        <h1>{T.pageTitle}</h1>
        <p>{T.pageSubtitle}</p>
      </div>

      <div className="oqo-filters">
        <FilterSelect label={T.filterLabels.jobType} value={filters.jobType ?? ''} options={JOB_TYPE_OPTIONS} onChange={setField('jobType')} />
        <FilterSelect label={T.filterLabels.trade} value={filters.trade ?? ''} options={TRADE_OPTIONS} onChange={setField('trade')} />
        <FilterSelect label={T.filterLabels.material} value={filters.material ?? ''} options={MATERIAL_OPTIONS} onChange={setField('material')} />
        <FilterSelect label={T.filterLabels.distance} value={filters.distance ?? ''} options={DISTANCE_OPTIONS} onChange={setField('distance')} />
        <FilterSelect label={T.filterLabels.sort} value={filters.sort ?? 'newest'} options={SORT_OPTIONS} onChange={setField('sort')} />
      </div>

      {!loading && <div className="oqo-count">{resultsCountLabel(filtered.length)}</div>}

      {loading ? (
        <div className="oqo-loading"><div className="oqo-spin" /></div>
      ) : opportunities.length === 0 ? (
        <EmptyEarly />
      ) : filtered.length === 0 ? (
        <div className="oqo-empty">
          <span className="oqo-empty-icon" aria-hidden="true">📭</span>
          <h2 className="oqo-empty-title">{T.emptyFiltered.title}</h2>
          <p className="oqo-empty-text">{T.emptyFiltered.text}</p>
        </div>
      ) : (
        <div className="oqo-cards">
          {filtered.map((o) => (
            <OpportunityCard key={o.id} opp={o} onDetails={() => setDetail(o)} />
          ))}
        </div>
      )}

      {detail && <DetailModal opp={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string; options: SelectOption[]; onChange: (v: string) => void;
}) {
  return (
    <div className="oqo-filter-group">
      <label className="oqo-filter-label">{label}</label>
      <select className="oqo-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function OpportunityCard({ opp, onDetails }: { opp: Opportunity; onDetails: () => void }) {
  const [scopeOpen, setScopeOpen] = useState(false);
  const [lossBusy, setLossBusy] = useState(false);
  const [hoverBusy, setHoverBusy] = useState(false);
  const [measurementsBusy, setMeasurementsBusy] = useState(false);

  const fees = calcFees(opp);
  const vd = valueDisplay(opp);
  const expiry = expiryCountdown(opp);
  const releaseBadges = tradeReleaseBadges(opp);
  const isUrgent = opp.urgency === 'asap';
  const urgentDeadline = opp.urgencyDeadline
    ? new Date(opp.urgencyDeadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';

  const openLossSheet = async () => {
    if (!opp.estimateFilename) return;
    setLossBusy(true);
    try {
      const { data, error } = await supabase.storage
        .from('claim-documents')
        .createSignedUrl(opp.estimateFilename, 3600);
      if (error || !data?.signedUrl) throw error || new Error('No URL returned');
      window.open(data.signedUrl, '_blank');
    } catch (err) {
      console.error('Failed to open loss sheet:', err);
      alert(T.lossSheetError);
    } finally {
      setLossBusy(false);
    }
  };

  // gh-484: signed-URL viewer for homeowner-uploaded measurement files — independent
  // of the Hover PDF button / hover_orders row state (parity with the loss-sheet
  // viewer above). opp.measurementsFilename is already sentinel-guarded in utils.ts.
  const openMeasurements = async () => {
    if (!opp.measurementsFilename) return;
    setMeasurementsBusy(true);
    try {
      const { data, error } = await supabase.storage
        .from('claim-documents')
        .createSignedUrl(opp.measurementsFilename, 3600);
      if (error || !data?.signedUrl) throw error || new Error('No URL returned');
      window.open(data.signedUrl, '_blank');
    } catch (err) {
      console.error('Failed to open measurements file:', err);
      alert(T.measurementsError);
    } finally {
      setMeasurementsBusy(false);
    }
  };

  // get-hover-pdf — contract UNCHANGED (the IDOR is a backend/Tier-3 gate item).
  const openHoverPdf = async () => {
    setHoverBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('get-hover-pdf', {
        body: { claim_id: opp.id, format: 'url' },
      });
      if (error) throw error;
      const url = (data as { url?: string } | null)?.url;
      if (!url) throw new Error('No PDF URL returned');
      window.open(url, '_blank');
    } catch (err) {
      console.error('Failed to open Hover PDF:', err);
      alert(T.hoverPdfError);
    } finally {
      setHoverBusy(false);
    }
  };

  return (
    <div className={'oqo-card' + (isUrgent ? ' is-urgent' : '')}>
      <div className="oqo-card-head">
        <div>
          <h2 className="oqo-card-id">Project in {opp.location}{opp.zip ? `, IN ${opp.zip}` : ''}</h2>
          <p className="oqo-card-loc">
            {opp.location}, {opp.zip}
            {opp.distance !== null ? ` — ~${opp.distance} mi away` : ''}
          </p>
        </div>
        <div className="oqo-head-badges">
          {JOB_TYPE_BADGE_LABELS[opp.jobType] && (
            <span className={`oqo-badge oqo-badge-${opp.jobType}`}>{JOB_TYPE_BADGE_LABELS[opp.jobType]}</span>
          )}
          {opp.trades.length > 1 && (
            <span className="oqo-badge oqo-badge-multi">📦 MULTI-TRADE ({opp.trades.length})</span>
          )}
          {isUrgent && (
            <span className="oqo-badge oqo-badge-urgent">URGENT{urgentDeadline ? ` — ${urgentDeadline}` : ''}</span>
          )}
          {expiry && <span className={`oqo-expiry oqo-expiry-${expiry.tone}`}>{expiry.text}</span>}
        </div>
      </div>

      <div className="oqo-trade-badges">
        {opp.trades.map((t) => {
          const tl = String(t).toLowerCase();
          return (
            <span className="oqo-badge oqo-badge-trade" key={t}>
              {TRADE_ICONS[tl] || ''} {TRADE_LABELS[tl] || t}
            </span>
          );
        })}
      </div>

      {releaseBadges.length > 0 && (
        <div className="oqo-release-badges">
          {releaseBadges.map((b) =>
            b.released ? (
              <span className="oqo-badge oqo-badge-available" key={b.label}>{b.label}: Available ✓</span>
            ) : (
              <span className="oqo-badge oqo-badge-waiting" key={b.label}>⏳ {b.label}: Waiting on homeowner design</span>
            ),
          )}
        </div>
      )}

      <div className="oqo-info-grid">
        <InfoBlock label="Damage Type" value={`${opp.damageType} — ${opp.damageDetail}`} />
        {opp.jobType === 'retail'
          ? <InfoBlock label="Job Type" value="Retail / Cash" />
          : <InfoBlock label="Insurance Carrier" value={opp.insuranceCarrier || 'N/A'} />}
        {opp.jobType === 'repair' && opp.existingShingle
          ? <InfoBlock label="Existing Shingle (must match)" value={opp.existingShingle} />
          : opp.material
            ? <InfoBlock label="Material Selected" value={opp.material} />
            : null}
        <InfoBlock label={vd.label} value={vd.value} />
      </div>

      <div className="oqo-trade-badges">
        {opp.estimateAvailable && <span className="oqo-badge oqo-badge-available">Insurance Estimate ✓</span>}
        {opp.measurementsAvailable
          ? <span className="oqo-badge oqo-badge-available">Measurements ✓</span>
          : <span className="oqo-badge oqo-badge-pending">Measurements Pending</span>}
      </div>

      {(opp.estimateFilename || opp.measurementsAvailable) && (
        <div className="oqo-docs">
          <span className="oqo-docs-label">{T.documentsLabel}</span>
          {opp.estimateFilename && (
            <button type="button" className="oqo-doc-btn" disabled={lossBusy} onClick={openLossSheet}>
              {lossBusy ? T.loadingLabel : T.lossSheetBtn}
            </button>
          )}
          {/* gh-484: homeowner-uploaded measurement file, independent of Hover state */}
          {opp.measurementsFilename && (
            <button type="button" className="oqo-doc-btn" disabled={measurementsBusy} onClick={openMeasurements}>
              {measurementsBusy ? T.loadingLabel : T.measurementsBtn}
            </button>
          )}
          {opp.measurementsAvailable && (
            <button type="button" className="oqo-doc-btn" disabled={hoverBusy} onClick={openHoverPdf}>
              {hoverBusy ? T.loadingLabel : T.hoverPdfBtn}
            </button>
          )}
        </div>
      )}

      {opp.homeownerNotes && (
        <div className="oqo-notes"><strong>{T.homeownerNotesLabel}</strong>{opp.homeownerNotes}</div>
      )}

      {opp.contractorScopeSummary && (
        <div className="oqo-scope">
          <button type="button" className="oqo-scope-btn" onClick={() => setScopeOpen((v) => !v)}>
            {T.viewScope} <span aria-hidden="true">{scopeOpen ? '▲' : '▼'}</span>
          </button>
          {scopeOpen && (
            <div className="oqo-scope-body">
              <span className="oqo-scope-label">{opp.fundingType === 'insurance' ? 'Insurance Scope of Work' : 'Scope of Work'}</span>
              <div className="oqo-scope-text">{opp.contractorScopeSummary}</div>
            </div>
          )}
        </div>
      )}

      <div className="oqo-card-meta">
        <InfoBlock label="Submitted" value={opp.claimFiledDate ? new Date(opp.claimFiledDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'} />
        <span className="oqo-card-rawid">ID: {opp.id}</span>
      </div>

      {fees && (
        <div className="oqo-fees">
          <span className="oqo-fees-title">Estimated Platform Fee</span>
          <div className="oqo-fee-row"><span>Contract Signing (5%)</span><span>{fees.baseFee}</span></div>
          <div className="oqo-fee-row oqo-fee-total"><span>Total Platform Fee</span><span>{fees.total}</span></div>
        </div>
      )}

      {opp.hasExpiredBid && (
        <div className="oqo-expired-note"><span aria-hidden="true">⏰</span><span>{T.expiredBidNotice}</span></div>
      )}

      <div className="oqo-actions">
        <button type="button" className="oqo-btn oqo-btn-secondary" onClick={onDetails}>{T.detailsBtn}</button>
        {opp.hasExpiredBid && opp.expiredQuoteId
          ? <a className="oqo-btn oqo-btn-renew" href={renewBidHref(opp.id, opp.expiredQuoteId)}>{T.renewBidBtn}</a>
          : <a className="oqo-btn oqo-btn-primary" href={submitBidHref(opp.id)}>{T.submitBidBtn}</a>}
      </div>
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="oqo-info-block">
      <span className="oqo-info-label">{label}</span>
      <span className="oqo-info-value">{value}</span>
    </div>
  );
}

// D-074: detail modal shows city/zip, trade, job type, urgency — never street address.
function DetailModal({ opp, onClose }: { opp: Opportunity; onClose: () => void }) {
  const locationDisplay = opp.location + (opp.zip ? `, IN ${opp.zip}` : '');
  const jobLabel = JOB_TYPE_DETAIL_LABELS[opp.jobType] || opp.jobType || '—';
  const urgencyLabel = URGENCY_DETAIL_LABELS[opp.urgency] || opp.urgency || 'Flexible';
  return (
    <div className="oqo-overlay" role="dialog" aria-modal="true" aria-labelledby="oqo-detail-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="oqo-modal">
        <button type="button" className="oqo-modal-x" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="oqo-detail-title" className="oqo-modal-title">Project in {locationDisplay}</h2>
        <p className="oqo-modal-sub">{locationDisplay}</p>
        <div className="oqo-modal-grid">
          <DetailField label="Trade(s)" value={tradeDisplay(opp.trades)} />
          <DetailField label="Job Type" value={jobLabel} />
          <DetailField label="Urgency" value={urgencyLabel} />
          <DetailField label="Est. Value" value={opp.estimatedValue ? `$${Number(opp.estimatedValue).toLocaleString()}` : '—'} />
        </div>
        <div className="oqo-modal-foot">
          <button type="button" className="oqo-btn oqo-btn-secondary" onClick={onClose}>{T.detailClose}</button>
          <a className="oqo-btn oqo-btn-primary" href={detailBidHref(opp.id)}>{T.detailBidBtn}</a>
        </div>
      </div>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div><strong className="oqo-detail-label">{label}</strong><span>{value}</span></div>
  );
}

function EmptyEarly() {
  const e = T.emptyEarly;
  return (
    <div className="oqo-empty-early">
      <span className="oqo-otter" aria-hidden="true">🦦</span>
      <h2 className="oqo-esa-headline">{e.headline}<br /><em>{e.headlineEm}</em></h2>
      <p className="oqo-esa-sub">{e.sub}</p>
      <div className="oqo-notify-pill">{e.notifyPill}</div>
      <div className="oqo-esa-checklist">
        <span className="oqo-esa-checklist-heading">{e.checklistHeading}</span>
        {e.items.map((it, i) => (
          <div className="oqo-esa-item" key={it.label}>
            <div className="oqo-esa-item-num">{i + 1}</div>
            <div className="oqo-esa-item-text">
              <span className="oqo-esa-item-label">{it.label}</span>
              <span className="oqo-esa-item-desc">{it.desc}</span>
              <a className="oqo-esa-item-link" href={it.href}>{it.linkText}</a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const STYLES = `
  .oqo-loading { display:flex; align-items:center; justify-content:center; min-height:50vh; }
  .oqo-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:oqo-spin .8s linear infinite; }
  @keyframes oqo-spin { to { transform:rotate(360deg); } }
  .oqo-wrap { max-width:1100px; margin:0 auto; padding:2rem 1.5rem 3rem; color:var(--white,#fff); }
  .oqo-sales-banner { display:flex; gap:.75rem; align-items:center; background:rgba(224,123,0,0.1); border:1px solid rgba(224,123,0,0.35); border-radius:.75rem; padding:1rem 1.25rem; margin-bottom:1.5rem; }
  .oqo-sales-banner p { margin:0; font-size:.9rem; color:var(--white,#fff); }
  .oqo-header h1 { font-size:1.8rem; margin:0 0 .25rem; }
  .oqo-header p { color:var(--slate,#94a3b8); margin:0 0 1.5rem; }
  .oqo-filters { display:grid; grid-template-columns:repeat(5,1fr); gap:1rem; margin-bottom:1.5rem; }
  .oqo-filter-group { display:flex; flex-direction:column; gap:.35rem; }
  .oqo-filter-label { font-size:.8rem; color:var(--slate,#94a3b8); font-weight:600; }
  .oqo-select { padding:.5rem .75rem; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.05); color:var(--white,#fff); font-family:inherit; font-size:.85rem; }
  .oqo-count { color:var(--slate,#94a3b8); font-size:.85rem; margin-bottom:1rem; }
  .oqo-cards { display:flex; flex-direction:column; gap:1.25rem; }
  .oqo-card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:1.5rem; }
  .oqo-card.is-urgent { border-color:rgba(239,68,68,0.5); }
  .oqo-card-head { display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
  .oqo-card-id { font-size:1.15rem; margin:0 0 .15rem; }
  .oqo-card-loc { color:var(--slate,#94a3b8); font-size:.85rem; margin:0; }
  .oqo-head-badges { display:flex; gap:.4rem; flex-wrap:wrap; align-items:flex-start; }
  .oqo-badge { display:inline-block; padding:.2rem .55rem; border-radius:999px; font-size:.72rem; font-weight:700; }
  .oqo-badge-insurance_rcv, .oqo-badge-insurance_acv { background:rgba(2,132,199,0.15); color:#7DD3FC; }
  .oqo-badge-retail { background:rgba(21,128,61,0.15); color:#86EFAC; }
  .oqo-badge-repair { background:rgba(168,85,247,0.15); color:#D8B4FE; }
  .oqo-badge-multi { background:#FEF3C7; color:#92400E; }
  .oqo-badge-urgent { background:#FEE2E2; color:#991B1B; }
  .oqo-badge-trade { background:#E0F2FE; color:#0369A1; }
  .oqo-badge-available { background:rgba(21,128,61,0.18); color:#86EFAC; }
  .oqo-badge-waiting { background:#FEF3C7; color:#92400E; }
  .oqo-badge-pending { background:rgba(148,163,184,0.2); color:#CBD5E1; }
  .oqo-expiry { display:inline-block; padding:.2rem .55rem; border-radius:999px; font-size:.72rem; font-weight:700; }
  .oqo-expiry-red { background:#FEE2E2; color:#991B1B; }
  .oqo-expiry-amber { background:#FEF3C7; color:#92400E; }
  .oqo-expiry-neutral { background:rgba(148,163,184,0.2); color:#CBD5E1; }
  .oqo-trade-badges, .oqo-release-badges { display:flex; gap:.4rem; flex-wrap:wrap; margin-top:.6rem; }
  .oqo-info-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:1rem; margin:1rem 0; }
  .oqo-info-block { display:flex; flex-direction:column; gap:.2rem; }
  .oqo-info-label { font-size:.72rem; color:var(--slate,#94a3b8); text-transform:uppercase; letter-spacing:.03em; }
  .oqo-info-value { font-size:.9rem; }
  .oqo-docs { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; margin:.75rem 0; }
  .oqo-docs-label { font-size:.72rem; color:var(--slate,#94a3b8); text-transform:uppercase; }
  .oqo-doc-btn { background:rgba(255,255,255,0.06); color:var(--white,#fff); border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:.35rem .7rem; font-size:.78rem; font-weight:600; cursor:pointer; font-family:inherit; }
  .oqo-doc-btn:disabled { opacity:.6; cursor:default; }
  .oqo-notes { background:rgba(255,255,255,0.04); border-radius:8px; padding:.75rem .9rem; margin:.75rem 0; font-size:.85rem; }
  .oqo-notes strong { display:block; font-size:.72rem; color:var(--slate,#94a3b8); text-transform:uppercase; margin-bottom:.25rem; }
  .oqo-scope { margin:.5rem 0; }
  .oqo-scope-btn { background:transparent; color:var(--amber,#E07B00); border:1px solid rgba(224,123,0,0.4); border-radius:6px; padding:.35rem .7rem; font-size:.8rem; font-weight:600; cursor:pointer; font-family:inherit; }
  .oqo-scope-body { margin-top:.5rem; background:rgba(255,255,255,0.04); border-radius:8px; padding:.75rem .9rem; }
  .oqo-scope-label { display:block; font-size:.72rem; color:var(--slate,#94a3b8); text-transform:uppercase; margin-bottom:.25rem; }
  .oqo-scope-text { font-size:.85rem; white-space:pre-wrap; }
  .oqo-card-meta { display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:.5rem; margin:1rem 0 .5rem; }
  .oqo-card-rawid { font-size:.72rem; color:#CBD5E1; font-weight:500; letter-spacing:.02em; }
  .oqo-fees { background:rgba(255,255,255,0.04); border-radius:8px; padding:.85rem 1rem; margin:.5rem 0; }
  .oqo-fees-title { display:block; font-size:.72rem; color:var(--slate,#94a3b8); text-transform:uppercase; margin-bottom:.4rem; }
  .oqo-fee-row { display:flex; justify-content:space-between; font-size:.82rem; padding:.15rem 0; }
  .oqo-fee-total { font-weight:700; border-top:1px solid rgba(255,255,255,0.1); margin-top:.25rem; padding-top:.4rem; }
  .oqo-expired-note { display:flex; gap:.5rem; align-items:center; background:#FFF7ED; border:1px solid #FED7AA; border-radius:.5rem; padding:.5rem .875rem; margin:.5rem 0; font-size:.82rem; color:#92400E; }
  .oqo-actions { display:flex; gap:.75rem; justify-content:flex-end; margin-top:1rem; flex-wrap:wrap; }
  .oqo-btn { display:inline-block; border:none; border-radius:8px; padding:.55rem 1.1rem; font-size:.85rem; font-weight:700; cursor:pointer; font-family:inherit; text-decoration:none; }
  .oqo-btn-primary { background:var(--amber,#E07B00); color:var(--navy,#0B1929); }
  .oqo-btn-renew { background:#15803D; color:#fff; }
  .oqo-btn-secondary { background:transparent; color:var(--white,#fff); border:1.5px solid rgba(255,255,255,0.25); }
  .oqo-empty, .oqo-empty-early { text-align:center; padding:3rem 1.5rem; color:var(--slate,#94a3b8); }
  .oqo-empty-icon { font-size:2.5rem; display:block; margin-bottom:.75rem; }
  .oqo-empty-title { color:var(--white,#fff); font-size:1.2rem; margin:0 0 .5rem; }
  .oqo-otter { font-size:3rem; display:block; margin-bottom:.75rem; }
  .oqo-esa-headline { color:var(--white,#fff); font-size:1.5rem; margin:0 0 .75rem; }
  .oqo-esa-headline em { color:var(--amber,#E07B00); font-style:italic; }
  .oqo-esa-sub { max-width:560px; margin:0 auto 1.25rem; line-height:1.6; }
  .oqo-notify-pill { display:inline-block; background:rgba(224,123,0,0.12); border:1px solid rgba(224,123,0,0.4); border-radius:999px; padding:.5rem 1rem; font-size:.85rem; color:var(--white,#fff); margin-bottom:1.5rem; }
  .oqo-esa-checklist { max-width:560px; margin:1.5rem auto 0; text-align:left; display:flex; flex-direction:column; gap:1rem; }
  .oqo-esa-checklist-heading { font-weight:700; color:var(--white,#fff); }
  .oqo-esa-item { display:flex; gap:.85rem; }
  .oqo-esa-item-num { flex-shrink:0; width:28px; height:28px; border-radius:50%; background:var(--amber,#E07B00); color:var(--navy,#0B1929); font-weight:800; display:flex; align-items:center; justify-content:center; }
  .oqo-esa-item-text { display:flex; flex-direction:column; gap:.2rem; }
  .oqo-esa-item-label { font-weight:700; color:var(--white,#fff); }
  .oqo-esa-item-desc { font-size:.85rem; }
  .oqo-esa-item-link { color:var(--amber,#E07B00); font-size:.85rem; text-decoration:none; font-weight:600; }
  .oqo-overlay { position:fixed; inset:0; background:rgba(11,25,41,0.75); z-index:1000; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:5vh 1rem; }
  .oqo-modal { position:relative; background:#fff; color:#0F172A; border-radius:12px; max-width:520px; width:100%; padding:2rem; }
  .oqo-modal-x { position:absolute; top:1rem; right:1rem; background:none; border:none; font-size:1.5rem; cursor:pointer; color:#94A3B8; line-height:1; }
  .oqo-modal-title { font-size:1.5rem; font-weight:700; color:#0D1B2E; margin:0 0 .25rem; }
  .oqo-modal-sub { font-size:.95rem; color:#94A3B8; margin:0 0 1.5rem; }
  .oqo-modal-grid { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
  .oqo-detail-label { display:block; font-size:.75rem; color:#64748B; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.25rem; }
  .oqo-modal-foot { margin-top:1.5rem; display:flex; gap:1rem; justify-content:flex-end; }
  .oqo-modal .oqo-btn-secondary { color:#0F172A; border-color:#CBD5E1; }
  @media (max-width:768px){ .oqo-filters{ grid-template-columns:repeat(2,1fr);} .oqo-modal-grid{ grid-template-columns:1fr; } }
`;
