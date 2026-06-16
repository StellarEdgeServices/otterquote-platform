/**
 * Contractor dashboard pure helpers — D-211 Phase 2.
 *
 * Extracted so the parity test can exercise the ported logic without importing
 * page.tsx (which pulls in the Supabase client). All functions are pure; the page
 * is the only place that touches the network. Ported from contractor-dashboard.html.
 */

// ── Cross-stack deep-link targets (static stack until each page migrates) ──
export const SETTINGS_URL = 'https://otterquote.com/contractor-settings.html';
export const SETTINGS_PAYMENT_URL = 'https://otterquote.com/contractor-settings.html#payment';
export const PROFILE_URL = 'https://otterquote.com/contractor-profile.html';
export const AGREEMENT_URL = 'https://otterquote.com/contractor-agreement.html';
export const DASHBOARD_ROUTE = '/contractor/dashboard';

/** Supabase Edge Function base — derived from the public (client-safe) env var. */
export function efBase(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
}
export function efUrl(name: string): string {
  return `${efBase()}/functions/v1/${name}`;
}

/** Relative time for the activity feed (contractor-dashboard.html:1006). */
export function formatActivityTime(isoString: string, nowMs: number = Date.now()): string {
  const date = new Date(isoString);
  const diffMs = nowMs - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Activity dot color by event type (contractor-dashboard.html:1022). */
export function activityDotColor(type: string): string {
  switch (type) {
    case 'bid_accepted': return '#15803D';
    case 'bid_submitted': return '#0284C7';
    case 'bid_rejected': return '#991B1B';
    case 'opportunity_matched': return 'var(--amber)';
    default: return '#6B7280';
  }
}

/**
 * Location string with the D-074 privacy control: full address once a bid is
 * awarded/selected/completed; city + state + zip only while a bid is pending.
 * Ported from contractor-dashboard.html:1338.
 */
export function buildLocation(address: string | null | undefined, status: string): string {
  const addr = address || '';
  if (status === 'awarded' || status === 'completed' || status === 'selected') {
    return addr || 'Unknown';
  }
  const parts = addr.split(',');
  const city = parts.length >= 2 ? parts[1].trim() : (parts[0]?.trim() || 'Unknown');
  const zipMatch = addr.match(/\d{5}/);
  const zip = zipMatch ? zipMatch[0] : '';
  return zip ? `${city}, IN ${zip}` : city || 'Unknown';
}

export interface ClaimLike {
  material_category?: string | null;
  shingle_type?: string | null;
}

/** Material label from the claim columns (contractor-dashboard.html:1351). */
export function buildMaterial(claim: ClaimLike | null | undefined): string {
  if (!claim) return 'Not specified';
  const cat = claim.material_category;
  const type = claim.shingle_type;
  if (cat === 'shingles' && type) return type.charAt(0).toUpperCase() + type.slice(1) + ' Shingles';
  if (cat) return cat.charAt(0).toUpperCase() + cat.slice(1);
  return 'Not specified';
}

/** Monthly-earnings formatter — explicit 2dp (Bug 7 fix, dashboard.html:1321). */
export function formatEarnings(total: number): string {
  return '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatMoney(value: number | string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return '$' + n.toLocaleString();
}

export function titleCase(s: string | null | undefined, fallback = 'Unknown'): string {
  if (!s) return fallback;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const PROJECT_STATUS_LABEL: Record<string, string> = {
  selected: 'Won',
  awarded: 'Won',
  completed: 'Completed',
};

// ── Profile-completion checklist (the 7 checks, identical in
//    showGettingStartedChecklist + calculateProfileCompletion). ──
export interface ChecklistContractor {
  company_name?: string | null;
  has_workers_comp?: boolean | null;
  has_general_liability?: boolean | null;
  service_counties?: unknown[] | null;
  contract_templates?: Record<string, unknown> | null;
  stripe_payment_method_id?: string | null;
  preferred_brands?: unknown[] | null;
  agreement_accepted_at?: string | null;
}

export type ChecklistKey =
  | 'business' | 'insurance' | 'serviceArea' | 'contractTemplate'
  | 'paymentMethod' | 'preferredBrand' | 'agreement';

export interface ChecklistItem {
  key: ChecklistKey;
  done: boolean;
  link: string;
}

export function profileChecklist(c: ChecklistContractor): ChecklistItem[] {
  return [
    { key: 'business', done: !!(c.company_name && c.company_name.trim()), link: PROFILE_URL },
    { key: 'insurance', done: !!(c.has_workers_comp || c.has_general_liability), link: PROFILE_URL },
    { key: 'serviceArea', done: Array.isArray(c.service_counties) && c.service_counties.length > 0, link: PROFILE_URL },
    { key: 'contractTemplate', done: !!(c.contract_templates && Object.keys(c.contract_templates).length > 0), link: SETTINGS_URL },
    { key: 'paymentMethod', done: !!c.stripe_payment_method_id, link: SETTINGS_PAYMENT_URL },
    { key: 'preferredBrand', done: Array.isArray(c.preferred_brands) && c.preferred_brands.length > 0, link: SETTINGS_URL },
    { key: 'agreement', done: !!c.agreement_accepted_at, link: DASHBOARD_ROUTE },
  ];
}

export function calculateProfileCompletion(c: ChecklistContractor): { completedCount: number; totalSteps: number } {
  const items = profileChecklist(c);
  return { completedCount: items.filter((i) => i.done).length, totalSteps: items.length };
}

// ── Opportunity count (matches contractor-opportunities.html logic exactly:
//    trade filter → exclude claims at max 6 bids (D-030) → exclude already-bid). ──
export interface OppClaim {
  id: string;
  selected_trades?: string[] | string | null;
  trades?: string[] | string | null;
}

export function filterOpportunities(
  claims: OppClaim[],
  contractorTrades: string[],
  bidCountByClaim: Record<string, number>,
  myBidClaimIds: Set<string>,
): OppClaim[] {
  let out = claims.slice();
  if (contractorTrades.length > 0) {
    const lc = contractorTrades.map((t) => t.toLowerCase());
    out = out.filter((claim) => {
      const raw = claim.selected_trades ?? claim.trades ?? ['roofing'];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.some((t) => lc.includes(String(t).toLowerCase()));
    });
  }
  out = out.filter((c) => (bidCountByClaim[c.id] || 0) < 6);
  out = out.filter((c) => !myBidClaimIds.has(c.id));
  return out;
}

/** Display the contractor's service-area county list (handles "IN:Hamilton"). */
export function serviceAreaDisplay(counties: unknown): string[] {
  if (!Array.isArray(counties)) return [];
  return counties.map((c) => {
    const s = String(c);
    return s.includes(':') ? s.split(':')[1] : s;
  });
}
