/**
 * Contractor Bid Form — pure helpers (D-211 Phase 7, port of
 * contractor-bid-form.html). Extracted so the parity test can exercise the
 * ported logic without importing page.tsx (which pulls in the Supabase client).
 * All functions are pure; the page is the only place that touches the network,
 * the DOM, localStorage, or `window`.
 *
 * Ported behavior-for-behavior from contractor-bid-form.html @ main (52fd26c2):
 *   - init() gating order (pending → attestation → COI → CPA → profile)  : :3563-3602
 *   - PLATFORM_FEES.contractSigning = 0.05                                : :2431-2433
 *   - updateFeeCalculator (RCV-vs-bid fee base)                           : :4343-4373
 *   - fetchPlatformFeePercentage / updateFeeDisclosure                    : :4925-4986
 *   - quote fee base (insurance_rcv → parsed_line_items.summary.rcv)      : :5128-5137
 *   - getD202WarrantySelection (manufacturer×tier + custom)               : :4657-4709
 *   - checkBidCanSubmitGate + gate inputs                                 : :4712-4731 / :5108-5124
 *   - quotes insert / change-bid update (+ D-150 renew reset)             : :5287-5355
 *   - fee_acceptances (D-215 Layer 1) / send-bid-confirmation (Layer 2)   : :5420-5459
 *   - notify-contractors / bid_updated notification                      : :5360-5398
 *   - rescind-bid request + RESCINDABLE statuses                          : :5746-5793
 *   - trade/path flags (isRetailJob / gutter / siding)                    : :3123-3128
 *
 * Tier-3 note: this file SHAPES payloads for the existing bid_can_submit RPC and
 * the create-/notify-/send-/rescind EFs and writes to quotes/fee_acceptances —
 * all called with their UNCHANGED contracts. It changes no fee logic and no
 * legal copy (verbatim strings live in copy.ts). The §6.1 Phase-7 backend
 * findings are filed for migration-author, NOT touched here.
 */

import { CUSTOM_WARRANTY_TAIL } from './copy';

// ── Flat platform fee rate (contractor-bid-form.html:2431-2433) ──────────────
export const PLATFORM_FEE_CONTRACT_SIGNING = 0.05; // 5%
// quotes.fee_percentage is written as a hardcoded 5.0 by the static submit
// handler (:5126/:5291); platform_fee_pct + fee_acceptances use the config-
// resolved pct. Faithful port — do NOT "reconcile" (fee logic is Tier-3).
export const QUOTE_FEE_PERCENTAGE = 5.0;
export const DEFAULT_PLATFORM_FEE_PCT = 5.0; // _platformFeePct default (:4921)

// ── Contractor-track redirect targets, flipped to the live React routes ──────
// (static contractor-bid-form.html sent these to *.html; Phases 2/5/6 made the
// React routes live, so the bid page bounces same-origin in-app — see init():3565-3600).
export const BID_GATE_ROUTES = {
  pending: '/contractor/dashboard?msg=pending_approval',
  attestation: '/contractor/settings?reason=attestation_required',
  coi: '/contractor/settings?reason=coi_required#coiCard',
  dashboard: '/contractor/dashboard',
  profileIncomplete: '/contractor/profile?incomplete=bid',
  profileTemplates: '/contractor/profile#templates',
} as const;

// =============================================================================
// GATING (init(), contractor-bid-form.html:3563-3602)
// =============================================================================

/** Minimal contractor shape the bid gates read. */
export interface BidGateContractor {
  status?: string | null;
  attestation_accepted_at?: string | null;
  coi_file_url?: string | null;
  coi_expires_at?: string | null;
  company_name?: string | null;
  phone?: string | null;
  trades?: unknown;
  service_counties?: unknown;
}

/** D-170: contractor has an accepted attestation (:3572). */
export function hasAttestation(c: BidGateContractor | null | undefined): boolean {
  return !!c?.attestation_accepted_at;
}

/**
 * D-170: contractor has a current COI — file present AND expiry in the future.
 * Mirrors the static `new Date(coi_expires_at + 'T00:00:00') > new Date()` (:3573-3574).
 * `now` is injected for testability (the static page uses `new Date()`).
 */
export function isCoiOk(c: BidGateContractor | null | undefined, now: Date = new Date()): boolean {
  if (!c?.coi_file_url || !c?.coi_expires_at) return false;
  const expiry = new Date(c.coi_expires_at + 'T00:00:00');
  if (Number.isNaN(expiry.getTime())) return false;
  return expiry > now;
}

/** Profile-completeness gate (:3594-3599): company_name, phone, ≥1 trade, ≥1 service county. */
export function isProfileComplete(c: BidGateContractor | null | undefined): boolean {
  if (!c) return false;
  const hasCompanyName = typeof c.company_name === 'string' && c.company_name.trim() !== '';
  const hasPhone = typeof c.phone === 'string' && c.phone.trim() !== '';
  const hasTrades = Array.isArray(c.trades) && c.trades.length > 0;
  const hasServiceCounties = Array.isArray(c.service_counties) && c.service_counties.length > 0;
  return hasCompanyName && hasPhone && hasTrades && hasServiceCounties;
}

