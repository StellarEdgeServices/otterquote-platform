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

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { supabase } from '@/lib/supabase';
import type { ContractorRecord } from '../../_shell/use-contractor-record';
import { Card, Field, TextInput, MoneyInput, TextArea, Select, Checkbox, RadioRow, formatCurrency, type Opt } from './bid-ui';
import { BID_COPY, buildFeeDisclosureText } from './copy';
import { wholeCentDollars } from '../../../../constants/platform-fee';
import { HomePhotosCard } from './home-photos-card';
import { FeeSection } from './fee-section';
import { WarrantyCard } from './warranty-card';
import { resolveBidAmount, wizardTradePrices, seedWizardPrices } from './wizard-total'; // gh-3495 (D-267)
import {
  type BidClaim, type BidMode, type TradeFlags, type WarrantySelectionInput,
  type ValueAddsFormState, type ValueAddsContext, type WizardState,
  buildValueAdds, serializeWarrantySelection, applyCustomWarrantyReview,
  parseConfiguredFeePct, storedQuoteFeePct, computeDisclosureFee, computeQuoteFeeBase,
  bidGateRpcParams, interpretBidGate, BID_GATE_ROUTES, DEFAULT_PLATFORM_FEE_PCT,
  buildScopeSummary, buildQuoteInsert, buildQuoteUpdate, renewQuoteRpcMode,
  buildFeeAcceptanceInsert, ipForInet, feeAcceptanceOutcome, buildBidConfirmationBody, buildNotifyContractorsBody, buildBidUpdatedNotification,
  computeWizardEligibility, wizardReducer, wroteRow, claimLocationLabel,
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

// gh-3497: plain wording for the two fee-rate stops, verbatim from the CEO's DECIDED (PR #3500 comment 6775653622). No rate or amount is printed.
const FEE_RATE_UNAVAILABLE_TEXT = "We couldn't load the platform fee for this bid, so your bid was not submitted and nothing was saved. Please try again in a moment.";
const FEE_RATE_MISMATCH_TEXT = "The platform fee shown on this form was out of date, so your bid was not saved. The form now shows the current fee and your entries are still here. Please review the fee, accept it again, and select Submit Bid.";
// gh-3488 (REVIEW 6674889982): both outside calls are bounded, so a hung one cannot hold the form.
const IP_LOOKUP_TIMEOUT_MS = 3000;
const FEE_LOOKUP_TIMEOUT_MS = 5000;
// gh-3491 (REVIEW 6688103147): bound on the Change Bid / renew UPDATE; a retry is harmless (same row, same fields).
const BID_UPDATE_TIMEOUT_MS = 15000;

async function getContractorIP(): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), IP_LOOKUP_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    return ipForInet(d.ip);
  } catch { return null; } finally { clearTimeout(timer); } // gh-3409: null, not 'unknown' (an inet column refuses the string and the acceptance was lost)
}

/**
 * The configured platform fee rate for this contractor and claim, or null when there is no answer: the lookup failed,
 * did not answer within FEE_LOOKUP_TIMEOUT_MS, or returned no usable rate.
 * gh-3497 (LEGAL-READ 6675181967): read through quotes_platform_fee_for(), the function the server trigger uses
 * (SECURITY DEFINER, executable by `authenticated`). platform_fee_config itself is admin-only under RLS, so a table
 * read as a contractor returned 0 rows, which is not an error and used to fall back to 5.00. The server resolves the
 * contractor's address_state and the claim's first trade itself. Submit stops on null; the page keeps showing the
 * rate it already has.
 */
async function fetchConfiguredFeePct(contractor: ContractorRecord, claim: Record<string, unknown>): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = Promise.resolve(supabase.rpc('quotes_platform_fee_for', {
      p_contractor_id: contractor.id,
      p_claim_id: String(claim.id),
    })).then(({ data, error }) => (error ? null : parseConfiguredFeePct(data)));
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FEE_LOOKUP_TIMEOUT_MS); });
    return await Promise.race([lookup, timeout]);
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}

