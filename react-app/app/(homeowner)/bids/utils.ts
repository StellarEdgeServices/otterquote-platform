/**
 * Pure, framework-free logic for the homeowner bids page (D-211 P21).
 *
 * Every card-state / expiry / comparison-grid decision the static bids.html made
 * inline is extracted here as a pure function so it can be unit-tested for parity
 * against the static page without rendering React. The components are thin shells
 * over these. Mirrors the dashboard/utils.ts model (injectable `now: Date` for
 * deterministic date math).
 *
 * Parity source of truth: bids.html (render/expiry ~1135-1199, compare grid
 * accessors + SECTIONS ~2093-2252, helpers ~2028-2116).
 */

import type { BidRow, CompareCell, ContractorProfile, BidsClaim } from './types';

// The static stack origin — cross-track links (contract-signing.html) still serve
// from otterquote.com until those pages migrate (coexistence; matches the shell's
// HOMEOWNER_GET_STARTED_URL / CONTRACTOR_DASHBOARD_URL convention).
export const STATIC_ORIGIN = 'https://otterquote.com';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// ── Parity copy (verbatim from bids.html) ────────────────────────────────────

/** Expired-bid "why do bids expire?" tooltip (bids.html:1171, verbatim). */
export const EXPIRY_TOOLTIP =
  "Contractors can't predict the future. Costs change and crews get busy. To avoid misunderstandings, bids on Otter Quotes expire after 14 days. If you want to move forward with this bid, the contractor will probably renew it at same or similar terms. We just don't want anyone to commit to promises they can't keep. Ask this contractor to renew this bid. If nothing has changed, you'll be able to accept it as soon as it is updated.";

/** All-bids-expired banner body (bids.html:415, verbatim). */
export const ALL_EXPIRED_BANNER =
  "All bids on this project have expired. Contractor bids are valid for 14 days. Request updated bids from the contractors listed below — they'll be notified right away.";

/** No-bids-yet empty state (bids.html:432-436, verbatim). */
export const EMPTY_STATE = {
  title: 'No Bids Yet',
  body: "Your project is live and contractors have been notified. Bids typically start coming in within a few hours. We'll notify you via text and email when each bid arrives.",
} as const;

/** Waiting indicator copy (bids.html:422, verbatim). */
export const WAITING_TEXT = 'Contractors are reviewing your project details...';

/** Comparison view minimum (bids.html:2193, verbatim). */
export const COMPARE_NEEDS_TWO =
  "Comparison requires at least 2 active bids. We'll switch this on automatically once your second bid arrives.";

// ── Pure helpers (bids.html:2028-2116) ───────────────────────────────────────

/** formatDate (bids.html:2028). */
export function formatBidDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/** parseJSON (bids.html:2055) — tolerant parse for stringified JSON columns. */
export function parseJSON(val: unknown): unknown {
  if (!val) return null;
  if (Array.isArray(val)) return val;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val as string);
  } catch {
    return null;
  }
}

/** parseCerts (bids.html:2049) — specialties → array. */
export function parseCerts(certs: unknown): string[] {
  if (!certs) return [];
  if (Array.isArray(certs)) return certs as string[];
  try {
    const parsed = JSON.parse(certs as string);
    return Array.isArray(parsed) ? parsed : String(certs).split(',').map((s) => s.trim());
  } catch {
    return String(certs).split(',').map((s) => s.trim());
  }
}

/** getScopeSummary (bids.html:1109) — pure (no per-bid caching mutation). */
export function getScopeSummary(bid: BidRow): Record<string, unknown> {
  const raw = bid.scope_summary;
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return (JSON.parse(raw as string) as Record<string, unknown>) || {};
  } catch {
    return {};
  }
}

/** _vaParse (bids.html:2089) — parse value_adds. */
export function vaParse(bid: BidRow): Record<string, unknown> {
  const v = typeof bid.value_adds === 'string' ? parseJSON(bid.value_adds) : bid.value_adds;
  return (v as Record<string, unknown>) || {};
}

/** formatWarranty (bids.html:2035) — manufacturer × tier snapshot w/ legacy fallback. */
export function formatWarranty(bid: BidRow): string {
  const parts: string[] = [];
  if (bid.warranty_snapshot) {
    const head = String(bid.warranty_snapshot).split(' — ')[0].trim();
    if (head) parts.push(head);
  }
  if (bid.workmanship_warranty_years) parts.push(`${bid.workmanship_warranty_years}yr workmanship`);
  if (parts.length === 0 && bid.manufacturer_warranty_years) {
    parts.push(`${bid.manufacturer_warranty_years}yr manufacturer`);
  }
  return parts.length > 0 ? parts.join(' + ') : bid.warranty_summary || 'TBD';
}