/** True when status is present and not 'active' — pending/approval gate (:3564). */
export function isPendingApproval(c: BidGateContractor | null | undefined): boolean {
  const status = c?.status;
  return !!status && status !== 'active';
}

/**
 * The redirect targets that run BEFORE the CPA guard — pending → attestation →
 * COI — in the static page's exact order (:3564-3582). Returns the first
 * applicable redirect URL, else null. The page applies the CPA guard
 * (enforceCpaRedirect, which carries a localStorage anti-loop side effect)
 * AFTER this and BEFORE profileIncompleteRedirect, preserving init()'s order.
 */
export function preCpaBidGate(
  c: BidGateContractor | null | undefined,
  now: Date = new Date(),
): string | null {
  if (isPendingApproval(c)) return BID_GATE_ROUTES.pending;
  if (!hasAttestation(c)) return BID_GATE_ROUTES.attestation;
  if (!isCoiOk(c, now)) return BID_GATE_ROUTES.coi;
  return null;
}

/** The post-CPA profile-completeness redirect (:3599-3601), else null. */
export function profileIncompleteRedirect(c: BidGateContractor | null | undefined): string | null {
  return isProfileComplete(c) ? null : BID_GATE_ROUTES.profileIncomplete;
}

// =============================================================================
// TRADE / PATH FLAGS (contractor-bid-form.html:3123-3128)
// =============================================================================

export interface BidClaim {
  id?: string;
  user_id?: string | null;
  job_type?: string | null;
  funding_type?: string | null;
  trades?: unknown;
  selected_trades?: unknown;
  parsed_line_items?: unknown;
  rcv_amount?: number | null;
}

export interface TradeFlags {
  isRetailJob: boolean;
  gutterTradeActive: boolean;
  sidingTradeActive: boolean;
}

function tradeList(claim: BidClaim | null | undefined): string[] {
  return Array.isArray(claim?.trades) ? (claim!.trades as string[]) : [];
}

/** Retail / trade-active flags (:3123-3128). */
export function deriveTradeFlags(claim: BidClaim | null | undefined): TradeFlags {
  const isRetailJob = claim?.job_type === 'retail' || claim?.funding_type === 'cash';
  const trades = tradeList(claim);
  const hasRoofing = trades.includes('roofing');
  const hasGutters = trades.includes('gutters');
  const hasSiding = trades.includes('siding');
  return {
    isRetailJob,
    gutterTradeActive: hasGutters && !hasRoofing && !hasSiding,
    sidingTradeActive: hasSiding && isRetailJob,
  };
}

// =============================================================================
// FEE (calculator, disclosure, config lookup, quote fee base)
// =============================================================================

/** Inputs for the platform_fee_config lookup (:4930-4943). */
export function feeConfigLookupParams(
  contractor: { state?: string | null } | null | undefined,
  claim: BidClaim | null | undefined,
): { state: string; trade: string } {
  return {
    state: (contractor?.state ?? '').toUpperCase(),
    trade: (tradeList(claim)[0] ?? 'roofing').toLowerCase(),
  };
}

/** Resolve fee_pct from the platform_fee_config rows, else the default (:4950-4958). */
export function resolveFeePct(
  rows: { fee_pct?: number | string | null }[] | null | undefined,
  fallback: number = DEFAULT_PLATFORM_FEE_PCT,
): number {
  if (rows && rows.length > 0) {
    const parsed = parseFloat(String(rows[0]?.fee_pct));
    if (parsed) return parsed; // `|| _platformFeePct` — 0/NaN fall back, matching the static page
  }
  return fallback;
}

/**
 * Fee-calculator math (updateFeeCalculator, :4343-4353). For insurance_rcv jobs
 * the 5% fee base is the claim RCV; otherwise the bid amount.
 */
export function computeCalculatorFee(
  claim: BidClaim | null | undefined,
  claimRcv: number | null | undefined,
  bidAmount: number,
): { feeBase: number; contractSigningFee: number; totalFee: number; totalFeePercent: string; netAmount: number } {
  const isInsurance = claim?.job_type === 'insurance_rcv';
  const feeBase = isInsurance && claimRcv ? claimRcv : bidAmount;
  const contractSigningFee = feeBase * PLATFORM_FEE_CONTRACT_SIGNING;
  const totalFee = contractSigningFee;
  const totalFeePercent = feeBase > 0 ? ((totalFee / feeBase) * 100).toFixed(1) : '0';
  const netAmount = bidAmount - totalFee;
  return { feeBase, contractSigningFee, totalFee, totalFeePercent, netAmount };
}

/** Fee-disclosure math (updateFeeDisclosure, :4970-4971) — always bid-amount based. */
export function computeDisclosureFee(
  bidAmount: number,
  feePct: number,
): { feeAmount: number; netAmount: number } {
  const feeAmount = (bidAmount * feePct) / 100;
  return { feeAmount, netAmount: bidAmount - feeAmount };
}