/**
 * gh-3497 (LEGAL-READ 6743062238): the rate this form shows, accepts and sends. A new bid uses the configured rate. Change
 * Bid and Renew UPDATE the existing quote, and the quotes guard keeps that quote's stored rate on the contractor's UPDATE
 * (ruling 6050104316), so they use the stored rate; showing the configured one would show one fee and charge another.
 */
async function resolveBidFeePct(
  mode: BidMode,
  existingQuote: Record<string, unknown> | null,
  contractor: ContractorRecord,
  claim: Record<string, unknown>,
): Promise<number | null> {
  if ((mode === 'change' || mode === 'renew') && existingQuote) return storedQuoteFeePct(existingQuote);
  return fetchConfiguredFeePct(contractor, claim);
}

// gh-3498 (REVIEW 6675274132): the bid_can_submit gate and the quote insert are bounded, so a stalled connection ends in
// the existing error paths (message shown, form unlocked) instead of a permanent "Submitting…". Both exceed the lookups.
const GATE_TIMEOUT_MS = 10000;
const INSERT_TIMEOUT_MS = 20000;
// Widened closes-on (REVIEW 6688103147): every write AFTER the bid has landed is bounded too. The bid is already filed, so a
// timeout there is logged by the existing non-fatal catch and the submit goes on to the success screen.
const POST_WRITE_TIMEOUT_MS = 8000;
// Runs start(signal), aborts it after ms and rejects with the abort reason (no new wording).
function callWithTimeout<T>(ms: number, start: (signal: AbortSignal) => PromiseLike<T> | T): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(ctl.signal.reason); }, ms); });
  return Promise.race([Promise.resolve().then(() => start(ctl.signal)), limit]).finally(() => { if (timer) clearTimeout(timer); });
}
function withAbortSignal<B>(builder: B, signal: AbortSignal): B {
  const b = builder as unknown as { abortSignal?: (s: AbortSignal) => B };
  return typeof b.abortSignal === 'function' ? b.abortSignal(signal) : builder;
}
type DbErr = { code?: string; message?: string; details?: string } | null;
const isIdemViolation = (e: DbErr) => !!e && e.code === '23505' && /quotes_idempotency_key_uidx/.test(`${e.message || ''} ${e.details || ''}`);
// The column is not in this database yet (migration not applied): the bid is filed as before.
const isIdemColumnMissing = (e: DbErr) => !!e && /idempotency_key/.test(e.message || '') && (e.code === 'PGRST204' || e.code === '42703');
// gh-3498 (REVIEW 6740720167): what a bid says, minus the fields that change on every attempt (acceptance time, the
// custom-warranty review stamp, the key). Two attempts with the same fingerprint would file the same bid.
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
// gh-3498 (REVIEW 6743281622): the terms of a bid as filed, comparable between the payload this form would send and a row read
// back from the database (same fields and rules as contractor-bid-form.html bidTermsFingerprint). Fee amounts are derived and
// timestamps and the key change per attempt, so they are left out. Numbers compare as numbers, JSON text as JSON, null = absent.
const BID_TERM_FIELDS = ['total_price', 'trade_type', 'scope_summary', 'notes', 'decking_price_per_sheet', 'full_redeck_price',
  'supplement_acknowledged', 'value_adds', 'per_trade_breakdown', 'auto_renew', 'warranty_option_id', 'warranty_snapshot',
  'workmanship_warranty_years', 'platform_fee_pct'];