/** Signed-URL storage path extraction (bids.html:1087). */
export function extractOwnerPhotoPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const m = filePath.match(/contractor-documents\/(.+?)(\?|$)/);
  return m ? decodeURIComponent(m[1]) : filePath;
}

// ── D-150 bid expiration (bids.html:1137, 1157-1173) ─────────────────────────

export type BidExpiryState = 'active' | 'expiring' | 'expired';

export interface BidExpiry {
  state: BidExpiryState;
  /** Days until expiry for an active bid, else null. */
  daysUntilExpiry: number | null;
  /** Expiring-soon warning (≤3 days), else ''. Verbatim per bids.html:1163. */
  warning: string;
  /** Date label for an expired bid, else null. */
  expiredOn: string | null;
}

/**
 * Derive a bid's expiry state. `expired` keys on the row's `bid_status` column
 * (server-maintained); `expiring` is computed client-side from `expires_at`
 * (≤3 days, >0) — exactly as bids.html:1137/1158-1163. `now` is injectable so
 * the state machine is deterministically testable.
 */
export function deriveBidExpiry(bid: BidRow, now: Date = new Date()): BidExpiry {
  const isExpired = bid.bid_status === 'expired';

  if (isExpired) {
    return {
      state: 'expired',
      daysUntilExpiry: null,
      warning: '',
      expiredOn: bid.expires_at ? formatBidDate(bid.expires_at) : 'an earlier date',
    };
  }

  const daysUntilExpiry = bid.expires_at
    ? Math.ceil((new Date(bid.expires_at).getTime() - now.getTime()) / MS_PER_DAY)
    : null;
  const isExpiringSoon = daysUntilExpiry !== null && daysUntilExpiry <= 3 && daysUntilExpiry > 0;

  return {
    state: isExpiringSoon ? 'expiring' : 'active',
    daysUntilExpiry,
    warning: isExpiringSoon
      ? `⚠️ This bid expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}. Select this contractor now to lock in this price.`
      : '',
    expiredOn: null,
  };
}

// ── Active-bid / best-price selectors (bids.html:1121-1138, 2191) ────────────

/** Only non-expired bids compete and appear in the comparison grid. */
export function activeBids(bids: BidRow[]): BidRow[] {
  return bids.filter((b) => b.bid_status !== 'expired');
}

/** Every bid expired (drives the all-expired banner). bids.html:1128. */
export function isAllExpired(bids: BidRow[]): boolean {
  return bids.length > 0 && bids.every((b) => b.bid_status === 'expired');
}

/** Lowest active price, or null when fewer than 2 active bids compete. */
export function lowestActivePrice(bids: BidRow[]): number | null {
  const active = activeBids(bids);
  if (active.length < 2) return null;
  return Math.min(...active.map((b) => b.total_price || Infinity));
}

/** "Best Price" badge — non-expired, ties the lowest, with 2+ active bids. */
export function isLowestPrice(bid: BidRow, bids: BidRow[]): boolean {
  if (bid.bid_status === 'expired') return false;
  const lowest = lowestActivePrice(bids);
  return lowest !== null && bid.total_price === lowest;
}

/** The Cards↔Compare toggle shows only with 2+ active bids (bids.html:2258). */
export function showCompareToggle(bids: BidRow[]): boolean {
  return activeBids(bids).length >= 2;
}

// ── Action button state machine (bids.html:1184-1199) ────────────────────────

export type BidActionKind =
  | 'contract_signed'
  | 'awarded_selected'
  | 'not_selected'
  | 'renew'
  | 'select';

export interface BidAction {
  kind: BidActionKind;
  label: string;
  /** Cross-track link to the static contract-signing page (kinds with a href). */
  href?: string;
  disabled?: boolean;
}

function contractSigningHref(claimId: string, contractorId: string, quoteId: string): string {
  const qs = new URLSearchParams({
    claim_id: claimId,
    contractor_id: contractorId,
    quote_id: quoteId,
  });
  return `${STATIC_ORIGIN}/contract-signing.html?${qs.toString()}`;
}

/**
 * Resolve the per-bid action button. Mirrors bids.html:1184-1199 exactly:
 *   contract_signed         → "✓ Contract Signed" (→ contract-signing)
 *   awarded + this winner   → "View Contract Status →" (→ contract-signing)
 *   awarded + another bid   → "Not Selected" (disabled)
 *   expired                 → "Request Updated Bid" (renewal)
 *   otherwise               → "Select This Contractor"
 */