/**
 * Fee base written to quotes.fee_amount (:5128-5137): for insurance_rcv jobs the
 * RCV from parsed_line_items.summary.rcv (parsing a JSON string if needed),
 * otherwise the bid total. NOTE the static handler reads `parsed_line_items`
 * here (not the `claimRcv`/`rcv_amount` the calculator display uses) — ported faithfully.
 */
export function computeQuoteFeeBase(claim: BidClaim | null | undefined, totalPrice: number): number {
  if (claim?.job_type === 'insurance_rcv' && claim?.parsed_line_items) {
    let pli: unknown = claim.parsed_line_items;
    if (typeof pli === 'string') {
      try { pli = JSON.parse(pli); } catch { pli = null; }
    }
    const summary = (pli as { summary?: { rcv?: number } } | null)?.summary;
    if (summary && summary.rcv) return summary.rcv;
  }
  return totalPrice;
}

// =============================================================================
// D-202 WARRANTY SELECTION (getD202WarrantySelection, :4657-4709)
// =============================================================================

export interface WarrantyCustomInput {
  manufacturer?: string | null;
  tier?: string | null;
  materialYears?: string | null;
  laborYears?: string | null;
  windMph?: string | null;
  hailClass?: string | null;
}

export interface WarrantySelectionInput {
  isCustom: boolean;
  /** From the selected warranty_options row (hidden inputs): option id + display_string. */
  optionId?: string | null;
  snapshot?: string | null;
  /** Free-text "Other" custom fields (only read when isCustom). */
  custom?: WarrantyCustomInput;
  /** Workmanship years — raw form value (string) or number; '' / NaN → null. */
  workmanshipYearsRaw?: string | number | null;
}

export interface WarrantySelection {
  warranty_option_id: string | null;
  warranty_snapshot: string | null;
  workmanship_warranty_years: number | null;
  is_custom: boolean;
  custom_payload?: {
    manufacturer: string | null;
    tier: string | null;
    material_years: string | null;
    labor_years: string | null;
    wind_mph: string | null;
    hail_class: string | null;
  };
}

function parseWorkmanship(raw: string | number | null | undefined): number | null {
  if (raw === '' || raw == null) return null;
  const wm = typeof raw === 'number' ? Math.trunc(raw) : parseInt(raw, 10);
  return Number.isFinite(wm) ? wm : null;
}

function trimOrNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/**
 * Serialize the warranty selection exactly as getD202WarrantySelection does
 * (:4657-4709), including the D-204 custom legal tail. Pure: the DOM reads in the
 * static function become structured input here.
 */
export function serializeWarrantySelection(input: WarrantySelectionInput): WarrantySelection {
  const workmanship = parseWorkmanship(input.workmanshipYearsRaw);

  if (input.isCustom) {
    const mfr = trimOrNull(input.custom?.manufacturer);
    const tier = trimOrNull(input.custom?.tier);
    const matY = trimOrNull(input.custom?.materialYears);
    const labY = trimOrNull(input.custom?.laborYears);
    const wind = trimOrNull(input.custom?.windMph);
    const hail = trimOrNull(input.custom?.hailClass);

    // All blank → treat as no warranty selected (:4673-4675).
    if (!mfr && !tier && !matY && !labY && !wind && !hail) {
      return { warranty_option_id: null, warranty_snapshot: null, workmanship_warranty_years: workmanship, is_custom: false };
    }

    const labY_str = labY ? `${labY} years` : 'None';
    const matY_str = matY || 'Per manufacturer';
    const wind_str = wind ? `${wind} mph` : 'Per product';
    const hail_str = hail || 'Standard';
    const snapshot =
      `${mfr || 'Custom'} ${tier || ''} — Material: ${matY_str}; Labor: ${labY_str}; Wind: ${wind_str}; Hail: ${hail_str}` +
      CUSTOM_WARRANTY_TAIL;

    return {
      warranty_option_id: null,
      warranty_snapshot: snapshot,
      workmanship_warranty_years: workmanship,
      is_custom: true,
      custom_payload: {
        manufacturer: mfr,
        tier,
        material_years: matY,
        labor_years: labY,
        wind_mph: wind,
        hail_class: hail,
      },
    };
  }

  return {
    warranty_option_id: input.optionId || null,
    warranty_snapshot: input.snapshot || null,
    workmanship_warranty_years: workmanship,
    is_custom: false,
  };
}

// =============================================================================
// D-199 BID-TIME GATE (bid_can_submit RPC inputs + result interpretation)
// =============================================================================

export interface BidGateResult {
  can_submit: boolean;
  reason: string | null;
  status: string | null;
}

/**
 * Derive the bid_can_submit RPC params (:5108-5113). `formTradeType` is the form's
 * tradeType field; falls back to the claim's selected/first trade then 'roofing'.
 * Funding collapses to 'insurance' | 'retail' (job_type startsWith 'insurance').
 */
