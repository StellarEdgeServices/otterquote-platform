'use client';

/**
 * Contractor Bid Form — the form view (D-211 Phase 7 / BF-2, port of the
 * contractor-bid-form.html bid form: bid-type/retail price, the D-163 value-adds,
 * gutter/siding trade sections, the second-layer tear-off contingency, the D-202
 * warranty card, Home Photos, the D-214/D-215 fee disclosure + acceptance gate,
 * and the D-162 multi-trade wizard). On submit it consumes the PR-1 pure builders
 * (buildValueAdds, serializeWarrantySelection, computeQuoteFeeBase, buildQuote*,
 * buildFeeAcceptanceInsert + buildFeeDisclosureText, buildBidConfirmationBody,
 * buildNotifyContractorsBody, buildBidUpdatedNotification) and calls the existing
 * EFs/RPC (bid_can_submit, send-bid-confirmation, notify-contractors) with their
 * UNCHANGED contracts. Fee + legal copy come VERBATIM from copy.ts. No innerHTML.
 */

import { useEffect, useMemo, useReducer, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import type { ContractorRecord } from '../../_shell/use-contractor-record';
import { Card, Field, TextInput, MoneyInput, TextArea, Select, Checkbox, RadioRow, formatCurrency, type Opt } from './bid-ui';
import { BID_COPY, buildFeeDisclosureText } from './copy';
import { HomePhotosCard } from './home-photos-card';
import { WarrantyCard } from './warranty-card';
import {
  type BidClaim, type BidMode, type TradeFlags, type WarrantySelectionInput,
  type ValueAddsFormState, type ValueAddsContext, type WizardState,
  buildValueAdds, serializeWarrantySelection, applyCustomWarrantyReview,
  feeConfigLookupParams, resolveFeePct, computeDisclosureFee, computeQuoteFeeBase, computeCalculatorFee,
  bidGateRpcParams, interpretBidGate, BID_GATE_ROUTES, DEFAULT_PLATFORM_FEE_PCT,
  buildScopeSummary, buildQuoteInsert, buildQuoteUpdate,
  buildFeeAcceptanceInsert, buildBidConfirmationBody, buildNotifyContractorsBody, buildBidUpdatedNotification,
  computeWizardEligibility, wizardReducer,
} from './utils';

// ── Option lists (values byte-faithful to contractor-bid-form.html) ──
const BID_TYPE_OPTIONS: Opt[] = [
  { value: 'rcv_plus_supplements', label: 'RCV + supplements (match the insurance estimate)' },
  { value: 'other', label: 'Other (describe your pricing approach)' },
];
const GUTTER_OPTIONS: Opt[] = [
  { value: 'none', label: 'Not included / N/A' },
  { value: '5inch_included', label: '5" gutters included (no out-of-pocket)' },
  { value: '6inch_included', label: '6" gutters included (no out-of-pocket)' },
  { value: '5inch_additional', label: '5" gutters for an additional cost' },
  { value: '6inch_additional', label: '6" gutters for an additional cost' },
  { value: 'other', label: 'Other' },
];
const CHIMNEY_TYPE_OPTIONS: Opt[] = [
  { value: 'na', label: 'N/A — no chimney' },
  { value: 'new_flashing', label: 'New flashing (no existing flashing)' },
  { value: 'reflash', label: 'Reflash only (reseal / step-flash existing)' },
  { value: 'both', label: 'Both — new flashing & reflash' },
];
const CHIMNEY_OPTION_OPTIONS: Opt[] = [
  { value: 'included', label: 'Included in bid (no extra charge)' },
  { value: 'reuse', label: 'Reuse / inspect existing flashing' },
  { value: 'oop', label: 'Out of pocket' },
];
const SKYLIGHT_OPTIONS: Opt[] = [
  { value: 'na', label: 'N/A — no skylights' },
  { value: 'reflash', label: 'Reflash skylights (included)' },
  { value: 'replace', label: 'Replace skylights' },
];
const UNDERLAYMENT_OPTIONS: Opt[] = [
  { value: '', label: '— Select —' },
  { value: 'synthetic', label: 'Synthetic' },
  { value: 'felt', label: 'Felt' },
];
const ICEWATER_OPTIONS: Opt[] = [
  { value: 'not_applicable', label: 'Not Applicable' },
  { value: 'standard', label: 'Standard — code-minimum coverage' },
  { value: 'enhanced', label: 'Enhanced — full-coverage application' },
];
const STARTER_OPTIONS: Opt[] = [
  { value: '', label: '— Select —' },
  { value: 'rakes', label: 'Rakes' },
  { value: 'eaves', label: 'Eaves' },
  { value: 'rakes_and_eaves', label: 'Rakes and Eaves' },
  { value: 'neither', label: 'Neither' },
];
const DRIPEDGE_OPTIONS: Opt[] = [
  { value: 'na', label: 'N/A' },
  { value: 'included_black', label: 'Included — Standard (Black)' },
  { value: 'included_white', label: 'Included — Standard (White)' },
  { value: 'included_custom', label: 'Included — Custom color' },
  { value: 'oop', label: 'Available out of pocket' },
];
const SIDING_SUPPLY_OPTIONS: Opt[] = [
  { value: 'yes_exact', label: 'Yes — exact product & color selected' },
  { value: 'equivalent', label: 'Equivalent product (describe below)' },
  { value: 'labor_only', label: 'Labor only — homeowner sources materials' },
];
const NUMSTORIES_OPTIONS: Opt[] = [
  { value: '', label: 'Select number of stories' },
  { value: '1', label: '1 story' },
  { value: '2', label: '2 stories' },
  { value: '3+', label: '3+ stories' },
];
const SLC_METHOD_OPTIONS: Opt[] = [
  { value: 'per_square', label: 'Per square' },
  { value: 'flat_fee', label: 'Flat fee' },
];
const SHINGLE_OPTIONS: { mfr: string; items: string[] }[] = [
  { mfr: 'GAF', items: ['Timberline HDZ', 'Timberline UHDZ', 'Timberline CS', 'Camelot II', 'Grand Sequoia', 'Grand Canyon', 'Sovereign'] },
  { mfr: 'Owens Corning', items: ['Duration', 'Duration FLEX', 'Duration Storm', 'TruDefinition Duration', 'Oakridge', 'Berkshire Collection'] },
  { mfr: 'CertainTeed', items: ['Landmark', 'Landmark Pro', 'Landmark Premium', 'Landmark TL', 'Grand Manor', 'Carriage House', 'Presidential Shake TL'] },
  { mfr: 'Atlas', items: ['StormMaster Slate', 'StormMaster Shake', 'ProLam AR', 'Pinnacle Pristine'] },
  { mfr: 'Malarkey', items: ['Legacy', 'Vista', 'Windsor', 'Highlander NEX'] },
  { mfr: 'IKO', items: ['Dynasty', 'Cambridge', 'Nordic', 'Crowne Slate'] },
  { mfr: 'TAMKO', items: ['Heritage', 'Heritage Vintage', 'Heritage Woodgate', 'Elite Glass-Seal'] },
];

// ── Form state ──
type S = string;
interface BidFormState extends ValueAddsFormState {
  bidPrice: S;            // total_price source (retailBidPrice / RCV / wizard sync)
  brandProduct: S;
  startDate: S;
  completionTime: S;
  homeownerMessage: S;
  deckingPricePerSheet: S;
  fullRedeckPrice: S;
  supplementAcknowledged: boolean;
  autoRenew: boolean;
  tradeType: S;
}

function strOf(v: unknown): string { return v == null ? '' : String(v); }

function initialState(claim: BidClaim, flags: TradeFlags, claimRcv: number | null, existingQuote: Record<string, unknown> | null): BidFormState {
  const trades = Array.isArray(claim.trades) ? (claim.trades as string[]) : [];
  const base: BidFormState = {
    bidTypeOption: 'rcv_plus_supplements',
    bidPrice: !flags.isRetailJob && claimRcv != null ? String(claimRcv) : '',
    brandProduct: '', startDate: '', completionTime: '', homeownerMessage: '',
    deckingPricePerSheet: '', fullRedeckPrice: '', supplementAcknowledged: false,
    autoRenew: true, tradeType: trades[0] || 'roofing',
    gutterOption: 'none', chimneyType: 'na', chimneyOption: 'included', skylights: 'na',
    iceWaterShield: 'not_applicable', dripEdgeOption: 'na', otherShingles: [],
    gutterGuardsRetail: [],
  };
  if (!existingQuote) return base;
  // Change-bid / renew prefill from the existing quote (activateChangeBidMode parity, top fields + value_adds scalars).
  const va = (existingQuote.value_adds as Record<string, unknown>) || {};
  const gutters = (va.gutters as Record<string, unknown>) || {};
  const chimney = (va.chimney as Record<string, unknown>) || {};
  const underlayment = (va.underlayment as Record<string, unknown>) || {};
  const iws = (va.ice_water_shield as Record<string, unknown>) || {};
  const vent = (va.ventilation as Record<string, unknown>) || {};
  const dripEdge = (va.drip_edge as Record<string, unknown>) || {};
  const gg = (va.gutter_guards as Record<string, unknown>) || {};
  let scope: Record<string, unknown> = {};
  try { scope = existingQuote.scope_summary ? JSON.parse(String(existingQuote.scope_summary)) : {}; } catch { scope = {}; }
  return {
    ...base,
    bidTypeOption: strOf(va.bid_type_option) || 'rcv_plus_supplements',
    otherBidDescription: strOf(va.other_bid_description),
    bidPrice: existingQuote.total_price != null ? String(existingQuote.total_price) : base.bidPrice,
    brandProduct: strOf(scope.brand),
    startDate: strOf(scope.estimated_start_date),
    completionTime: strOf(scope.estimated_completion_time),
    homeownerMessage: strOf(existingQuote.notes),
    deckingPricePerSheet: existingQuote.decking_price_per_sheet != null ? String(existingQuote.decking_price_per_sheet) : '',
    fullRedeckPrice: existingQuote.full_redeck_price != null ? String(existingQuote.full_redeck_price) : '',
    supplementAcknowledged: !!existingQuote.supplement_acknowledged,
    autoRenew: existingQuote.auto_renew == null ? true : !!existingQuote.auto_renew,
    tradeType: strOf(existingQuote.trade_type) || base.tradeType,
    gutterOption: strOf(gutters.option) || 'none',
    gutterOtherText: strOf(gutters.other_text),
    gutterGuardPricingOnRequest: !!gg.pricing_on_request,
    gutterGuardMeshOop: gg.mesh_oop != null ? String(gg.mesh_oop) : '',
    gutterGuardScrewInOop: gg.screw_in_oop != null ? String(gg.screw_in_oop) : '',
    gutterGuardNotes: strOf(gg.notes),
    chimneyType: strOf(chimney.type) || 'na',
    chimneyOption: strOf(chimney.option) || 'included',
    chimneyOopPrice: chimney.oop_price != null ? String(chimney.oop_price) : '',
    skylights: strOf(va.skylights) || 'na',
    otherShingles: Array.isArray(va.other_shingles) ? (va.other_shingles as string[]) : [],
    shingleOtherNotes: strOf(va.other_shingles_notes),
    underlaymentType: strOf(underlayment.type),
    underlaymentNotes: strOf(underlayment.notes),
    iceWaterShield: strOf(iws.coverage) || 'not_applicable',
    ridgeVentIncluded: !!vent.ridge_vent_included,
    ridgeVentOopPrice: vent.ridge_vent_oop != null ? String(vent.ridge_vent_oop) : '',
    ventilationNotes: strOf(vent.notes),
    starterStrip: strOf(va.starter_strip),
    dripEdgeOption: strOf(dripEdge.option) || 'na',
    dripEdgeOopPrice: dripEdge.oop_price != null ? String(dripEdge.oop_price) : '',
    valueAddsOtherOffers: strOf(va.other_offers),
    numStories: strOf(va.num_stories),
  };
}

async function getContractorIP(): Promise<string> {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    if (!r.ok) return 'unknown';
    const d = await r.json();
    return d.ip || 'unknown';
  } catch { return 'unknown'; }
}