export function deriveBidAction(claim: BidsClaim | null | undefined, bid: BidRow): BidAction {
  const cs = claim?.status ?? null;
  const isExpired = bid.bid_status === 'expired';

  if (cs === 'contract_signed') {
    return {
      kind: 'contract_signed',
      label: '✓ Contract Signed',
      href: contractSigningHref(claim!.id, bid.contractor_id, bid.id),
    };
  }
  if (cs === 'awarded' && claim?.selected_contractor_id === bid.contractor_id) {
    return {
      kind: 'awarded_selected',
      label: 'View Contract Status →',
      href: contractSigningHref(claim.id, bid.contractor_id, bid.id),
    };
  }
  if (cs === 'awarded') {
    return { kind: 'not_selected', label: 'Not Selected', disabled: true };
  }
  if (isExpired) {
    return { kind: 'renew', label: 'Request Updated Bid' };
  }
  return { kind: 'select', label: 'Select This Contractor' };
}

/** Net-to-contractor transparency line (bids.html:1176-1181). 5% display cap (D-159). */
export function netToContractor(bid: BidRow): { net: number; feeLabel: string } | null {
  if (bid.total_price == null || bid.fee_amount == null) return null;
  const feeLabel = bid.fee_percentage ? `${Math.min(Number(bid.fee_percentage), 5)}%` : '5%';
  return { net: bid.total_price - bid.fee_amount, feeLabel };
}

// ── Comparison grid: 16 canonical rows across 5 sections (bids.html:2093-2224)
// Each accessor returns { display, key, cls }. `key` drives identical-row dimming.

const NA: CompareCell = { display: '—', key: 'na', cls: 'cell-na' };