export function bidGateRpcParams(
  formTradeType: string | null | undefined,
  claim: BidClaim | null | undefined,
  contractorId: string,
): { p_contractor_id: string; p_trade: string; p_funding_type: 'insurance' | 'retail' } {
  const selected = Array.isArray(claim?.selected_trades) ? (claim!.selected_trades as string[]) : [];
  const trade = (formTradeType || selected[0] || tradeList(claim)[0] || 'roofing').toLowerCase();
  const fundingRaw =
    claim?.funding_type ||
    (claim?.job_type && claim.job_type.startsWith('insurance') ? 'insurance' : 'retail');
  const p_funding_type: 'insurance' | 'retail' = fundingRaw === 'insurance' ? 'insurance' : 'retail';
  return { p_contractor_id: contractorId, p_trade: trade, p_funding_type };
}

/**
 * Interpret the bid_can_submit RPC result (checkBidCanSubmitGate, :4712-4731).
 * Mirrors the static fallbacks for missing contractor id, RPC error, and throw.
 */
export function interpretBidGate(
  data: BidGateResult | null | undefined,
  error: unknown,
  gateCopy: { couldNotVerifyTemplate: string; networkError: string },
): BidGateResult {
  if (error) {
    return { can_submit: false, reason: gateCopy.couldNotVerifyTemplate, status: null };
  }
  return data || { can_submit: false, reason: 'Unknown error', status: null };
}

// =============================================================================
// PAYLOADS — quotes, fee_acceptances, notifications, EF bodies, rescind
// =============================================================================

export interface ScopeSummaryInput {
  brand?: string | null;
  estimatedStartDate?: string | null;
  estimatedCompletionTime?: string | null;
}

/** scope_summary JSON (:5139-5143). */
export function buildScopeSummary(input: ScopeSummaryInput): string {
  return JSON.stringify({
    brand: input.brand || null,
    estimated_start_date: input.estimatedStartDate || null,
    estimated_completion_time: input.estimatedCompletionTime || null,
  });
}

export interface QuoteCommonInput {
  claimId: string;
  contractorId: string;
  totalPrice: number;
  /** Fee base for quotes.fee_amount (computeQuoteFeeBase). */
  feeBase: number;
  /** Config-resolved platform fee pct (_feePct) → platform_fee_pct + fee_acceptances. */
  feePct: number;
  acceptedAtIso: string;
  scopeSummary: string;
  notes?: string | null;
  deckingPricePerSheet?: number | null;
  fullRedeckPrice?: number | null;
  supplementAcknowledged?: boolean;
  tradeType?: string | null;
  valueAdds: Record<string, unknown>;
  perTradeBreakdown?: Record<string, unknown> | null;
  autoRenew: boolean;
  warranty: WarrantySelection;
}

/** quotes INSERT payload for a NEW bid (:5287-5311). */
export function buildQuoteInsert(input: QuoteCommonInput): Record<string, unknown> {
  return {
    claim_id: input.claimId,
    contractor_id: input.contractorId,
    total_price: input.totalPrice,
    fee_percentage: QUOTE_FEE_PERCENTAGE,
    fee_amount: input.feeBase * (QUOTE_FEE_PERCENTAGE / 100),
    scope_summary: input.scopeSummary,
    notes: input.notes ?? null,
    decking_price_per_sheet: input.deckingPricePerSheet ?? null,
    full_redeck_price: input.fullRedeckPrice ?? null,
    supplement_acknowledged: !!input.supplementAcknowledged,
    trade_type: input.tradeType || 'roofing',
    value_adds: input.valueAdds,
    per_trade_breakdown: input.perTradeBreakdown ?? null,
    is_auto_bid: false,
    auto_renew: input.autoRenew,
    warranty_option_id: input.warranty.warranty_option_id,
    warranty_snapshot: input.warranty.warranty_snapshot,
    workmanship_warranty_years: input.warranty.workmanship_warranty_years,
    platform_fee_pct: input.feePct,
    platform_fee_basis: 'bid_amount',
    fee_accepted_at: input.acceptedAtIso,
  };
}

export interface QuoteUpdateInput extends QuoteCommonInput {
  renewMode: boolean;
  existingRenewalsCount?: number | null;
  /** Injected for testability — the static page uses `new Date()`. */
  now?: Date;
}

export const BID_RENEWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // D-150 14-day window (:5350)

/** quotes UPDATE payload for a change-bid / renewal (:5326-5354). */
export function buildQuoteUpdate(input: QuoteUpdateInput): Record<string, unknown> {
  const now = input.now ?? new Date();
  const base: Record<string, unknown> = {
    total_price: input.totalPrice,
    fee_percentage: QUOTE_FEE_PERCENTAGE,
    fee_amount: input.feeBase * (QUOTE_FEE_PERCENTAGE / 100),
    platform_fee_pct: input.feePct,
    platform_fee_basis: 'bid_amount',
    fee_accepted_at: input.acceptedAtIso,
    scope_summary: input.scopeSummary,
    notes: input.notes ?? null,
    decking_price_per_sheet: input.deckingPricePerSheet ?? null,
    full_redeck_price: input.fullRedeckPrice ?? null,
    supplement_acknowledged: !!input.supplementAcknowledged,
    trade_type: input.tradeType || 'roofing',
    value_adds: input.valueAdds,
    per_trade_breakdown: input.perTradeBreakdown ?? null,
    auto_renew: input.autoRenew,
    warranty_option_id: input.warranty.warranty_option_id,
    warranty_snapshot: input.warranty.warranty_snapshot,
    workmanship_warranty_years: input.warranty.workmanship_warranty_years,
    updated_at: now.toISOString(),
  };
  if (input.renewMode) {
    // D-150 renewal — reset the bid window (:5347-5352).
    base.bid_status = 'submitted';
    base.expired_at = null;
    base.expires_at = new Date(now.getTime() + BID_RENEWAL_WINDOW_MS).toISOString();
    base.renewals_count = (input.existingRenewalsCount || 0) + 1;
  }
  return base;
}