function track(event: string, params: Record<string, unknown>): void {
  try {
    const g = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
    if (typeof g === 'function') g('event', event, params);
  } catch { /* non-fatal */ }
}

type SubmitState = 'idle' | 'submitting' | 'done' | 'error';

export function BidForm({ mode, claim, contractor, existingQuote, flags, claimRcv, userId }: {
  mode: BidMode;
  claim: BidClaim & Record<string, unknown>;
  contractor: ContractorRecord;
  existingQuote: (Record<string, unknown> & { id: string }) | null;
  flags: TradeFlags;
  claimRcv: number | null;
  userId: string;
}) {
  const router = useRouter();
  const claimTrades = useMemo(() => (Array.isArray(claim.trades) ? (claim.trades as string[]) : []), [claim.trades]);
  const hasRoofing = claimTrades.includes('roofing');
  const showRoofing = !flags.gutterTradeActive && !(flags.sidingTradeActive && !hasRoofing);

  const [form, setForm] = useState<BidFormState>(() => initialState(claim, flags, claimRcv, existingQuote));
  const update = (p: Partial<BidFormState>) => setForm((f) => ({ ...f, ...p }));

  const [feePct, setFeePct] = useState<number>(DEFAULT_PLATFORM_FEE_PCT);
  const [feeAccepted, setFeeAccepted] = useState(false);
  const [warrantySel, setWarrantySel] = useState<WarrantySelectionInput>({ isCustom: false, workmanshipYearsRaw: '' });
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ── D-162 wizard (retail multi-trade only) ──
  const wizardElig = useMemo(
    () => computeWizardEligibility(claimTrades, { isRetailJob: flags.isRetailJob, sidingReleased: claim.siding_bid_released_at != null }),
    [claimTrades, flags.isRetailJob, claim.siding_bid_released_at],
  );
  const wizardMode = wizardElig.eligible;
  const [wizard, dispatchWizard] = useReducer(wizardReducer, {
    step: (mode === 'change' || mode === 'renew') ? 2 : 1,
    tradeIdx: 0,
    queue: wizardElig.queue,
    selectedTrades: wizardElig.queue,
  } as WizardState);
  const [wizardPrices, setWizardPrices] = useState<Record<string, string>>({});

  // Resolve the config fee pct once (platform_fee_config, contracts unchanged).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { state, trade } = feeConfigLookupParams({ state: (contractor.state as string | null) ?? null }, claim);
        const { data } = await supabase
          .from('platform_fee_config')
          .select('fee_pct')
          .or(`state.is.null,state.eq.${state}`)
          .or(`trade.is.null,trade.eq.${trade}`)
          .order('state', { ascending: false, nullsFirst: false })
          .order('trade', { ascending: false, nullsFirst: false })
          .limit(1);
        if (active) setFeePct(resolveFeePct(data));
      } catch { /* keep default */ }
    })();
    return () => { active = false; };
  }, [contractor, claim]);

  const bidAmount = parseFloat(form.bidPrice) || 0;
  const disclosure = computeDisclosureFee(bidAmount, feePct);
  const calc = computeCalculatorFee(claim, claimRcv, bidAmount);

  function buildCtx(): ValueAddsContext {
    return {
      gutterTradeActive: flags.gutterTradeActive,
      sidingTradeActive: flags.sidingTradeActive,
      claimTrades,
      wizardMode,
      wizardTradeQueue: wizard.queue,
    };
  }

  async function handleSubmit() {
    setErrorMsg(null);
    if (bidAmount <= 0) { setErrorMsg('Please enter your bid price.'); return; }
    setSubmitState('submitting');
    const nowIso = new Date().toISOString();

    try {
      // D-199 bid-time validation gate (bid_can_submit RPC, contract unchanged).
      const gateParams = bidGateRpcParams(form.tradeType, claim, contractor.id);
      const { data: gateData, error: gateErr } = await supabase.rpc('bid_can_submit', gateParams);
      const gate = interpretBidGate(gateData as never, gateErr, BID_COPY.gate);
      if (!gate.can_submit) {
        const msg = (gate.reason || BID_COPY.gate.notValidatedDefault) + BID_COPY.gate.uploadAndValidateSuffix + BID_COPY.gate.clickOkSuffix;
        setSubmitState('idle');
        if (typeof window !== 'undefined' && window.confirm(msg)) router.push(BID_GATE_ROUTES.profileTemplates);
        return;
      }

      const warranty = serializeWarrantySelection(warrantySel);
      const valueAddsRaw = buildValueAdds(form, buildCtx());
      const valueAdds = applyCustomWarrantyReview(valueAddsRaw, warranty, nowIso);
      const feeBase = computeQuoteFeeBase(claim, bidAmount);
      const feeAmount = disclosure.feeAmount;
      const exactFeeText = buildFeeDisclosureText(feePct, feeAmount, bidAmount);
      const scopeSummary = buildScopeSummary({ brand: form.brandProduct, estimatedStartDate: form.startDate, estimatedCompletionTime: form.completionTime });
      const perTradeBreakdown = wizardMode
        ? Object.fromEntries(Object.entries(wizardPrices).map(([k, v]) => [k, parseFloat(v) || 0]).filter(([, v]) => (v as number) > 0))
        : null;
      const common = {
        claimId: String(claim.id), contractorId: contractor.id, totalPrice: bidAmount,
        feeBase, feePct, acceptedAtIso: nowIso, scopeSummary, notes: form.homeownerMessage || null,
        deckingPricePerSheet: parseFloat(form.deckingPricePerSheet) || null,
        fullRedeckPrice: parseFloat(form.fullRedeckPrice) || null,
        supplementAcknowledged: form.supplementAcknowledged, tradeType: form.tradeType,
        valueAdds, perTradeBreakdown: perTradeBreakdown && Object.keys(perTradeBreakdown).length ? perTradeBreakdown : null,
        autoRenew: form.autoRenew, warranty,
      };

      if (mode === 'change' || mode === 'renew') {
        const updatePayload = buildQuoteUpdate({
          ...common, renewMode: mode === 'renew',
          existingRenewalsCount: (existingQuote?.renewals_count as number) ?? 0, now: new Date(),
        });
        const { error: upErr } = await supabase.from('quotes').update(updatePayload).eq('id', existingQuote!.id);
        if (upErr) throw upErr;
        // Homeowner "bid updated" notification + activity log + GA + contractor email (all non-fatal).
        try {
          await supabase.from('notifications').insert(buildBidUpdatedNotification({
            claimUserId: (claim.user_id as string) || null, claimId: String(claim.id),
            previewText: BID_COPY.bidUpdatedPreview(contractor.company_name), createdAtIso: nowIso,
          }));
        } catch (e) { console.warn('Notification insert failed (non-fatal):', e); }
        try {
          await supabase.from('activity_log').insert({
            user_id: userId, event_type: 'bid_updated',
            title: `Bid updated for project ${String(claim.id).slice(0, 8) || '…'}`, created_at: nowIso,
          });
        } catch (e) { console.warn('Activity log failed (non-fatal):', e); }
        track('bid_updated', { claim_id: claim.id, bid_amount: bidAmount });
        try {
          await supabase.functions.invoke('notify-contractors', { body: buildNotifyContractorsBody(mode === 'renew', String(claim.id), contractor.id) });
        } catch (e) { console.warn('Bid update/renewal email failed (non-fatal):', e); }
      } else {
        const insertPayload = buildQuoteInsert(common);
        const { data: inserted, error: insErr } = await supabase.from('quotes').insert(insertPayload).select('id').single();
        if (insErr) throw insErr;
        const bidId = (inserted as { id: string }).id;
        // D-215 Layer 1 fee_acceptances + Layer 2 send-bid-confirmation (non-fatal; quote committed).
        try {
          const ip = await getContractorIP();
          await supabase.from('fee_acceptances').insert(buildFeeAcceptanceInsert({
            contractorId: contractor.id, claimId: String(claim.id), bidId, feePct, feeAmount,
            feeTextDisplayed: exactFeeText, acceptedAtIso: nowIso, ipAddress: ip,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          }));
        } catch (e) { console.error('[D-215] fee acceptance failed (non-fatal):', e); }
        try {
          const tradeLabel = wizardMode && wizard.queue.length > 0 ? wizard.queue.join(', ') : (claimTrades.length ? claimTrades.join(', ') : 'roofing');
          await supabase.functions.invoke('send-bid-confirmation', {
            body: buildBidConfirmationBody({ quoteId: bidId, contractorId: contractor.id, bidAmount, feePct, feeAmount, trade: tradeLabel }),
          });
        } catch (e) { console.error('[D-215 Layer 2] send-bid-confirmation failed (non-fatal):', e); }
        track('bid_submit', { trade_types: claimTrades, job_type: flags.isRetailJob ? 'retail' : 'insurance', bid_amount: bidAmount });
      }

      // Clear wizard localStorage state on success (parity with clearWizardState).
      try { localStorage.removeItem(`oq_wizard_${claim.id}`); } catch { /* ignore */ }
      setSubmitState('done');
    } catch (err) {
      console.error('Error submitting bid:', err);
      setErrorMsg('Error submitting bid: ' + (err instanceof Error ? err.message : 'Unknown error'));
      setSubmitState('error');
    }
  }

  if (submitState === 'done') {
    const msg = mode === 'renew'
      ? 'Bid renewed! Your bid is active again for a fresh 14-day window.'
      : mode === 'change'
        ? 'Bid updated! The homeowner has been notified and will see your revised figures.'
        : 'Bid submitted! Your bid is live. If the homeowner selects you, the contract will be sent to both of you for signature.';
    return (
      <div className="oqb-success">
        <div className="oqb-success-icon">✓</div>
        <h2 className="oqb-h1">{mode === 'renew' ? 'Bid renewed 🔄' : mode === 'change' ? 'Bid updated' : 'Bid submitted'}</h2>
        <p className="oqb-sub">{msg}</p>
        <a className="oqb-btn oqb-btn-secondary" href={BID_GATE_ROUTES.dashboard}>← Back to Dashboard</a>
      </div>
    );
  }

  const submitLabel = submitState === 'submitting'
    ? 'Submitting…'
    : mode === 'renew' ? BID_COPY.submitBtnRenew : mode === 'change' ? BID_COPY.submitBtnChange : BID_COPY.submitBtnSubmit;
  const submitDisabled = submitState === 'submitting' || !feeAccepted;

  // The currently-shown wizard trade (step 2), if any.
  const wizardTrade = wizardMode && wizard.step === 2 ? wizard.queue[wizard.tradeIdx] : null;

  return (
    <div className="oqb-wrap">
      <h1 className="oqb-h1">{mode === 'renew' ? BID_COPY.pageTitleRenew : mode === 'change' ? BID_COPY.pageTitleChange : BID_COPY.pageTitleSubmit}</h1>
      <p className="oqb-sub">{claim.property_address ? String(claim.property_address) : 'Submit your competitive bid for this project.'}</p>

      {mode === 'change' && <div className="oqb-banner oqb-banner-change">You are editing your existing bid for this project.</div>}
      {mode === 'renew' && <div className="oqb-banner oqb-banner-renew">Your previous bid expired — renewing resets the 14-day window.</div>}

      <ProjectSummary claim={claim} flags={flags} claimRcv={claimRcv} />

      {!!claim.id && <HomePhotosCard claimId={String(claim.id)} isSiding={claimTrades.includes('siding')} />}

      {wizardMode && <WizardBar step={wizard.step} />}
      {wizardTrade && <div className="oqb-trade-badge">{wizardTrade.toUpperCase()}</div>}

      {/* Wizard step 1 — trade selection */}
      {wizardMode && wizard.step === 1 && (
        <Card title="Which trades are you bidding?" sub="Select the trades you will include in this bundled bid.">
          {wizardElig.queue.map((t) => (
            <Checkbox key={t} checked={wizard.selectedTrades.includes(t)}
              onChange={(on) => dispatchWizard({ type: 'setSelected', selectedTrades: on ? [...wizard.selectedTrades, t] : wizard.selectedTrades.filter((x) => x !== t) })}
              label={t.charAt(0).toUpperCase() + t.slice(1)} />
          ))}
          <div className="oqb-actions">
            <button type="button" className="oqb-btn" onClick={() => dispatchWizard({ type: 'next' })}>Next →</button>
          </div>
        </Card>
      )}

      {/* Single-page form OR wizard step 2 trade fields */}
      {(!wizardMode || wizard.step === 2) && (
        <>
          <PriceSection form={form} update={update} flags={flags} wizardMode={wizardMode} wizardTrade={wizardTrade}
            wizardPrices={wizardPrices} setWizardPrices={setWizardPrices} />

          {showRoofing && (!wizardMode || wizardTrade === 'roofing') && (
            <RoofingValueAdds form={form} update={update} />
          )}
          {showRoofing && flags.isRetailJob && (!wizardMode || wizardTrade === 'roofing') && (
            <SecondLayerCard form={form} update={update} />
          )}
          {flags.gutterTradeActive && (!wizardMode || wizardTrade === 'gutters') && (
            <GutterTradeCard form={form} update={update} />
          )}
          {flags.sidingTradeActive && (!wizardMode || wizardTrade === 'siding') && (
            <SidingTradeCard form={form} update={update} hasRoofing={hasRoofing} />
          )}
          {showRoofing && (!wizardMode || wizardTrade === 'roofing') && (
            <WarrantyCard contractorId={contractor.id} onChange={setWarrantySel} />
          )}

          <OtherTradesCard form={form} update={update} />
          <HomeownerMessageCard form={form} update={update} />
        </>
      )}

      {/* Wizard nav (step 2) */}
      {wizardMode && wizard.step === 2 && (
        <div className="oqb-actions">
          <button type="button" className="oqb-btn oqb-btn-secondary" onClick={() => dispatchWizard({ type: 'back' })}>
            {wizard.tradeIdx === 0 ? '← Back to Trade Selection' : '← Back'}
          </button>
          <button type="button" className="oqb-btn" onClick={() => dispatchWizard({ type: 'next' })}>
            {wizard.tradeIdx === wizard.queue.length - 1 ? 'Review & Submit →' : 'Next Trade →'}
          </button>
        </div>
      )}

      {/* Wizard step 3 — review + submit, OR single-page fee + submit */}
      {(!wizardMode || wizard.step === 3) && (
        <>
          {wizardMode && wizard.step === 3 && (
            <Card title="Review your bundled bid">
              <div className="oqb-summary">
                {wizard.queue.map((t) => (
                  <div key={t} style={{ display: 'contents' }}>
                    <span className="oqb-summary-k">{t.charAt(0).toUpperCase() + t.slice(1)}</span>
                    <span className="oqb-summary-v">{wizardPrices[t] ? formatCurrency(parseFloat(wizardPrices[t]) || 0) : '—'}</span>
                  </div>
                ))}
              </div>
              <Field label="Bundle note (optional)"><TextArea value={strOf(form.wizardBundleNote)} onChange={(v) => update({ wizardBundleNote: v })} /></Field>
              <Field label="Why bundle these trades? (optional)"><TextArea value={strOf(form.wizardRationale)} onChange={(v) => update({ wizardRationale: v })} /></Field>
              <div className="oqb-actions">
                <button type="button" className="oqb-btn oqb-btn-secondary" onClick={() => dispatchWizard({ type: 'back' })}>← Back</button>
              </div>
            </Card>
          )}

          <FeeSection mode={mode} claim={claim} bidAmount={bidAmount} feePct={feePct} disclosure={disclosure} calc={calc}
            claimRcv={claimRcv} isInsuranceRcv={claim.job_type === 'insurance_rcv'}
            autoRenew={form.autoRenew} setAutoRenew={(v) => update({ autoRenew: v })}
            feeAccepted={feeAccepted} setFeeAccepted={setFeeAccepted} />

          {errorMsg && <div className="oqb-err">{errorMsg}</div>}
          <div className="oqb-actions">
            <button type="button" className="oqb-btn" onClick={handleSubmit} disabled={submitDisabled}>{submitLabel}</button>
            {!feeAccepted && <span className="oqb-hint">Accept the platform fee above to enable submission.</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ── Presentational sub-cards ──

function ProjectSummary({ claim, flags, claimRcv }: { claim: Record<string, unknown>; flags: TradeFlags; claimRcv: number | null }) {
  const carrier = (claim.carrier_profiles as { carrier_name?: string } | null)?.carrier_name;
  return (
    <Card title="Project Summary">
      <div className="oqb-summary">
        <span className="oqb-summary-k">Address</span><span className="oqb-summary-v">{strOf(claim.property_address) || '—'}</span>
        <span className="oqb-summary-k">{flags.isRetailJob ? 'Funding' : 'Carrier'}</span>
        <span className="oqb-summary-v">{flags.isRetailJob ? 'Out of Pocket' : (carrier || '—')}</span>
        <span className="oqb-summary-k">Damage</span><span className="oqb-summary-v">{strOf(claim.damage_type) || '—'}</span>
        {claimRcv != null && !flags.isRetailJob && (<><span className="oqb-summary-k">RCV</span><span className="oqb-summary-v">{formatCurrency(claimRcv)}</span></>)}
      </div>
      <DocLinks claim={claim} />
    </Card>
  );
}

function DocLinks({ claim }: { claim: Record<string, unknown> }) {
  async function openLossSheet() {
    if (!claim.estimate_filename) return;
    const { data, error } = await supabase.storage.from('claim-documents').createSignedUrl(String(claim.estimate_filename), 3600);
    if (error || !data?.signedUrl) { alert('Unable to open the loss sheet. Please try again.'); return; }
    window.open(data.signedUrl, '_blank');
  }
  async function openHoverPdf() {
    if (!claim.id) return;
    const { data, error } = await supabase.functions.invoke('get-hover-pdf', { body: { claim_id: claim.id, format: 'url' } });
    if (error || !data?.url) { alert('Hover measurement PDF is not available for this project yet.'); return; }
    window.open(data.url, '_blank');
  }
  return (
    <div className="oqb-doclinks">
      {!!claim.estimate_filename && <button type="button" className="oqb-doclink" onClick={openLossSheet}>📄 View Loss Sheet</button>}
      {!!claim.id && <button type="button" className="oqb-doclink" onClick={openHoverPdf}>📏 View Hover PDF</button>}
    </div>
  );
}

function PriceSection({ form, update, flags, wizardMode, wizardTrade, wizardPrices, setWizardPrices }: {
  form: BidFormState; update: (p: Partial<BidFormState>) => void; flags: TradeFlags;
  wizardMode: boolean; wizardTrade: string | null;
  wizardPrices: Record<string, string>; setWizardPrices: (v: Record<string, string>) => void;
}) {
  const setPrice = (v: string) => {
    update({ bidPrice: v });
    if (wizardMode && wizardTrade) setWizardPrices({ ...wizardPrices, [wizardTrade]: v });
  };
  return (
    <Card title="Your Bid Price">
      {!flags.isRetailJob && (
        <Field label="Bid type">
          <RadioRow name="bidTypeOption" value={form.bidTypeOption} onChange={(v) => update({ bidTypeOption: v })} options={BID_TYPE_OPTIONS} />
        </Field>
      )}
      {!flags.isRetailJob && form.bidTypeOption === 'other' && (
        <Field label="Describe your pricing approach">
          <TextArea value={strOf(form.otherBidDescription)} onChange={(v) => update({ otherBidDescription: v })} placeholder="Describe how you priced this bid…" />
        </Field>
      )}
      <Field label={wizardTrade ? `Price for ${wizardTrade}` : 'Total bid price'} hint="This is the amount the platform fee is calculated against.">
        <MoneyInput value={wizardMode && wizardTrade ? (wizardPrices[wizardTrade] ?? '') : form.bidPrice} onChange={setPrice} placeholder="0.00" />
      </Field>
    </Card>
  );
}

function RoofingValueAdds({ form, update }: { form: BidFormState; update: (p: Partial<BidFormState>) => void }) {
  const toggleShingle = (val: string, on: boolean) => {
    const cur = form.otherShingles ?? [];
    update({ otherShingles: on ? [...cur, val] : cur.filter((x) => x !== val) });
  };
  return (
    <Card title="Roofing Details & Value-Adds" sub="Feature/benefit parity for insurance and retail roofing (D-163).">
      <div className="oqb-grid2">
        <Field label="Preferred shingle brand / product"><TextInput value={form.brandProduct} onChange={(v) => update({ brandProduct: v })} placeholder="e.g. GAF Timberline HDZ" /></Field>
        <Field label="Number of stories"><Select value={strOf(form.numStories)} onChange={(v) => update({ numStories: v })} options={NUMSTORIES_OPTIONS} /></Field>
        <Field label="Estimated start date"><TextInput type="date" value={form.startDate} onChange={(v) => update({ startDate: v })} /></Field>
        <Field label="Estimated completion time"><TextInput value={form.completionTime} onChange={(v) => update({ completionTime: v })} placeholder="e.g. 2-3 days" /></Field>
        <Field label="Decking price per sheet"><MoneyInput value={form.deckingPricePerSheet} onChange={(v) => update({ deckingPricePerSheet: v })} /></Field>
        <Field label="Full re-deck price"><MoneyInput value={form.fullRedeckPrice} onChange={(v) => update({ fullRedeckPrice: v })} /></Field>
      </div>
      <Checkbox checked={form.supplementAcknowledged} onChange={(v) => update({ supplementAcknowledged: v })} label="I acknowledge supplements will be billed to insurance per the estimate." />

      <div className="oqb-grid2">
        <Field label="Gutters"><Select value={strOf(form.gutterOption)} onChange={(v) => update({ gutterOption: v })} options={GUTTER_OPTIONS} /></Field>
        {form.gutterOption === '5inch_additional' && <Field label='5" additional cost'><MoneyInput value={strOf(form.gutter5AdditionalCost)} onChange={(v) => update({ gutter5AdditionalCost: v })} /></Field>}
        {form.gutterOption === '6inch_additional' && <Field label='6" additional cost'><MoneyInput value={strOf(form.gutter6AdditionalCost)} onChange={(v) => update({ gutter6AdditionalCost: v })} /></Field>}
        {form.gutterOption === 'other' && <Field label="Gutter offer"><TextInput value={strOf(form.gutterOtherText)} onChange={(v) => update({ gutterOtherText: v })} /></Field>}
      </div>

      <Field label="Gutter Guards"><Checkbox checked={!!form.gutterGuardPricingOnRequest} onChange={(v) => update({ gutterGuardPricingOnRequest: v })} label="Pricing available upon request" /></Field>
      <div className="oqb-grid2">
        <Field label="Mesh out-of-pocket"><MoneyInput value={strOf(form.gutterGuardMeshOop)} onChange={(v) => update({ gutterGuardMeshOop: v })} /></Field>
        <Field label="Screw-in out-of-pocket"><MoneyInput value={strOf(form.gutterGuardScrewInOop)} onChange={(v) => update({ gutterGuardScrewInOop: v })} /></Field>
      </div>
      <Field label="Gutter guard notes"><TextInput value={strOf(form.gutterGuardNotes)} onChange={(v) => update({ gutterGuardNotes: v })} /></Field>

      <div className="oqb-grid2">
        <Field label="Chimney flashing"><Select value={strOf(form.chimneyType)} onChange={(v) => update({ chimneyType: v })} options={CHIMNEY_TYPE_OPTIONS} /></Field>
        {form.chimneyType !== 'na' && <Field label="Chimney pricing"><Select value={strOf(form.chimneyOption)} onChange={(v) => update({ chimneyOption: v })} options={CHIMNEY_OPTION_OPTIONS} /></Field>}
        {form.chimneyOption === 'oop' && form.chimneyType !== 'na' && <Field label="Chimney out-of-pocket"><MoneyInput value={strOf(form.chimneyOopPrice)} onChange={(v) => update({ chimneyOopPrice: v })} /></Field>}
        <Field label="Skylights"><Select value={strOf(form.skylights)} onChange={(v) => update({ skylights: v })} options={SKYLIGHT_OPTIONS} /></Field>
        <Field label="Underlayment"><Select value={strOf(form.underlaymentType)} onChange={(v) => update({ underlaymentType: v })} options={UNDERLAYMENT_OPTIONS} /></Field>
        <Field label="Ice & Water Shield"><Select value={strOf(form.iceWaterShield)} onChange={(v) => update({ iceWaterShield: v })} options={ICEWATER_OPTIONS} /></Field>
        <Field label="Starter strip"><Select value={strOf(form.starterStrip)} onChange={(v) => update({ starterStrip: v })} options={STARTER_OPTIONS} /></Field>
        <Field label="Drip edge"><Select value={strOf(form.dripEdgeOption)} onChange={(v) => update({ dripEdgeOption: v })} options={DRIPEDGE_OPTIONS} /></Field>
        {form.dripEdgeOption === 'oop' && <Field label="Drip edge out-of-pocket"><MoneyInput value={strOf(form.dripEdgeOopPrice)} onChange={(v) => update({ dripEdgeOopPrice: v })} /></Field>}
      </div>
      <Field label="Underlayment notes"><TextInput value={strOf(form.underlaymentNotes)} onChange={(v) => update({ underlaymentNotes: v })} /></Field>
      <Field label="Ventilation"><Checkbox checked={!!form.ridgeVentIncluded} onChange={(v) => update({ ridgeVentIncluded: v })} label="Ridge vent included" /></Field>
      <div className="oqb-grid2">
        <Field label="Ridge vent out-of-pocket"><MoneyInput value={strOf(form.ridgeVentOopPrice)} onChange={(v) => update({ ridgeVentOopPrice: v })} /></Field>
        <Field label="Ventilation notes"><TextInput value={strOf(form.ventilationNotes)} onChange={(v) => update({ ventilationNotes: v })} /></Field>
      </div>

      <Field label="Other shingles available (at insurance price)" hint="Warranty terms may differ from your preferred shingle.">
        <div>
          {SHINGLE_OPTIONS.map((g) => (
            <div key={g.mfr} style={{ marginBottom: '0.5rem' }}>
              <div className="oqb-label" style={{ marginBottom: '0.2rem' }}>{g.mfr}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: '0.1rem' }}>
                {g.items.map((p) => {
                  const val = `${g.mfr}|${p}`;
                  return <Checkbox key={val} checked={(form.otherShingles ?? []).includes(val)} onChange={(on) => toggleShingle(val, on)} label={p} />;
                })}
              </div>
            </div>
          ))}
        </div>
      </Field>
      <Field label="Other shingles notes"><TextInput value={strOf(form.shingleOtherNotes)} onChange={(v) => update({ shingleOtherNotes: v })} /></Field>
    </Card>
  );
}

function SecondLayerCard({ form, update }: { form: BidFormState; update: (p: Partial<BidFormState>) => void }) {
  return (
    <Card title="Second-Layer Tear-Off Contingency" sub="Optional pricing if a second layer is discovered during tear-off (retail roofing).">
      <Field label="Method"><RadioRow name="slcMethod" value={strOf(form.slcMethod) || 'per_square'} onChange={(v) => update({ slcMethod: v })} options={SLC_METHOD_OPTIONS} /></Field>
      <div className="oqb-grid2">
        <Field label="Price per square"><MoneyInput value={strOf(form.slcPricePerSquare)} onChange={(v) => update({ slcPricePerSquare: v })} /></Field>
        <Field label="Flat fee alternative"><MoneyInput value={strOf(form.slcFlatFeeAlternative)} onChange={(v) => update({ slcFlatFeeAlternative: v })} /></Field>
      </div>
    </Card>
  );
}

function GutterTradeCard({ form, update }: { form: BidFormState; update: (p: Partial<BidFormState>) => void }) {
  return (
    <Card title="Gutters" sub="Pricing and details for the gutter trade.">
      <div className="oqb-grid2">
        <Field label="Linear footage"><TextInput type="number" value={strOf(form.gutterLinearFootage)} onChange={(v) => update({ gutterLinearFootage: v })} /></Field>
        <Field label='5" gutters & downspouts price'><MoneyInput value={strOf(form.gutter5InchPrice)} onChange={(v) => update({ gutter5InchPrice: v })} /></Field>
        <Field label='6" gutters & downspouts price'><MoneyInput value={strOf(form.gutter6InchPrice)} onChange={(v) => update({ gutter6InchPrice: v })} /></Field>
      </div>
      <Field label="Rotten wood / fascia pricing"><TextInput value={strOf(form.rottenWoodPricing)} onChange={(v) => update({ rottenWoodPricing: v })} /></Field>
      <Field label="Additional notes"><TextInput value={strOf(form.gutterAdditionalNotes)} onChange={(v) => update({ gutterAdditionalNotes: v })} /></Field>
      <Field label="Gutter warranty"><TextInput value={strOf(form.gutterWarrantyInfo)} onChange={(v) => update({ gutterWarrantyInfo: v })} /></Field>
    </Card>
  );
}

function SidingTradeCard({ form, update, hasRoofing }: { form: BidFormState; update: (p: Partial<BidFormState>) => void; hasRoofing: boolean }) {
  return (
    <Card title="Siding" sub="Product supply and pricing for the siding trade.">
      <Field label="Can you supply the selected product?">
        <RadioRow name="sidingProductSupply" value={strOf(form.sidingProductSupply)} onChange={(v) => update({ sidingProductSupply: v })} options={SIDING_SUPPLY_OPTIONS} />
      </Field>
      {form.sidingProductSupply === 'equivalent' && (
        <Field label="Describe the equivalent product"><TextInput value={strOf(form.sidingEquivalentProduct)} onChange={(v) => update({ sidingEquivalentProduct: v })} /></Field>
      )}
      <Field label="Rotten sheathing replacement pricing"><TextInput value={strOf(form.sidingRottenSheathingPricing)} onChange={(v) => update({ sidingRottenSheathingPricing: v })} /></Field>
      {!hasRoofing && (
        <div className="oqb-grid2">
          <Field label="Install price per square"><MoneyInput value={strOf(form.sidingInstallPerSquare)} onChange={(v) => update({ sidingInstallPerSquare: v })} /></Field>
          <Field label="Trim price"><MoneyInput value={strOf(form.sidingTrimPrice)} onChange={(v) => update({ sidingTrimPrice: v })} /></Field>
          <Field label="Window wrap price"><MoneyInput value={strOf(form.sidingWindowWrapPrice)} onChange={(v) => update({ sidingWindowWrapPrice: v })} /></Field>
          <Field label="Tear-down price"><MoneyInput value={strOf(form.sidingTeardownPrice)} onChange={(v) => update({ sidingTeardownPrice: v })} /></Field>
        </div>
      )}
      <Field label="Additional notes"><TextInput value={strOf(form.sidingAdditionalNotes)} onChange={(v) => update({ sidingAdditionalNotes: v })} /></Field>
      <Field label="Siding warranty"><TextInput value={strOf(form.sidingWarrantyInfo)} onChange={(v) => update({ sidingWarrantyInfo: v })} /></Field>
    </Card>
  );
}

function OtherTradesCard({ form, update }: { form: BidFormState; update: (p: Partial<BidFormState>) => void }) {
  return (
    <Card title="Other Trades Covered (optional)" sub="If you can cover additional trades, note them here.">
      <div className="oqb-grid2">
        <Field label="Siding (full)"><TextInput value={strOf(form.tradeCoveredSidingFull)} onChange={(v) => update({ tradeCoveredSidingFull: v })} /></Field>
        <Field label="Siding (repair)"><TextInput value={strOf(form.tradeCoveredSidingRepair)} onChange={(v) => update({ tradeCoveredSidingRepair: v })} /></Field>
        <Field label="Gutters (full)"><TextInput value={strOf(form.tradeCoveredGuttersFull)} onChange={(v) => update({ tradeCoveredGuttersFull: v })} /></Field>
        <Field label="Gutters (repair)"><TextInput value={strOf(form.tradeCoveredGuttersRepair)} onChange={(v) => update({ tradeCoveredGuttersRepair: v })} /></Field>
        <Field label="Interior"><TextInput value={strOf(form.tradeCoveredInterior)} onChange={(v) => update({ tradeCoveredInterior: v })} /></Field>
        <Field label="Paint"><TextInput value={strOf(form.tradeCoveredPaint)} onChange={(v) => update({ tradeCoveredPaint: v })} /></Field>
        <Field label="Windows"><TextInput value={strOf(form.tradeCoveredWindows)} onChange={(v) => update({ tradeCoveredWindows: v })} /></Field>
        <Field label="Other"><TextInput value={strOf(form.tradeCoveredOther)} onChange={(v) => update({ tradeCoveredOther: v })} /></Field>
      </div>
      <Field label="Additional notes"><TextInput value={strOf(form.tradesCoveredAdditionalNotes)} onChange={(v) => update({ tradesCoveredAdditionalNotes: v })} /></Field>
      <Field label="Other offers / incentives"><TextArea value={strOf(form.valueAddsOtherOffers)} onChange={(v) => update({ valueAddsOtherOffers: v })} /></Field>
    </Card>
  );
}

function HomeownerMessageCard({ form, update }: { form: BidFormState; update: (p: Partial<BidFormState>) => void }) {
  return (
    <Card title="Message to Homeowner (optional)">
      <TextArea value={form.homeownerMessage} onChange={(v) => update({ homeownerMessage: v })} placeholder="Introduce yourself or add context for the homeowner…" rows={4} />
    </Card>
  );
}

function WizardBar({ step }: { step: number }) {
  const labels = ['Trades', 'Details', 'Review'];
  return (
    <div className="oqb-wizardbar">
      {labels.map((l, i) => {
        const n = i + 1;
        const cls = 'oqb-wstep' + (n === step ? ' active' : n < step ? ' done' : '');
        return (
          <div key={l} style={{ display: 'contents' }}>
            <div className={cls}><span className="num">{n < step ? '✓' : n}</span>{l}</div>
            {i < labels.length - 1 && <div className={'oqb-wconn' + (step > n ? ' done' : '')} />}
          </div>
        );
      })}
    </div>
  );
}

function FeeSection({ mode, claim, bidAmount, feePct, disclosure, calc, claimRcv, isInsuranceRcv, autoRenew, setAutoRenew, feeAccepted, setFeeAccepted }: {
  mode: BidMode; claim: Record<string, unknown>; bidAmount: number; feePct: number;
  disclosure: { feeAmount: number; netAmount: number };
  calc: { totalFeePercent: string; netAmount: number };
  claimRcv: number | null; isInsuranceRcv: boolean;
  autoRenew: boolean; setAutoRenew: (v: boolean) => void;
  feeAccepted: boolean; setFeeAccepted: (v: boolean) => void;
}) {
  const feeInfo = isInsuranceRcv && claimRcv ? BID_COPY.fee.feeInfoInsurance(formatCurrency(claimRcv)) : BID_COPY.fee.feeInfoRetail;
  return (
    <Card title="Platform Fee & Submission">
      <div className="oqb-fee-box">
        <div className="oqb-fee-row"><span>Your bid</span><span>{formatCurrency(bidAmount)}</span></div>
        <div className="oqb-fee-row"><span>Platform fee ({feePct.toFixed(2)}%)</span><span>{formatCurrency(disclosure.feeAmount)}</span></div>
        <div className="oqb-fee-row total"><span>Net to you upon completion</span><span>{formatCurrency(disclosure.netAmount)}</span></div>
        <div className="oqb-fee-info">{feeInfo}</div>
      </div>

      {mode !== 'change' && (
        <Checkbox checked={autoRenew} onChange={setAutoRenew} label="Auto-renew this bid for another 14-day window if it expires (D-150)." />
      )}

      <label className="oqb-accept">
        <input type="checkbox" checked={feeAccepted} onChange={(e) => setFeeAccepted(e.target.checked)} />
        <span>I understand and agree to the platform fee of {feePct.toFixed(2)}% ({formatCurrency(disclosure.feeAmount)}), deducted from my bid amount upon contract execution.</span>
      </label>
    </Card>
  );
}