function accTotal(bid: BidRow): CompareCell {
  const p = bid.total_price || 0;
  return { display: '$' + p.toLocaleString(), key: String(p), cls: 'cell-accent' };
}
function accStart(bid: BidRow): CompareCell {
  return bid.start_date ? { display: formatBidDate(bid.start_date), key: bid.start_date, cls: '' } : NA;
}
function accCompletion(bid: BidRow): CompareCell {
  const v = getScopeSummary(bid).completion_time as string | undefined;
  return v ? { display: v, key: v, cls: '' } : NA;
}
function accWorkmanship(bid: BidRow): CompareCell {
  const y = bid.workmanship_warranty_years;
  return y ? { display: `${y} ${y === 1 ? 'year' : 'years'}`, key: String(y), cls: '' } : NA;
}
function accMfrWarranty(bid: BidRow): CompareCell {
  if (bid.warranty_snapshot) {
    const f = String(bid.warranty_snapshot).split(' — ')[0] || String(bid.warranty_snapshot);
    return { display: f, key: f, cls: '' };
  }
  const va = vaParse(bid);
  const warranties = va.warranties as Array<{ label?: string } | string> | undefined;
  if (Array.isArray(warranties) && warranties[0]) {
    const first = warranties[0];
    const f = typeof first === 'object' ? first.label || JSON.stringify(first) : String(first);
    return { display: String(f), key: String(f), cls: '' };
  }
  return NA;
}
function accBrand(bid: BidRow): CompareCell {
  const v = getScopeSummary(bid).brand as string | undefined;
  return v ? { display: v, key: v, cls: '' } : NA;
}
function accUnderlayment(bid: BidRow): CompareCell {
  const u = vaParse(bid).underlayment as { type?: string; notes?: string } | undefined;
  if (!u || !u.type) return NA;
  const map: Record<string, string> = {
    synthetic: 'Synthetic',
    felt_15: 'Felt #15',
    felt_30: 'Felt #30',
    rubberized: 'Rubberized',
    other: u.notes || 'Other',
  };
  return { display: map[u.type] || u.type, key: u.type, cls: '' };
}
function accIceWater(bid: BidRow): CompareCell {
  const c = (vaParse(bid).ice_water_shield as { coverage?: string } | undefined)?.coverage;
  if (!c || c === 'not_applicable') return NA;
  const map: Record<string, string> = {
    standard: 'Standard (eaves & valleys)',
    enhanced: 'Enhanced (full deck)',
  };
  return { display: map[c] || c, key: c, cls: 'cell-included' };
}
function accDripEdge(bid: BidRow): CompareCell {
  const d = vaParse(bid).drip_edge as { option?: string; oop_price?: number } | undefined;
  if (!d || !d.option || d.option === 'na') return NA;
  if (d.option === 'oop') {
    const lbl = d.oop_price ? '+$' + Number(d.oop_price).toLocaleString() + ' OOP' : 'OOP (price on request)';
    return { display: lbl, key: 'oop', cls: 'cell-oop' };
  }
  const map: Record<string, string> = {
    included_black: '✓ Included (black)',
    included_white: '✓ Included (white)',
    included_custom: '✓ Included (custom)',
  };
  return { display: map[d.option] || '✓ Included', key: 'included', cls: 'cell-included' };
}
function accStarter(bid: BidRow): CompareCell {
  const s = vaParse(bid).starter_strip as string | undefined;
  if (!s) return NA;
  const map: Record<string, string> = {
    rakes_and_eaves: '✓ Rakes & eaves',
    eaves_only: '✓ Eaves only',
    rakes_only: '✓ Rakes only',
    not_included: '✗ Not included',
  };
  return { display: map[s] || s, key: s, cls: s === 'not_included' ? 'cell-excluded' : 'cell-included' };
}
function accChimney(bid: BidRow): CompareCell {
  const c = vaParse(bid).chimney as { type?: string; option?: string; oop_price?: number } | undefined;
  if (!c || !c.type || c.type === 'na') return { display: '— No chimney', key: 'na', cls: 'cell-na' };
  const typeLbl = c.type === 'flash' ? 'Flash' : c.type === 'reflash' ? 'Reflash' : 'Flash + reflash';
  if (c.option === 'included') return { display: `✓ ${typeLbl} included`, key: 'included-' + c.type, cls: 'cell-included' };
  if (c.option === 'reuse') return { display: '✓ Reuse existing', key: 'reuse', cls: 'cell-included' };
  if (c.option === 'oop') {
    const lbl = c.oop_price ? `${typeLbl}: +$${Number(c.oop_price).toLocaleString()} OOP` : `${typeLbl}: OOP`;
    return { display: lbl, key: 'oop-' + c.type, cls: 'cell-oop' };
  }
  return { display: typeLbl, key: c.type, cls: '' };
}
function accSkylights(bid: BidRow): CompareCell {
  const s = vaParse(bid).skylights as string | undefined;
  if (!s || s === 'na') return { display: '— No skylights', key: 'na', cls: 'cell-na' };
  const map: Record<string, string> = { reflash: '✓ Reflash included', replace: '✓ Replace included' };
  return { display: map[s] || s, key: s, cls: 'cell-included' };
}
function accVentilation(bid: BidRow): CompareCell {
  const v = vaParse(bid).ventilation as { ridge_vent_included?: boolean; ridge_vent_oop?: number } | undefined;
  if (!v) return NA;
  if (v.ridge_vent_included) return { display: '✓ Ridge vent included', key: 'included', cls: 'cell-included' };
  if (v.ridge_vent_oop) return { display: '+$' + Number(v.ridge_vent_oop).toLocaleString() + ' OOP', key: 'oop-' + v.ridge_vent_oop, cls: 'cell-oop' };
  return { display: '— Existing ventilation', key: 'na', cls: 'cell-na' };
}
function accGutters(bid: BidRow): CompareCell {
  const g = vaParse(bid).gutters as
    | { option?: string; additional_cost_5inch?: number; additional_cost_6inch?: number; other_text?: string }
    | undefined;
  if (!g || !g.option || g.option === 'none') return { display: '✗ Not offered', key: 'excluded', cls: 'cell-excluded' };
  if (g.option === '5inch_included') return { display: '✓ 5-inch included', key: 'incl-5', cls: 'cell-included' };
  if (g.option === '6inch_included') return { display: '✓ 6-inch included', key: 'incl-6', cls: 'cell-included' };
  if (g.option === '5inch_additional') {
    const p = g.additional_cost_5inch ? '+$' + Number(g.additional_cost_5inch).toLocaleString() : 'extra';
    return { display: '5-inch: ' + p, key: 'addl-5', cls: 'cell-oop' };
  }
  if (g.option === '6inch_additional') {
    const p = g.additional_cost_6inch ? '+$' + Number(g.additional_cost_6inch).toLocaleString() : 'extra';
    return { display: '6-inch: ' + p, key: 'addl-6', cls: 'cell-oop' };
  }
  if (g.option === 'other') return { display: g.other_text || 'Custom', key: 'custom', cls: '' };
  return NA;
}
function accGutterGuards(bid: BidRow): CompareCell {
  const g = vaParse(bid).gutter_guards as
    | { pricing_on_request?: boolean; mesh_oop?: number; screw_in_oop?: number }
    | undefined;
  if (!g) return NA;
  if (g.pricing_on_request) return { display: 'Available on request', key: 'request', cls: '' };
  const parts: string[] = [];
  if (g.mesh_oop) parts.push('Mesh: +$' + Number(g.mesh_oop).toLocaleString());
  if (g.screw_in_oop) parts.push('Screw-in: +$' + Number(g.screw_in_oop).toLocaleString());
  if (parts.length === 0) return { display: '✗ Not offered', key: 'excluded', cls: 'cell-excluded' };
  return { display: parts.join(' / '), key: 'oop', cls: 'cell-oop' };
}
function accDecking(bid: BidRow): CompareCell {
  const d = vaParse(bid).secondLayerContingency as
    | { pricePerSquare?: number; flatFeeAlternative?: number }
    | undefined;
  if (!d) return NA;
  if (d.pricePerSquare) return { display: '$' + Number(d.pricePerSquare).toLocaleString() + '/sq', key: 'sq-' + d.pricePerSquare, cls: '' };
  if (d.flatFeeAlternative) return { display: 'Flat: $' + Number(d.flatFeeAlternative).toLocaleString(), key: 'flat-' + d.flatFeeAlternative, cls: '' };
  return NA;
}