/**
 * Inject the custom-warranty admin-review flag into value_adds (:5314-5321).
 * Returns a new object; only adds the flag when the selection is custom.
 */
export const CUSTOM_WARRANTY_REVIEW_NOTE =
  'Custom warranty submitted via D-202 Phase 2 free-text fallback. Review for possible manifest expansion.';

export function applyCustomWarrantyReview(
  valueAdds: Record<string, unknown>,
  selection: WarrantySelection,
  nowIso: string,
): Record<string, unknown> {
  if (!selection.is_custom) return valueAdds;
  return {
    ...valueAdds,
    warranty_admin_review: {
      flagged_at: nowIso,
      payload: selection.custom_payload,
      note: CUSTOM_WARRANTY_REVIEW_NOTE,
    },
  };
}

export interface FeeAcceptanceInput {
  contractorId: string;
  claimId: string;
  bidId: string;
  feePct: number;
  feeAmount: number;
  feeTextDisplayed: string;
  acceptedAtIso: string;
  ipAddress: string;
  userAgent: string;
}

/** fee_acceptances INSERT — D-215 UETA Layer 1 evidence (:5420-5431). */
export function buildFeeAcceptanceInsert(input: FeeAcceptanceInput): Record<string, unknown> {
  return {
    contractor_id: input.contractorId,
    claim_id: input.claimId,
    bid_id: input.bidId,
    fee_pct: input.feePct,
    fee_basis: 'bid_amount',
    fee_amount: input.feeAmount,
    fee_text_displayed: input.feeTextDisplayed,
    accepted_at: input.acceptedAtIso,
    ip_address: input.ipAddress,
    user_agent: input.userAgent,
  };
}

/** send-bid-confirmation EF body — D-215 UETA Layer 2 (:5451-5458). */
export function buildBidConfirmationBody(input: {
  quoteId: string;
  contractorId: string;
  bidAmount: number;
  feePct: number;
  feeAmount: number;
  trade: string;
}): Record<string, unknown> {
  return {
    quote_id: input.quoteId,
    contractor_id: input.contractorId,
    bid_amount: input.bidAmount,
    platform_fee_pct: input.feePct,
    platform_fee_amount: input.feeAmount,
    trade: input.trade,
  };
}

/** notify-contractors EF body for a change-bid / renewal (:5393-5397). */
export function buildNotifyContractorsBody(
  renewMode: boolean,
  claimId: string,
  contractorId: string,
): Record<string, unknown> {
  return {
    event_type: renewMode ? 'bid_renewal_requested' : 'bid_update_confirmed',
    claim_id: claimId,
    contractor_id: contractorId,
  };
}

/** Homeowner "bid updated" notification row (:5360-5368). `previewText` from copy. */
export function buildBidUpdatedNotification(input: {
  claimUserId: string | null | undefined;
  claimId: string;
  previewText: string;
  createdAtIso: string;
}): Record<string, unknown> {
  return {
    user_id: input.claimUserId || null,
    claim_id: input.claimId,
    channel: 'dashboard',
    notification_type: 'bid_updated',
    recipient: '',
    message_preview: input.previewText,
    created_at: input.createdAtIso,
  };
}

// ── Rescind (initRescindMode / confirmRescind, :5746-5793) ───────────────────
export const RESCINDABLE_STATUSES = ['submitted', 'pending', 'under_review'] as const;

export function isRescindable(bidStatus: string | null | undefined): boolean {
  return !!bidStatus && (RESCINDABLE_STATUSES as readonly string[]).includes(bidStatus);
}

/** rescind-bid EF request body (:5789-5793). */
export function buildRescindRequest(
  quoteId: string,
  contractorId: string,
): { quote_id: string; contractor_id: string; reason: string } {
  return { quote_id: quoteId, contractor_id: contractorId, reason: 'contractor_initiated' };
}

// =============================================================================
// MODES — read from the route ([claimId]) + query (?renew / ?action / ?project)
// =============================================================================

export type BidMode = 'submit' | 'change' | 'renew' | 'rescind';

/** Resolve the claim id from the dynamic segment, falling back to ?claim_id / ?project (:3504). */
export function resolveClaimId(
  segment: string | string[] | null | undefined,
  search: URLSearchParams,
): string | null {
  const fromSegment = Array.isArray(segment) ? segment[0] : segment;
  return fromSegment || search.get('claim_id') || search.get('project') || null;
}