function normTerm(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 10000) / 10000;
    if (/^[[{]/.test(s)) { try { return normTerm(JSON.parse(s)); } catch { /* plain text */ } }
    return s === '' ? null : s;
  }
  if (Array.isArray(v)) return v.length ? v.map(normTerm) : null;
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { const n = normTerm(x); if (n !== null) o[k] = n; }
    return Object.keys(o).length ? o : null;
  }
  return v;
}
function bidTermsFingerprint(row: Record<string, unknown> | null): string {
  const t: Record<string, unknown> = {};
  for (const k of BID_TERM_FIELDS) t[k] = row ? row[k] : null;
  const va = t.value_adds as Record<string, unknown> | null | undefined;
  if (va && typeof va === 'object' && va.warranty_admin_review && typeof va.warranty_admin_review === 'object') {
    t.value_adds = { ...va, warranty_admin_review: { ...(va.warranty_admin_review as Record<string, unknown>), flagged_at: null } };
  }
  return stableJson(normTerm(t));
}
function bidContentFingerprint(payload: Record<string, unknown>): string {
  const p: Record<string, unknown> = { ...payload };
  delete p.idempotency_key; delete p.fee_accepted_at;
  const va = p.value_adds as Record<string, unknown> | null | undefined;
  if (va && va.warranty_admin_review && typeof va.warranty_admin_review === 'object') {
    p.value_adds = { ...va, warranty_admin_review: { ...(va.warranty_admin_review as Record<string, unknown>), flagged_at: null } };
  }
  return stableJson(p);
}
function newIdempotencyKey(): string {
  const c = (typeof crypto !== 'undefined' ? crypto : undefined) as Crypto | undefined;
  return c && typeof c.randomUUID === 'function' ? c.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function track(event: string, params: Record<string, unknown>): void {
  try {
    const g = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
    if (typeof g === 'function') g('event', event, params);
  } catch { /* non-fatal */ }
}

type SubmitState = 'idle' | 'submitting' | 'done' | 'error';

export function BidForm({ mode: modeProp, claim, contractor, existingQuote: existingQuoteProp, flags, claimRcv, userId }: {
  mode: BidMode;
  claim: BidClaim & Record<string, unknown>;
  contractor: ContractorRecord;
  existingQuote: (Record<string, unknown> & { id: string }) | null;
  flags: TradeFlags;
  claimRcv: number | null;
  userId: string;
}) {
  // gh-3498 (REVIEW 6740720167 finding 2): when a retry finds that an earlier, timed-out attempt already filed the bid with other
  // terms, the form becomes Change Bid on that filed row (as a page reload would), so nothing is filed twice.
  const [filedQuote, setFiledQuote] = useState<(Record<string, unknown> & { id: string }) | null>(null);
  const mode: BidMode = filedQuote ? 'change' : modeProp;
  const existingQuote = filedQuote ?? existingQuoteProp;
  const router = useRouter();
  const claimTrades = useMemo(() => (Array.isArray(claim.trades) ? (claim.trades as string[]) : []), [claim.trades]);
  const hasRoofing = claimTrades.includes('roofing');
  const showRoofing = !flags.gutterTradeActive && !(flags.sidingTradeActive && !hasRoofing);

  const [form, setForm] = useState<BidFormState>(() => initialState(claim, flags, claimRcv, existingQuote));
  const update = (p: Partial<BidFormState>) => setForm((f) => ({ ...f, ...p }));

  const [feePct, setFeePct] = useState<number>(DEFAULT_PLATFORM_FEE_PCT);
  const [feeAccepted, setFeeAccepted] = useState(false);
  // gh-3488: submit waits for the configured rate, and an acceptance never outlives the rate it was given under.
  const [feeLookupDone, setFeeLookupDone] = useState(false);
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
  // gh-3495 N3: Change Bid / Renew of a stored multi-trade bid starts from its per_trade_breakdown.
  const [wizardPrices, setWizardPrices] = useState<Record<string, string>>(() => (wizardMode ? seedWizardPrices(existingQuote?.per_trade_breakdown) : {}));
  const wizardRounded = wizardTradePrices(wizard.queue, wizardPrices);

  // Resolve the config fee pct once (platform_fee_config, contracts unchanged).
  useEffect(() => {
    let active = true;
    setFeeLookupDone(false);
    (async () => {
      const pct = await resolveBidFeePct(mode, existingQuote, contractor, claim);
      if (!active) return;
      if (pct !== null) setFeePct(pct);
      setFeeLookupDone(true);
    })();
    return () => { active = false; };
  }, [mode, existingQuote, contractor, claim]);

  // gh-3495 (D-267): a multi-trade bid is the SUM of its trades (whole cents); fee, total_price and fee_amount all follow.
  // gh-3488: shown, stored and charged bid is whole cents.
  const bidAmount = wholeCentDollars(resolveBidAmount({ wizardMode, queue: wizard.queue, wizardPrices, bidPrice: form.bidPrice }));
  // A tick belongs to the figure it was given under: a different rate or a different bid is a different disclosure.
  useEffect(() => { setFeeAccepted(false); }, [feePct, bidAmount]);
  // gh-3498: one idempotency key per (claim, contractor) while the form is open, kept across every retry whatever is edited in
  // between (REVIEW 6740720167 finding 2), dropped only when the bid is filed or the form becomes Change Bid.
  const idemRef = useRef<{ key: string; fp: string } | null>(null);
  // Content fingerprints of insert attempts sent from this form that have not yet ended on the success screen; while not empty,
  // the next submit first looks for a bid already filed for this claim before it inserts anything (cleared only on success or
  // the Change Bid switch, REVIEW 6743281622).
  const unconfirmedRef = useRef<string[]>([]);
  // Id of the filed bid whose fee_acceptances write and confirmation email this form has already made, so a retry that finds
  // that same bid ends on the success screen without writing them twice (REVIEW 6744510442).
  const postWritesDoneRef = useRef<string | null>(null);
  const submitInFlight = useRef(false); // gh-3488: set synchronously, so nothing can file a second bid while one is running
  const disclosure = computeDisclosureFee(bidAmount, feePct);

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
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitState('submitting');
    const nowIso = new Date().toISOString();

    try {
      // gh-3488 (LEGAL-READ 6674806511): a fresh rate lookup at every submit. If the server's rate differs from the one
      // on screen, show it and require acceptance again (the effect on feePct clears the tick); nothing is filed.
      // gh-3497 (LEGAL-READ 6743062238): for Change Bid / Renew this is the quote's stored rate (see resolveBidFeePct).
      const freshPct = await resolveBidFeePct(mode, existingQuote, contractor, claim);
      // gh-3497: no answer from quotes_platform_fee_for means no submit. The rate on screen is not evidence of what the
      // server will store. The form keeps the contractor's entries and the error line shows the plain
      // fee_rate_unavailable text (FEE_RATE_UNAVAILABLE_TEXT, CEO DECIDED 6775653622), with no prefix.
      if (freshPct === null) {
        throw new Error('fee_rate_unavailable: the platform fee rate could not be read, so nothing was submitted');
      }
      if (freshPct !== feePct) {
        setFeePct(freshPct);
        setSubmitState('idle');
        return;
      }

      // D-199 bid-time validation gate (bid_can_submit RPC, contract unchanged).
      const gateParams = bidGateRpcParams(form.tradeType, claim, contractor.id);
      let gateData: unknown = null;
      let gateErr: unknown = null;
      try {
        ({ data: gateData, error: gateErr } = await callWithTimeout(GATE_TIMEOUT_MS, (signal) => withAbortSignal(supabase.rpc('bid_can_submit', gateParams), signal)));
      } catch {
        // gh-3498: a gate that never answers (or fails to connect) ends here with the existing network-error message
        setErrorMsg(BID_COPY.gate.networkError);
        setSubmitState('error');
        return;
      }
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
      const exactFeeText = buildFeeDisclosureText(feePct, feeAmount);
      const scopeSummary = buildScopeSummary({ brand: form.brandProduct, estimatedStartDate: form.startDate, estimatedCompletionTime: form.completionTime });
      const perTradeBreakdown = wizardMode ? wizardTradePrices(wizard.queue, wizardPrices) : null;
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
          now: new Date(),
          existingBidStatus: (existingQuote?.bid_status as string | null) ?? null,
        });
        // gh-3560: renew / reopen set bid_status, expired_at and expires_at server-side (the quotes guard trigger refuses
        // them to a direct UPDATE, 42501). RPC first, then the field UPDATE below.
        const renewRpcMode = renewQuoteRpcMode(mode === 'renew', (existingQuote?.bid_status as string | null) ?? null);
        if (renewRpcMode) {
          const { error: renewErr } = await supabase.rpc('renew_quote', { p_quote_id: existingQuote!.id, p_mode: renewRpcMode });
          if (renewErr) throw renewErr;
        }
        // gh-3491: an UPDATE that never answers ends through the catch below (message, form unlocked). Abort the request and stop waiting.
        const updCtl = new AbortController();
        let updTimer: ReturnType<typeof setTimeout> | undefined;
        let upRows: unknown, upErr: unknown;
        try {
          ({ data: upRows, error: upErr } = await Promise.race([
            supabase.from('quotes').update(updatePayload).eq('id', existingQuote!.id).select('id').abortSignal(updCtl.signal),
            new Promise<never>((_, reject) => { updTimer = setTimeout(() => { updCtl.abort(); reject(new Error('bid_update_timed_out: the quote update did not answer')); }, BID_UPDATE_TIMEOUT_MS); }),
          ]));
        } finally { if (updTimer) clearTimeout(updTimer); }
        if (upErr) throw upErr;
        // gh-2105 (decision a, money — HIGH PRIORITY): `.update()` without
        // `.select()` reports success even on a zero-row RLS/id-mismatch
        // match. This write is the bid's own price/terms change or renewal
        // — a silent miss here shows the contractor a "Bid updated"
        // success screen while quotes.total_price (what the homeowner sees
        // and what any later award pays out on) never changed.
        if (!wroteRow(upRows)) {
          throw new Error('bid_update_zero_rows: no matching quote row was updated');
        }
        // Homeowner "bid updated" notification + activity log + GA + contractor email (all non-fatal).
        try {
          await callWithTimeout(POST_WRITE_TIMEOUT_MS, (signal) => withAbortSignal(supabase.from('notifications').insert(buildBidUpdatedNotification({
            claimUserId: (claim.user_id as string) || null, claimId: String(claim.id),
            previewText: BID_COPY.bidUpdatedPreview(contractor.company_name), createdAtIso: nowIso,
          })), signal));
        } catch (e) { console.warn('Notification insert failed (non-fatal):', e); }
        try {
          await callWithTimeout(POST_WRITE_TIMEOUT_MS, (signal) => withAbortSignal(supabase.from('activity_log').insert({
            user_id: userId, event_type: 'bid_updated',
            title: `Bid updated for project ${String(claim.id).slice(0, 8) || '…'}`, created_at: nowIso,
            metadata: { claim_id: String(claim.id) }, // gh-2997: lets the activity_log trigger inherit is_test from the claim
          }), signal));
        } catch (e) { console.warn('Activity log failed (non-fatal):', e); }
        // fix4 (CEO ruling, PR #1979 comment 5698878146): claim_id removed —
        // a per-homeowner database identifier must not reach GA4.
        track('bid_updated', { bid_amount: bidAmount });
        try {
          await callWithTimeout(POST_WRITE_TIMEOUT_MS, (signal) => supabase.functions.invoke('notify-contractors', { body: buildNotifyContractorsBody(mode === 'renew', String(claim.id), contractor.id), signal }));
        } catch (e) { console.warn('Bid update/renewal email failed (non-fatal):', e); }
      } else {
        const insertPayload = buildQuoteInsert(common);
        // gh-3498: the insert carries an idempotency key and is bounded. A retry after an attempt with no confirmed answer first
        // looks for a bid already filed for this claim (found even before the key column exists); if one races in anyway, the same
        // key hits the unique index and the filed row is read back. The filed row counts as this bid only when every unconfirmed
        // attempt carried exactly this content; otherwise the form becomes Change Bid on it (REVIEW 6740720167 finding 2).
        const contentFp = bidContentFingerprint(insertPayload);
        const fp = [String(claim.id), contractor.id].join('|');
        if (!idemRef.current || idemRef.current.fp !== fp) idemRef.current = { key: newIdempotencyKey(), fp };
        const idemKey = idemRef.current.key;
        const payloadWithKey: Record<string, unknown> = { ...insertPayload, idempotency_key: idemKey };
        const insertOnce = (body: Record<string, unknown>) => callWithTimeout(INSERT_TIMEOUT_MS, (signal) =>
          withAbortSignal(supabase.from('quotes').insert(body).select('id').single(), signal));
        type FiledRow = Record<string, unknown> & { id: string };
        let inserted: unknown = null;
        let insErr: unknown = null;
        let filed: FiledRow | null = null;
        if (unconfirmedRef.current.length) {
          const { data: onFile, error: lookErr } = await callWithTimeout(INSERT_TIMEOUT_MS, (signal) => withAbortSignal(
            supabase.from('quotes').select('*').eq('claim_id', String(claim.id)).eq('contractor_id', contractor.id).maybeSingle(), signal));
          if (lookErr) throw lookErr; // nothing is inserted on a failed lookup; the catch shows the message and unlocks
          if (onFile && (onFile as { id?: string }).id) filed = onFile as FiledRow;
        }
        if (!filed) {
          if (!unconfirmedRef.current.includes(contentFp)) unconfirmedRef.current.push(contentFp);
          ({ data: inserted, error: insErr } = await insertOnce(payloadWithKey));
          if (insErr && isIdemColumnMissing(insErr as DbErr)) {
            ({ data: inserted, error: insErr } = await insertOnce(insertPayload));
          }
          if (insErr && isIdemViolation(insErr as DbErr)) {
            const { data: existing, error: readErr } = await callWithTimeout(INSERT_TIMEOUT_MS, (signal) =>
              withAbortSignal(supabase.from('quotes').select('*').eq('idempotency_key', idemKey).maybeSingle(), signal));
            if (!readErr && existing && (existing as { id?: string }).id) { filed = existing as FiledRow; insErr = null; }
          }
        }
        if (insErr) throw insErr;
        if (filed) {
          // REVIEW 6743281622: the filed row's OWN terms against this retry's terms, whichever earlier attempt landed.
          const sameBid = bidTermsFingerprint(filed) === bidTermsFingerprint(insertPayload)
            && (!filed.idempotency_key || filed.idempotency_key === idemKey);
          if (!sameBid) {
            idemRef.current = null; unconfirmedRef.current = []; postWritesDoneRef.current = null;
            setFiledQuote(filed);
            setForm(initialState(claim, flags, claimRcv, filed));
            setErrorMsg(BID_COPY.bidAlreadyFiled);
            setSubmitState('error');
            return;
          }
          inserted = filed; // the earlier attempt filed exactly this bid: finish it (acceptance, email, success)
        }
        const bidId = (inserted as { id: string }).id;
        // D-215 Layer 1 fee_acceptances + Layer 2 send-bid-confirmation (non-fatal; quote committed). Not twice for the same filed bid.
        if (postWritesDoneRef.current !== bidId) {
        try {
          const ip = await getContractorIP();
          // gh-3409: .select('id') and NEVER .single() (a diverted row returns zero rows; .single() would make PostgREST roll the quarantine row back).
          const feeIns = supabase.from('fee_acceptances').insert(buildFeeAcceptanceInsert({
            contractorId: contractor.id, claimId: String(claim.id), bidId, feePct, feeAmount,
            feeTextDisplayed: exactFeeText, acceptedAtIso: nowIso, ipAddress: ip,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          })).select('id');
          const feeRes = await callWithTimeout(POST_WRITE_TIMEOUT_MS, (signal) => withAbortSignal(feeIns, signal)); // gh-3498: bounded; a timeout lands in the non-fatal catch below
          const feeOutcome = feeAcceptanceOutcome(feeRes);
          if (feeOutcome !== 'recorded') {
            const feeMsg = feeOutcome === 'failed' ? '[D-215] Fee acceptance record failed (non-fatal, quote committed)' : '[D-215] Fee acceptance diverted to quarantine';
            console.error(feeMsg, feeRes.error?.message);
            try { // gh-3498 (6744510442): Sentry reporting is best-effort and must not escape into the submit's error path
              Sentry.captureMessage(feeMsg, { level: feeOutcome === 'failed' ? 'error' : 'warning', extra: { bid_id: bidId, claim_id: String(claim.id), contractor_id: contractor.id, code: feeRes.error?.code, message: feeRes.error?.message } });
            } catch (se) { console.warn('[gh-3498] Sentry report failed:', se); }
          }
        } catch (e) {
          // gh-3498: a timed-out (or otherwise thrown) acceptance write must leave a trace, as the HTML form does: the quote is filed, the D-215 row may not be.
          console.error('[D-215] fee acceptance failed (non-fatal):', e);
          try { Sentry.captureException(e, { extra: { bid_id: bidId, claim_id: String(claim.id), contractor_id: contractor.id } }); }
          catch (se) { console.warn('[gh-3498] Sentry report failed:', se); }
        }
        // The acceptance write has been made or attempted (a timed-out one may still have landed): never again for this bid.
        postWritesDoneRef.current = bidId;
        try {
          const tradeLabel = wizardMode && wizard.queue.length > 0 ? wizard.queue.join(', ') : (claimTrades.length ? claimTrades.join(', ') : 'roofing');
          await callWithTimeout(POST_WRITE_TIMEOUT_MS, (signal) => supabase.functions.invoke('send-bid-confirmation', {
            body: buildBidConfirmationBody({ quoteId: bidId, contractorId: contractor.id, bidAmount, feePct, feeAmount, trade: tradeLabel }),
            signal,
          }));
        } catch (e) { console.error('[D-215 Layer 2] send-bid-confirmation failed (non-fatal):', e); }
        }
        track('bid_submit', { trade_types: claimTrades, job_type: flags.isRetailJob ? 'retail' : 'insurance', bid_amount: bidAmount });
      }

      // Clear wizard localStorage state on success (parity with clearWizardState).
      try { localStorage.removeItem(`oq_wizard_${claim.id}`); } catch { /* ignore */ }
      idemRef.current = null; // gh-3498: this bid is filed; its key is spent
      unconfirmedRef.current = []; postWritesDoneRef.current = null;
      setSubmitState('done');
    } catch (err) {
      console.error('Error submitting bid:', err);
      // gh-3497: a refused insert arrives from supabase-js as a PostgrestError, which is not always an Error instance;
      // its message (e.g. fee_rate_mismatch) must reach the contractor rather than "Unknown error".
      const errMsg = err instanceof Error ? err.message
        : (err && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : 'Unknown error');
      // gh-3497: the two fee-rate stops show plain wording (CEO DECIDED, PR #3500 comment 6775653622), matched on the code.
      setErrorMsg(/fee_rate_unavailable/.test(errMsg) ? FEE_RATE_UNAVAILABLE_TEXT
        : /fee_rate_mismatch/.test(errMsg) ? FEE_RATE_MISMATCH_TEXT
        : 'Error submitting bid: ' + errMsg);
      setSubmitState('error');
      // gh-3497: the server refused the bid because the rate shown differs from the configured one (quotes trigger,
      // fee_rate_mismatch). Nothing was saved and the entries are still here. The acceptance was given to the old
      // figure, so clear it and re-read the rate: the page then shows the configured figure to be accepted again.
      if (/fee_rate_mismatch/.test(errMsg)) {
        setFeeAccepted(false);
        void resolveBidFeePct(mode, existingQuote, contractor, claim).then((p) => { if (p !== null) setFeePct(p); });
      }
    } finally {
      submitInFlight.current = false;
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
  const submitDisabled = submitState === 'submitting' || !feeAccepted || !feeLookupDone;

  // The currently-shown wizard trade (step 2), if any.
  const wizardTrade = wizardMode && wizard.step === 2 ? wizard.queue[wizard.tradeIdx] : null;

  return (
    <div className="oqb-wrap">
      <h1 className="oqb-h1">{mode === 'renew' ? BID_COPY.pageTitleRenew : mode === 'change' ? BID_COPY.pageTitleChange : BID_COPY.pageTitleSubmit}</h1>
      <p className="oqb-sub">{claimLocationLabel(claim) || 'Submit your competitive bid for this project.'}</p>

      {mode === 'change' && <div className="oqb-banner oqb-banner-change">You are editing your existing bid for this project.</div>}
      {mode === 'renew' && <div className="oqb-banner oqb-banner-renew">Your previous bid expired — renewing resets the 14-day window.</div>}

      <ProjectSummary claim={claim} flags={flags} claimRcv={claimRcv} contractorId={contractor.id} />

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
                    <span className="oqb-summary-v">{wizardRounded[t] ? formatCurrency(wizardRounded[t]) : '—'}</span>
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

          <FeeSection mode={mode} bidAmount={bidAmount} feePct={feePct} disclosure={disclosure}
            claimRcv={claimRcv} isInsuranceRcv={claim.job_type === 'insurance_rcv'}
            autoRenew={form.autoRenew} setAutoRenew={(v) => update({ autoRenew: v })}
            feeAccepted={feeAccepted} setFeeAccepted={setFeeAccepted} locked={submitState === 'submitting'} />

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

function ProjectSummary({ claim, flags, claimRcv, contractorId }: { claim: Record<string, unknown>; flags: TradeFlags; claimRcv: number | null; contractorId: string }) {
  const carrier = (claim.carrier_profiles as { carrier_name?: string } | null)?.carrier_name;
  return (
    <Card title="Project Summary">
      <div className="oqb-summary">
        <span className="oqb-summary-k">Location</span><span className="oqb-summary-v">{claimLocationLabel(claim) || '—'}</span>
        <span className="oqb-summary-k">{flags.isRetailJob ? 'Funding' : 'Carrier'}</span>
        <span className="oqb-summary-v">{flags.isRetailJob ? 'Out of Pocket' : (carrier || '—')}</span>
        <span className="oqb-summary-k">Damage</span><span className="oqb-summary-v">{strOf(claim.damage_type) || '—'}</span>
        {claimRcv != null && !flags.isRetailJob && (<><span className="oqb-summary-k">RCV</span><span className="oqb-summary-v">{formatCurrency(claimRcv)}</span></>)}
      </div>
      <DocLinks claim={claim} contractorId={contractorId} />
    </Card>
  );
}

function DocLinks({ claim, contractorId }: { claim: Record<string, unknown>; contractorId: string }) {
  // gh-2559 / D-368: before selection a bidding contractor sees only the parsed summary of the
  // uploaded estimate, not the file; the storage policy refuses it. Only the selected contractor
  // is offered the Loss Sheet button.
  const canOpenRawEstimate = !!claim.estimate_filename && !!contractorId && claim.selected_contractor_id === contractorId;
  async function openLossSheet() {
    if (!canOpenRawEstimate) return;
    const { data, error } = await supabase.storage.from('claim-documents').createSignedUrl(String(claim.estimate_filename), 3600);
    if (error || !data?.signedUrl) { alert('Unable to open the loss sheet. Please try again.'); return; }
    window.open(data.signedUrl, '_blank');
  }
  // gh-2559 / D-370: the measurement report opens only for the contractor the homeowner selected.
  const canOpenMeasurementPdf = !!claim.id && !!contractorId && claim.selected_contractor_id === contractorId;
  // gh-1873: the measurement vendor (Hover) is retired; no back-end function is called.
  async function openHoverPdf() {
    if (!canOpenMeasurementPdf) return;
    alert('The vendor measurement PDF is no longer available. Use the measurements and photos the homeowner uploaded, or contact support if you need a measurement report for this project.');
  }
  return (
    <div className="oqb-doclinks">
      {canOpenRawEstimate && <button type="button" className="oqb-doclink" onClick={openLossSheet}>📄 View Loss Sheet</button>}
      {canOpenMeasurementPdf && <button type="button" className="oqb-doclink" onClick={openHoverPdf}>📏 View Measurement PDF</button>}
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