export interface CompareRowDef {
  label: string;
  acc: (bid: BidRow) => CompareCell;
}
export interface CompareSectionDef {
  name: string;
  rows: CompareRowDef[];
}

/** The 16 canonical comparison rows across 5 sections (bids.html:2197-2224). */
export const COMPARE_SECTIONS: CompareSectionDef[] = [
  {
    name: 'Headline',
    rows: [
      { label: 'Total price', acc: accTotal },
      { label: 'Start date', acc: accStart },
      { label: 'Completion time', acc: accCompletion },
      { label: 'Workmanship warranty', acc: accWorkmanship },
      { label: "Manufacturer's warranty", acc: accMfrWarranty },
    ],
  },
  {
    name: 'Materials',
    rows: [
      { label: 'Shingle brand', acc: accBrand },
      { label: 'Underlayment', acc: accUnderlayment },
      { label: 'Ice & water shield', acc: accIceWater },
      { label: 'Drip edge', acc: accDripEdge },
      { label: 'Starter strip', acc: accStarter },
    ],
  },
  {
    name: 'Roof Add-ons',
    rows: [
      { label: 'Chimney work', acc: accChimney },
      { label: 'Skylights', acc: accSkylights },
      { label: 'Ventilation', acc: accVentilation },
    ],
  },
  {
    name: 'Other Trades',
    rows: [
      { label: 'Gutters', acc: accGutters },
      { label: 'Gutter guards', acc: accGutterGuards },
    ],
  },
  {
    name: 'Contingencies',
    rows: [{ label: 'Decking ($/sheet)', acc: accDecking }],
  },
];

export interface CompareRowModel {
  label: string;
  cells: CompareCell[];
  /** All cells share a key → dim the row (bids.html:2241 identical-row dimming). */
  identical: boolean;
}
export interface CompareSectionModel {
  name: string;
  rows: CompareRowModel[];
}
export interface CompareModel {
  headers: { name: string; price: string; isLowest: boolean }[];
  sections: CompareSectionModel[];
}

/**
 * Build the comparison-grid model over the active bids (bids.html:2188-2252).
 * Returns headers (with best-price flag) and the 5 sections of resolved rows,
 * each flagged `identical` when every cell shares a `key` (drives dimming).
 */
export function buildCompareModel(
  bids: BidRow[],
  contractors: Record<string, ContractorProfile>,
): CompareModel {
  const active = activeBids(bids);
  const lowest = active.length > 1 ? Math.min(...active.map((b) => b.total_price || Infinity)) : Infinity;

  const headers = active.map((bid) => {
    const c = contractors[bid.contractor_id] || ({} as ContractorProfile);
    return {
      name: c.company_name || 'Contractor',
      price: '$' + (bid.total_price || 0).toLocaleString(),
      isLowest: active.length > 1 && bid.total_price === lowest,
    };
  });

  const sections = COMPARE_SECTIONS.map((section) => ({
    name: section.name,
    rows: section.rows.map((row) => {
      const cells = active.map((bid) => row.acc(bid));
      const identical = cells.every((c) => c.key === cells[0].key);
      return { label: row.label, cells, identical };
    }),
  }));

  return { headers, sections };
}