/**
 * Resolve the bid mode. `hasExistingQuote` comes from the change-bid lookup
 * (quotes by claim_id + contractor_id, :3621-3634). Renew requires ?renew=true
 * AND an expired existing bid (:3633). ?action=rescind overrides everything (:5619).
 * ?action=sign is deprecated and falls through to the normal form (:5610-5616).
 */
export function resolveBidMode(args: {
  action: string | null;
  renewParam: string | null;
  hasExistingQuote: boolean;
  existingBidStatus?: string | null;
}): BidMode {
  if (args.action === 'rescind') return 'rescind';
  if (args.hasExistingQuote) {
    if (args.renewParam === 'true' && args.existingBidStatus === 'expired') return 'renew';
    return 'change';
  }
  return 'submit';
}

// =============================================================================
// VALUE-ADDS BUILDER (buildValueAdds — port of the submit handler's value_adds
// JSON construction, contractor-bid-form.html:5149-5285). PR-2 (BF-2) extracts
// this so the page can build the quotes.value_adds payload from typed form state
// instead of a live FormData/DOM read, and so it can be unit-tested. Behavior is
// byte-for-byte: every key, the `parseFloat(...) || null` coercions (0/NaN→null),
// the `=== 'on'` checkbox booleans, the conditional gutter/siding/SLC/wizard
// branches, and `warranties: null` (D-202 superseded).
// =============================================================================

/** `parseFloat(String(v)) || null` — 0, '', NaN all collapse to null (matches the static handler). */
function numOrNull(v: string | number | null | undefined): number | null {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** One dynamic gutter-guard row (collectGutterGuards, :2747-2757). */
export interface GutterGuardEntry {
  type: string | null;
  price: number | null;
}

/** Typed mirror of every bid-form field the static value_adds builder reads. */
export interface ValueAddsFormState {
  bidTypeOption: string;
  otherBidDescription?: string | null;

  gutterOption?: string | null;
  gutter5AdditionalCost?: string | number | null;
  gutter6AdditionalCost?: string | number | null;
  gutterOtherText?: string | null;

  gutterGuardPricingOnRequest?: boolean;
  gutterGuardMeshOop?: string | number | null;
  gutterGuardScrewInOop?: string | number | null;
  gutterGuardNotes?: string | null;

  chimneyType?: string | null;
  chimneyOption?: string | null;
  chimneyOopPrice?: string | number | null;

  skylights?: string | null;

  otherShingles?: string[];
  shingleOtherNotes?: string | null;

  underlaymentType?: string | null;
  underlaymentNotes?: string | null;

  iceWaterShield?: string | null;

  ridgeVentIncluded?: boolean;
  ridgeVentOopPrice?: string | number | null;
  ventilationNotes?: string | null;

  starterStrip?: string | null;

  dripEdgeOption?: string | null;
  dripEdgeOopPrice?: string | number | null;

  tradeCoveredSidingFull?: string | null;
  tradeCoveredSidingRepair?: string | null;
  tradeCoveredGuttersFull?: string | null;
  tradeCoveredGuttersRepair?: string | null;
  tradeCoveredInterior?: string | null;
  tradeCoveredPaint?: string | null;
  tradeCoveredWindows?: string | null;
  tradeCoveredOther?: string | null;
  tradesCoveredAdditionalNotes?: string | null;

  valueAddsOtherOffers?: string | null;
  numStories?: string | null;

  // ── Gutter-trade fields (only read when gutterTradeActive) ──
  gutterLinearFootage?: string | number | null;
  gutter5InchPrice?: string | number | null;
  gutter6InchPrice?: string | number | null;
  gutterGuardsRetail?: GutterGuardEntry[];
  rottenWoodPricing?: string | null;
  gutterAdditionalNotes?: string | null;
  gutterWarrantyInfo?: string | null;

  // ── Siding-trade fields (only read when sidingTradeActive) ──
  sidingProductSupply?: string | null;
  sidingEquivalentProduct?: string | null;
  sidingRottenSheathingPricing?: string | null;
  sidingAdditionalNotes?: string | null;
  sidingWarrantyInfo?: string | null;
  sidingInstallPerSquare?: string | number | null;
  sidingTrimPrice?: string | number | null;
  sidingWindowWrapPrice?: string | number | null;
  sidingTeardownPrice?: string | number | null;

  // ── Second-layer tear-off contingency (retail roofing) ──
  slcPricePerSquare?: string | number | null;
  slcFlatFeeAlternative?: string | number | null;
  slcMethod?: string | null;

  // ── Wizard step-3 fields (only read when wizardMode) ──
  wizardBundleNote?: string | null;
  wizardRationale?: string | null;
}

/** Context flags the value_adds builder branches on (deriveTradeFlags + claim trades + wizard). */
export interface ValueAddsContext {
  gutterTradeActive: boolean;
  sidingTradeActive: boolean;
  /** currentClaim.trades — the `!trades.includes('roofing')` siding-pricing gate (:5219). */
  claimTrades: string[];
  wizardMode: boolean;
  /** wizardTradeQueue — recorded into value_adds.wizard_trade_queue (:5279). */
  wizardTradeQueue: string[];
}

/**
 * Build the quotes.value_adds JSON exactly as the static submit handler does
 * (contractor-bid-form.html:5149-5285). Pure: the DOM/FormData reads become typed
 * ValueAddsFormState input; the output object is identical key-for-key.
 */
export function buildValueAdds(
  form: ValueAddsFormState,
  ctx: ValueAddsContext,
): Record<string, unknown> {
  const gutterOption = form.gutterOption || 'none';

  const valueAdds: Record<string, unknown> = {
    bid_type_option: form.bidTypeOption,
    other_bid_description: form.bidTypeOption === 'other' ? (form.otherBidDescription || null) : null,

    gutters: {
      option: gutterOption,
      additional_cost_5inch: gutterOption === '5inch_additional' ? numOrNull(form.gutter5AdditionalCost) : null,
      additional_cost_6inch: gutterOption === '6inch_additional' ? numOrNull(form.gutter6AdditionalCost) : null,
      other_text: gutterOption === 'other' ? (form.gutterOtherText || null) : null,
    } as Record<string, unknown>,

    gutter_guards: {
      pricing_on_request: !!form.gutterGuardPricingOnRequest,
      mesh_oop: numOrNull(form.gutterGuardMeshOop),
      screw_in_oop: numOrNull(form.gutterGuardScrewInOop),
      notes: form.gutterGuardNotes || null,
    },

    // Chimney Flashing / Reflash — merged (86e10t28v); legacy keys kept null for back-compat.
    chimney: {
      type: form.chimneyType || 'na',
      option: (form.chimneyType && form.chimneyType !== 'na') ? (form.chimneyOption || 'included') : null,
      oop_price: form.chimneyOption === 'oop' ? numOrNull(form.chimneyOopPrice) : null,
    },
    chimney_flashing: null,
    chimney_reflash: null,

    skylights: form.skylights || 'na',

    other_shingles: Array.isArray(form.otherShingles) ? form.otherShingles : [],
    other_shingles_notes: form.shingleOtherNotes || null,

    underlayment: {
      type: form.underlaymentType || null,
      notes: form.underlaymentNotes || null,
    },

    ice_water_shield: {
      coverage: form.iceWaterShield || 'not_applicable',
    },

    ventilation: {
      ridge_vent_included: !!form.ridgeVentIncluded,
      ridge_vent_oop: numOrNull(form.ridgeVentOopPrice),
      notes: form.ventilationNotes || null,
    },

    starter_strip: form.starterStrip || null,

    drip_edge: {
      option: form.dripEdgeOption || 'na',
      oop_price: form.dripEdgeOption === 'oop' ? numOrNull(form.dripEdgeOopPrice) : null,
    },

    warranties: null, // D-202 Phase 2: superseded by quotes.warranty_option_id / warranty_snapshot.

    other_trades_covered: {
      siding_full: form.tradeCoveredSidingFull || null,
      siding_repair: form.tradeCoveredSidingRepair || null,
      gutters_full: form.tradeCoveredGuttersFull || null,
      gutters_repair: form.tradeCoveredGuttersRepair || null,
      interior: form.tradeCoveredInterior || null,
      paint: form.tradeCoveredPaint || null,
      windows: form.tradeCoveredWindows || null,
      other: form.tradeCoveredOther || null,
      additional_notes: form.tradesCoveredAdditionalNotes || null,
    },

    other_offers: form.valueAddsOtherOffers || null,

    num_stories: form.numStories || null,
  };

  // Append gutter-trade fields (:5230-5238).
  if (ctx.gutterTradeActive) {
    const gutters = (valueAdds.gutters as Record<string, unknown>) || {};
    gutters.linearFootage = numOrNull(form.gutterLinearFootage);
    valueAdds.gutters = gutters;
    valueAdds.gutter_5inch_price = numOrNull(form.gutter5InchPrice);
    valueAdds.gutter_6inch_price = numOrNull(form.gutter6InchPrice);
    valueAdds.gutter_guards_retail = Array.isArray(form.gutterGuardsRetail) ? form.gutterGuardsRetail : [];
    valueAdds.rotten_wood_pricing = trimOrNull(form.rottenWoodPricing);
    valueAdds.gutter_additional_notes = trimOrNull(form.gutterAdditionalNotes);
    valueAdds.gutter_warranty = trimOrNull(form.gutterWarrantyInfo);
  }

  // Append siding-trade fields (:5242-5256).
  if (ctx.sidingTradeActive) {
    valueAdds.siding_product_supply = form.sidingProductSupply || null;
    valueAdds.siding_equivalent_product = trimOrNull(form.sidingEquivalentProduct);
    valueAdds.siding_rotten_sheathing_pricing = trimOrNull(form.sidingRottenSheathingPricing);
    valueAdds.siding_additional_notes = trimOrNull(form.sidingAdditionalNotes);
    valueAdds.siding_warranty = trimOrNull(form.sidingWarrantyInfo);
    // Pricing fields only for siding-only jobs (no roofing in the claim trades).
    if (!ctx.claimTrades.includes('roofing')) {
      valueAdds.siding_install_per_square = numOrNull(form.sidingInstallPerSquare);
      valueAdds.siding_trim_price = numOrNull(form.sidingTrimPrice);
      valueAdds.siding_window_wrap_price = numOrNull(form.sidingWindowWrapPrice);
      valueAdds.siding_teardown_price = numOrNull(form.sidingTeardownPrice);
    }
  }

  // Second-Layer Tear-Off Contingency (retail roofing, :5259-5269).
  const slcPerSq = numOrNull(form.slcPricePerSquare);
  const slcFlat = numOrNull(form.slcFlatFeeAlternative);
  if (slcPerSq != null || slcFlat != null) {
    valueAdds.secondLayerContingency = {
      pricePerSquare: slcPerSq,
      flatFeeAlternative: slcFlat,
      method: form.slcMethod || 'per_square',
    };
  }

  // Wizard step-3 fields (:5272-5281).
  if (ctx.wizardMode) {
    const bundleNote = trimOrNull(form.wizardBundleNote);
    const rationale = trimOrNull(form.wizardRationale);
    if (bundleNote) valueAdds.wizard_bundle_note = bundleNote;
    if (rationale) valueAdds.wizard_rationale = rationale;
    valueAdds.wizard_trade_queue = ctx.wizardTradeQueue.length > 0 ? ctx.wizardTradeQueue : null;
  }

  return valueAdds;
}

// =============================================================================
// D-162 MULTI-TRADE WIZARD — pure step-state (initWizard eligibility + the
// wizardNext / wizardBack / wizardGoTo transitions, :2473-2665). The page keeps
// the DOM/localStorage/history side effects; this models the state machine.
// =============================================================================

/** Wizard trade order (contractor-bid-form.html:2456). roofing → gutters → siding. */
export const WIZARD_TRADE_ORDER: readonly string[] = ['roofing', 'gutters', 'siding'];

/** Reduce an arbitrary trade list to WIZARD_TRADE_ORDER order (_syncWizardTradeSelection, :2517-2519). */
export function orderWizardTrades(trades: string[]): string[] {
  return WIZARD_TRADE_ORDER.filter((t) => trades.includes(t));
}

export interface WizardEligibility {
  eligible: boolean;
  queue: string[];
}

/**
 * initWizard eligibility (:2473-2488): retail-only; >=2 of the ordered trades;
 * the D-165 siding gate drops siding unless siding_bid_released_at is set; if the
 * gated queue has <2 trades there is no wizard.
 */
export function computeWizardEligibility(
  trades: string[],
  opts: { isRetailJob: boolean; sidingReleased: boolean },
): WizardEligibility {
  if (!opts.isRetailJob) return { eligible: false, queue: [] };
  const inOrder = WIZARD_TRADE_ORDER.filter((t) => trades.includes(t));
  if (inOrder.length < 2) return { eligible: false, queue: [] };
  const queued = inOrder.filter((t) => t !== 'siding' || opts.sidingReleased);
  if (queued.length < 2) return { eligible: false, queue: [] };
  return { eligible: true, queue: [...queued] };
}

export type WizardStep = 1 | 2 | 3;

export interface WizardState {
  step: WizardStep;
  tradeIdx: number;
  queue: string[];
  selectedTrades: string[];
}

export type WizardAction =
  | { type: 'setSelected'; selectedTrades: string[] }
  | { type: 'goto'; step: WizardStep; tradeIdx: number }
  | { type: 'next' }
  | { type: 'back' };

/**
 * Pure transition for the D-162 wizard (wizardNext :2638-2655, wizardBack
 * :2657-2665, wizardGoTo :2521, _syncWizardTradeSelection :2516). DOM, history,
 * localStorage, and captureCurrentTradePrice stay in the page's effects.
 */
export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'setSelected':
      return { ...state, selectedTrades: orderWizardTrades(action.selectedTrades) };
    case 'goto':
      return { ...state, step: action.step, tradeIdx: action.tradeIdx };
    case 'next':
      if (state.step === 1) {
        if (state.selectedTrades.length === 0) return state; // wizardNext alerts + no-ops
        return { ...state, queue: [...state.selectedTrades], step: 2, tradeIdx: 0 };
      }
      if (state.step === 2) {
        if (state.tradeIdx < state.queue.length - 1) {
          return { ...state, step: 2, tradeIdx: state.tradeIdx + 1 };
        }
        return { ...state, step: 3, tradeIdx: 0 };
      }
      return state;
    case 'back':
      if (state.step === 2 && state.tradeIdx === 0) return { ...state, step: 1, tradeIdx: 0 };
      if (state.step === 2 && state.tradeIdx > 0) return { ...state, step: 2, tradeIdx: state.tradeIdx - 1 };
      if (state.step === 3) return { ...state, step: 2, tradeIdx: Math.max(0, state.queue.length - 1) };
      return state;
    default:
      return state;
  }
}
