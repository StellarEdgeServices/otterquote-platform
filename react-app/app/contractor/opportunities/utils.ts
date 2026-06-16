/**
 * Contractor Opportunities — pure helpers (D-211 Phase 3, port of
 * contractor-opportunities.html). Extracted so the parity test can exercise the
 * ported logic without importing page.tsx (which pulls in the Supabase client).
 * All functions are pure; the page is the only place that touches the network.
 *
 * Ported verbatim (behavior-for-behavior) from contractor-opportunities.html:
 *   - OPEN_STATES / STATE_NAMES (D-178)            : :294-299
 *   - ZIP_CENTROIDS + haversine ZIP distance       : :307-460
 *   - claim -> opportunity mapping                  : :523-573
 *   - D-165 trade + release filter                  : :582-594
 *   - D-030 max-6-bids cap                          : :597-611
 *   - D-150 exclude-own-active-bids / expired flag  : :616-643
 *   - badges / value display / fees / expiry        : :730-819
 *   - client-side filters + sort                    : :1081-1135
 */

// ── D-178: states where the contractor marketplace is live ──────────────────
export const OPEN_STATES = ['IN'];

export const STATE_NAMES: Record<string, string> = {
  IN: 'Indiana', OH: 'Ohio', IL: 'Illinois', KY: 'Kentucky',
  MI: 'Michigan', MO: 'Missouri', TN: 'Tennessee', WI: 'Wisconsin',
};

export const KNOWN_TRADES = ['roofing', 'gutters', 'siding', 'windows'];

// =============================================================================
// ZIP CODE DISTANCE (Option C — zip centroids). Sources: US Census ZCTA5
// centroids (approximate, sufficient for opportunity display). Ported verbatim
// from contractor-opportunities.html:309-430.
// =============================================================================
export const ZIP_CENTROIDS: Record<string, [number, number]> = {
  // ── Indianapolis / Marion County ──
  '46201': [39.7728, -86.1035], '46202': [39.7856, -86.1609],
  '46203': [39.7528, -86.1035], '46204': [39.7756, -86.1559],
  '46205': [39.8228, -86.1135], '46208': [39.8128, -86.1609],
  '46214': [39.7728, -86.2631], '46216': [39.8528, -85.9981],
  '46217': [39.6828, -86.1509], '46218': [39.8128, -86.0831],
  '46219': [39.7728, -86.0481], '46220': [39.8628, -86.0881],
  '46221': [39.7128, -86.1809], '46222': [39.7728, -86.2131],
  '46224': [39.7728, -86.2631], '46225': [39.7328, -86.1609],
  '46226': [39.8328, -86.0481], '46227': [39.6828, -86.1135],
  '46228': [39.8328, -86.2131], '46229': [39.7728, -85.9981],
  '46231': [39.7128, -86.3081], '46234': [39.8128, -86.3081],
  '46235': [39.8128, -85.9981], '46236': [39.8528, -86.0481],
  '46237': [39.6828, -86.0481], '46239': [39.7128, -85.9981],
  '46240': [39.9034, -86.1063], '46241': [39.7428, -86.2631],
  '46250': [39.9134, -86.0281], '46254': [39.8528, -86.2631],
  '46256': [39.9034, -86.0481], '46259': [39.6428, -86.0481],
  '46260': [39.9034, -86.1509], '46268': [39.9034, -86.2131],
  '46278': [39.8934, -86.3081], '46280': [39.9534, -86.1135],
  // ── Hamilton County (Carmel / Fishers / Noblesville / Westfield) ──
  '46030': [40.0467, -86.1331], '46031': [40.0867, -86.1431],
  '46032': [39.9784, -86.1180], '46033': [39.9184, -86.0519],
  '46034': [40.1127, -86.0219], '46036': [40.0867, -85.9113],
  '46037': [39.9567, -85.9674], '46038': [39.9467, -86.0019],
  '46040': [39.9567, -85.8680], '46060': [40.0456, -85.9913],
  '46062': [40.1127, -85.9913], '46074': [40.0434, -86.1430],
  '46082': [40.0867, -86.0719],
  // ── Zionsville / Boone County ──
  '46052': [40.0497, -86.4548], '46075': [40.0347, -86.3984],
  '46077': [39.9578, -86.2619],
  // ── Hendricks County (Avon, Brownsburg, Plainfield) ──
  '46112': [39.8440, -86.3984], '46118': [39.7540, -86.4884],
  '46122': [39.6951, -86.5048], '46123': [39.7626, -86.3984],
  '46149': [39.8345, -86.4548], '46158': [39.5761, -86.4048],
  '46168': [39.7026, -86.4048],
  // ── Johnson County (Greenwood, Bargersville, Franklin) ──
  '46107': [39.7066, -86.0463], '46130': [39.6276, -85.8680],
  '46131': [39.5361, -86.1086], '46142': [39.6151, -86.1086],
  '46143': [39.5761, -86.1086], '46163': [39.7466, -85.9108],
  '46181': [39.5141, -85.9681], '46184': [39.5541, -86.0463],
  // ── Morgan County (Martinsville, Mooresville) ──
  '46151': [39.4282, -86.4281], '46160': [39.3582, -86.3681],
  '46166': [39.4882, -86.5181],
  // ── Shelby County ──
  '46176': [39.5241, -85.7780],
  // ── Hancock County (Greenfield) ──
  '46140': [39.7866, -85.7680], '46148': [39.7066, -85.6580],
  // ── Madison County (Anderson) ──
  '46011': [40.1034, -85.6830], '46012': [40.1234, -85.6530],
  '46013': [40.0634, -85.6830], '46016': [40.1034, -85.6530],
  '46017': [40.0834, -85.6330],
  // ── Delaware County (Muncie) ──
  '47302': [40.1934, -85.3863], '47303': [40.2134, -85.3463],
  '47304': [40.2234, -85.3863], '47305': [40.1734, -85.3863],
  '47306': [40.1934, -85.3863],
  // ── Howard County (Kokomo) ──
  '46901': [40.4864, -86.1330], '46902': [40.4664, -86.1530],
  '46903': [40.4864, -86.1330], '46904': [40.4864, -86.1330],
  // ── Grant County (Marion, IN) ──
  '46952': [40.5584, -85.6597], '46953': [40.5384, -85.6397],
  // ── Tippecanoe County (Lafayette / West Lafayette) ──
  '47901': [40.4167, -86.8753], '47902': [40.4167, -86.8753],
  '47903': [40.4367, -86.8353], '47904': [40.4367, -86.8553],
  '47905': [40.4167, -86.8153], '47906': [40.4567, -86.9053],
  '47907': [40.4267, -86.9153], '47909': [40.3867, -86.8753],
  // ── Monroe County (Bloomington) ──
  '47401': [39.1653, -86.5264], '47402': [39.1653, -86.5264],
  '47403': [39.1353, -86.5264], '47404': [39.1953, -86.5464],
  '47405': [39.1653, -86.5264], '47406': [39.1653, -86.5264],
  '47408': [39.1953, -86.5064],
  // ── Bartholomew County (Columbus) ──
  '47201': [39.2014, -85.9214], '47202': [39.2014, -85.9214],
  '47203': [39.2114, -85.8814],
  // ── Vigo County (Terre Haute) ──
  '47801': [39.4664, -87.4136], '47802': [39.4664, -87.4136],
  '47803': [39.4664, -87.3736], '47804': [39.4864, -87.4136],
  '47805': [39.5064, -87.3936],
  // ── Allen County (Fort Wayne) ──
  '46801': [41.0784, -85.1440], '46802': [41.0984, -85.1440],
  '46803': [41.0684, -85.0873], '46804': [41.0684, -85.2440],
  '46805': [41.1284, -85.0873], '46806': [41.0384, -85.0873],
  '46807': [41.0084, -85.1440], '46808': [41.0784, -85.1440],
  '46809': [40.9884, -85.1440], '46814': [41.0534, -85.2940],
  '46815': [41.1334, -85.0440], '46816': [41.0484, -85.0440],
  '46818': [41.1334, -85.1940], '46819': [40.9934, -85.0873],
  '46825': [41.1634, -85.1440], '46835': [41.1634, -85.0440],
  // ── St. Joseph County (South Bend / Mishawaka) ──
  '46601': [41.6764, -86.2519], '46613': [41.6564, -86.2519],
  '46614': [41.6264, -86.2519], '46615': [41.6764, -86.2019],
  '46616': [41.7064, -86.2519], '46617': [41.6764, -86.2019],
  '46619': [41.6764, -86.3019], '46628': [41.7464, -86.3019],
  '46635': [41.7564, -86.2019], '46637': [41.7064, -86.2019],
  // ── Vanderburgh County (Evansville) ──
  '47708': [37.9748, -87.5558], '47710': [37.9948, -87.5958],
  '47711': [37.9948, -87.5458], '47712': [37.9548, -87.5958],
  '47713': [37.9548, -87.5458], '47714': [37.9648, -87.5058],
  '47715': [37.9748, -87.4658], '47720': [38.0148, -87.5558],
  '47725': [38.0248, -87.5558],
  // ── Lake County (Gary / Hammond / Merrillville) ──
  '46320': [41.5634, -87.3619], '46321': [41.5534, -87.4219],
  '46322': [41.5534, -87.5019], '46323': [41.5334, -87.4819],
  '46324': [41.5734, -87.4819], '46373': [41.4334, -87.2219],
  '46375': [41.4534, -87.3619], '46394': [41.5334, -87.2619],
  '46401': [41.5834, -87.3319], '46402': [41.5634, -87.3219],
  '46403': [41.5734, -87.2819], '46404': [41.5534, -87.3619],
  '46405': [41.5434, -87.3219], '46406': [41.5634, -87.4019],
  '46407': [41.5734, -87.3519], '46408': [41.5434, -87.3819],
  '46409': [41.5234, -87.3419],
  // ── Marion County (Indianapolis far outskirts) ──
  '46113': [39.6851, -86.3281],
  // ── Surrounding states (common cross-border claims) ──
  '45215': [39.2247, -84.4453], '45242': [39.2547, -84.3553],
  '45011': [39.3547, -84.5153], '45402': [39.7547, -84.1953],
  '60406': [41.6447, -87.6553], '60607': [41.8747, -87.6553],
  '49022': [42.1147, -86.4553], '49085': [42.1147, -86.4553],
  '41071': [39.0847, -84.4953], '41011': [39.0747, -84.5153],
};

/** Look up [lat, lng] for a zip, or null if not in table. (:432-436) */
export function getZipLatLng(zip: string | null | undefined): [number, number] | null {
  if (!zip) return null;
  return ZIP_CENTROIDS[String(zip).trim().slice(0, 5)] || null;
}

/** Haversine — distance in miles between two lat/lng points. (:438-448) */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Distance in miles between two zips via centroid lookup. Returns null if either
 * zip is unknown (caller treats as "distance unknown", not 0). (:455-460)
 */
export function computeZipDistance(
  contractorZip: string | null | undefined,
  claimZip: string | null | undefined,
): number | null {
  const c1 = getZipLatLng(contractorZip);
  const c2 = getZipLatLng(claimZip);
  if (!c1 || !c2) return null;
  return Math.round(haversineMiles(c1[0], c1[1], c2[0], c2[1]));
}

// ── claim -> opportunity mapping ────────────────────────────────────────────

/** Loose shape of a `claims` row (only the columns the page reads). */
export interface RawClaim {
  id: string;
  property_address?: string | null;
  address_city?: string | null;
  address_zip?: string | null;
  address_state?: string | null;
  selected_trades?: string[] | string | null;
  trades?: string[] | string | null;
  job_type?: string | null;
  damage_type?: string | null;
  damage_description?: string | null;
  insurance_carrier?: string | null;
  material_product?: string | null;
  rcv_amount?: number | null;
  acv_amount?: number | null;
  deductible_amount?: number | null;
  roof_squares?: number | null;
  repair_squares?: number | null;
  existing_shingle_brand?: string | null;
  existing_shingle_color?: string | null;
  estimate_filename?: string | null;
  has_estimate?: boolean | null;
  measurements_filename?: string | null;
  has_measurements?: boolean | null;
  created_at?: string | null;
  urgency?: string | null;
  urgency_deadline?: string | null;
  urgency_reason?: string | null;
  homeowner_notes?: string | null;
  contractor_scope_summary?: string | null;
  funding_type?: string | null;
  roofing_bid_released_at?: string | null;
  gutters_bid_released_at?: string | null;
  siding_bid_released_at?: string | null;
  windows_bid_released_at?: string | null;
  bid_window_expires_at?: string | null;
  [key: string]: unknown;
}

export interface ReleasedTrades {
  roofing: boolean;
  gutters: boolean;
  siding: boolean;
  windows: boolean;
}

export interface Opportunity {
  id: string;
  propertyAddress: string | null;
  location: string;
  zip: string;
  state: string;
  jobType: string;
  trades: string[];
  damageType: string;
  damageDetail: string;
  insuranceCarrier: string;
  material: string | null;
  estimatedValue: number | null;
  acvPayout: number | null;
  deductible: number | null;
  roofSquares: number | null;
  repairSquares: number | null;
  totalSquares: number | null;
  existingShingle: string | null;
  estimateAvailable: boolean;
  measurementsAvailable: boolean;
  claimFiledDate: string | null;
  distance: number | null;
  urgency: string;
  urgencyDeadline: string | null;
  urgencyReason: string | null;
  homeownerNotes: string | null;
  contractorScopeSummary: string | null;
  fundingType: string;
  releasedTrades: ReleasedTrades;
  bidWindowExpiresAt: string | null;
  estimateFilename: string | null;
  hasExpiredBid?: boolean;
  expiredQuoteId?: string;
}

/** Map a raw `claims` row to an Opportunity. Ported from :523-573. */
export function mapClaimToOpportunity(
  claim: RawClaim,
  contractorZip: string | null | undefined,
): Opportunity {
  const addressParts = (claim.property_address || '').split(',');
  const city =
    claim.address_city || addressParts[1]?.trim() || addressParts[0]?.trim() || 'Unknown';
  const zip =
    claim.address_zip || claim.property_address?.match(/\d{5}/)?.[0] || '';

  const rawTrades = claim.selected_trades || claim.trades || ['roofing'];
  const trades = Array.isArray(rawTrades) ? rawTrades : [rawTrades];

  const releasedTrades: ReleasedTrades = {
    roofing: !!claim.roofing_bid_released_at,
    gutters: !!claim.gutters_bid_released_at,
    siding: !!claim.siding_bid_released_at,
    windows: !!claim.windows_bid_released_at,
  };

  return {
    id: claim.id,
    propertyAddress: claim.property_address || null,
    location: city,
    zip,
    state: claim.address_state || 'IN',
    jobType: claim.job_type || 'insurance_rcv',
    trades,
    damageType: claim.damage_type || 'Unknown',
    damageDetail: claim.damage_description || '',
    insuranceCarrier: claim.insurance_carrier || 'Unknown',
    material: claim.material_product || null,
    estimatedValue: claim.rcv_amount ?? null,
    acvPayout: claim.acv_amount ?? null,
    deductible: claim.deductible_amount ?? null,
    roofSquares: claim.roof_squares ?? null,
    repairSquares: claim.repair_squares ?? null,
    totalSquares: null,
    existingShingle: claim.existing_shingle_brand
      ? `${claim.existing_shingle_brand} - ${claim.existing_shingle_color}`
      : null,
    estimateAvailable: !!(claim.estimate_filename || claim.has_estimate),
    measurementsAvailable: !!(claim.measurements_filename || claim.has_measurements),
    claimFiledDate: claim.created_at ?? null,
    distance: computeZipDistance(contractorZip, zip),
    urgency: claim.urgency || 'flexible',
    urgencyDeadline: claim.urgency_deadline ?? null,
    urgencyReason: claim.urgency_reason ?? null,
    homeownerNotes: (claim.homeowner_notes as string) ?? null,
    contractorScopeSummary: claim.contractor_scope_summary || null,
    fundingType:
      claim.funding_type || (claim.job_type?.startsWith('insurance') ? 'insurance' : 'cash'),
    releasedTrades,
    bidWindowExpiresAt: claim.bid_window_expires_at || null,
    estimateFilename: claim.estimate_filename || null,
  };
}

/**
 * D-165: keep an opportunity only if at least one of the contractor's service
 * trades matches a RELEASED trade on the claim. Unknown trades (outside the known
 * set) default to "released" (conservative include). Only applied when the
 * contractor has trades configured. Ported from :582-594.
 */
export function filterByTradeRelease(
  opps: Opportunity[],
  contractorTrades: string[] | null | undefined,
): Opportunity[] {
  if (!contractorTrades || contractorTrades.length === 0) return opps;
  const lc = contractorTrades.map((t) => t.toLowerCase());
  return opps.filter((opp) =>
    opp.trades.some((t) => {
      const tl = String(t).toLowerCase();
      if (!lc.includes(tl)) return false; // not contractor's trade
      if (!KNOWN_TRADES.includes(tl)) return true; // unknown trade = conservative include
      return !!opp.releasedTrades[tl as keyof ReleasedTrades];
    }),
  );
}

/** D-030: exclude opportunities already at the 6-bid cap. Ported from :597-611. */
export function excludeCappedClaims(
  opps: Opportunity[],
  bidCountByClaim: Record<string, number>,
): Opportunity[] {
  return opps.filter((o) => (bidCountByClaim[o.id] || 0) < 6);
}

export interface MyBid {
  quoteId: string;
  bidStatus: string;
}

/**
 * D-150: exclude opportunities the contractor has an ACTIVE bid on; keep ones
 * where the prior bid is `expired` and flag them for the rebid indicator.
 * Ported from :616-643. Returns new objects (no mutation).
 */
export function applyMyBids(
  opps: Opportunity[],
  myBidMap: Record<string, MyBid>,
): Opportunity[] {
  return opps
    .filter((o) => {
      const bid = myBidMap[o.id];
      if (!bid) return true; // no bid — show
      if (bid.bidStatus === 'expired') return true; // expired — keep, flag below
      return false; // active bid — exclude
    })
    .map((o) => {
      const bid = myBidMap[o.id];
      if (bid && bid.bidStatus === 'expired') {
        return { ...o, hasExpiredBid: true, expiredQuoteId: bid.quoteId };
      }
      return o;
    });
}

// ── display helpers (return data, the page renders JSX) ─────────────────────

export const JOB_TYPE_BADGE_LABELS: Record<string, string> = {
  insurance_rcv: 'Insurance (RCV)',
  insurance_acv: 'Insurance (ACV)',
  retail: 'Retail',
  repair: 'Repair',
};

export const JOB_TYPE_DETAIL_LABELS: Record<string, string> = {
  insurance_rcv: 'Insurance (RCV)',
  insurance_acv: 'Insurance (ACV)',
  retail: 'Retail / Cash',
  repair: 'Repair Only',
};

export const URGENCY_DETAIL_LABELS: Record<string, string> = {
  flexible: 'Flexible',
  '30_days': 'Within 30 Days',
  '2_weeks': 'Within 2 Weeks',
  asap: 'As Soon As Possible',
};

export const TRADE_ICONS: Record<string, string> = {
  roofing: '🏠', siding: '🧱', gutters: '🌧️', windows: '🪟',
};
export const TRADE_LABELS: Record<string, string> = {
  roofing: 'Roofing', siding: 'Siding', gutters: 'Gutters', windows: 'Windows',
};

/** Currency formatter — whole dollars (:806). */
export function fmtCurrency(v: number): string {
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  });
}

export interface ValueDisplay {
  label: string;
  value: string;
}

/** Headline value block per job type (:794-798). */
export function valueDisplay(opp: Opportunity): ValueDisplay {
  if (opp.jobType === 'retail') {
    return {
      label: 'Roof Size',
      value: opp.roofSquares ? `${opp.roofSquares} squares` : 'Pending measurement',
    };
  }
  if (opp.jobType === 'repair') {
    return {
      label: 'Repair Scope',
      value:
        opp.repairSquares && opp.totalSquares
          ? `${opp.repairSquares} sq of ${opp.totalSquares} sq total`
          : 'See estimate',
    };
  }
  return {
    label: 'Est. Value',
    value: opp.estimatedValue ? fmtCurrency(opp.estimatedValue) : 'See estimate',
  };
}

export interface FeeBreakdown {
  baseFee: string;
  total: string;
}

/** Estimated platform fee (5%); roof-square fallback @ $700/sq (:800-804). */
export function calcFees(opp: Opportunity): FeeBreakdown | null {
  const base = opp.estimatedValue || (opp.roofSquares ? opp.roofSquares * 700 : null);
  if (!base) return null;
  return { baseFee: fmtCurrency(base * 0.05), total: fmtCurrency(base * 0.05) };
}

export type ExpiryTone = 'red' | 'amber' | 'neutral';
export interface ExpiryCountdown {
  tone: ExpiryTone;
  text: string;
}

/** D-150 bid-window countdown badge (:809-819). Null when no expiry set. */
export function expiryCountdown(
  opp: Pick<Opportunity, 'bidWindowExpiresAt'>,
  nowMs: number = Date.now(),
): ExpiryCountdown | null {
  if (!opp.bidWindowExpiresAt) return null;
  const diffMs = new Date(opp.bidWindowExpiresAt).getTime() - nowMs;
  if (diffMs <= 0) return { tone: 'red', text: '⏰ Bid window closed' };
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 1) return { tone: 'red', text: '⏰ Closes today' };
  if (diffDays <= 3) return { tone: 'amber', text: `⏰ Closes in ${diffDays} days` };
  return { tone: 'neutral', text: `⏰ Closes in ${diffDays} days` };
}

/** Trade list as Title-Cased, comma-joined string (detail modal, :1037-1038). */
export function tradeDisplay(trades: string[] | string): string {
  const arr = Array.isArray(trades) ? trades : [trades];
  return arr.map((t) => String(t).charAt(0).toUpperCase() + String(t).slice(1)).join(', ');
}

export interface TradeReleaseBadge {
  label: string;
  released: boolean;
}

/**
 * D-165 per-trade release badges. Only shown when there is something meaningful
 * to communicate: a multi-trade claim, or any trade whose bid is still held
 * pending the homeowner's design. Unknown trades are treated as released.
 * Ported from contractor-opportunities.html:753-781.
 */
export function tradeReleaseBadges(opp: Opportunity): TradeReleaseBadge[] {
  if (!opp.trades || opp.trades.length === 0) return [];
  const released = opp.releasedTrades || ({} as ReleasedTrades);
  const hasAnyUnreleased = opp.trades.some((t) => {
    const tl = String(t).toLowerCase();
    return KNOWN_TRADES.includes(tl) && !released[tl as keyof ReleasedTrades];
  });
  if (!hasAnyUnreleased && opp.trades.length < 2) return [];
  return opp.trades.map((t) => {
    const tl = String(t).toLowerCase();
    const isReleased = !KNOWN_TRADES.includes(tl) ? true : !!released[tl as keyof ReleasedTrades];
    return { label: TRADE_LABELS[tl] || String(t), released: isReleased };
  });
}

// ── client-side filters + sort (:1081-1135) ─────────────────────────────────

export interface OppFilters {
  jobType?: string;
  trade?: string;
  material?: string;
  distance?: string;
  sort?: string;
}

const MATERIAL_KEYWORDS: Record<string, string[]> = {
  architectural: ['architectural'],
  designer: ['designer'],
  'metal-seam': ['standing seam', 'metal seam'],
  'metal-fastener': ['exposed fastener', 'metal fastener'],
};

/** Apply the job-type / trade / material / distance filters + sort (:1081-1135). */
export function applyOppFilters(opps: Opportunity[], filters: OppFilters): Opportunity[] {
  const { jobType, trade, material, distance, sort = 'newest' } = filters;
  let filtered = opps.slice();

  if (jobType) {
    filtered = filtered.filter((o) => o.jobType === jobType);
  }

  if (trade) {
    if (trade === 'multi') {
      filtered = filtered.filter((o) => Array.isArray(o.trades) && o.trades.length > 1);
    } else {
      filtered = filtered.filter((o) => {
        const trades = Array.isArray(o.trades) ? o.trades : [o.trades];
        return trades.includes(trade);
      });
    }
  }

  if (material) {
    const keywords = MATERIAL_KEYWORDS[material] || [material];
    filtered = filtered.filter((o) => {
      if (!o.material) return false;
      const mat = o.material.toLowerCase();
      return keywords.some((k) => mat.includes(k));
    });
  }

  if (distance) {
    const maxMi = Number(distance);
    filtered = filtered.filter((o) =>
      typeof o.distance === 'number' ? o.distance <= maxMi : true,
    );
  }

  if (sort === 'value-high') {
    filtered.sort((a, b) => (b.estimatedValue || 0) - (a.estimatedValue || 0));
  } else if (sort === 'closest') {
    filtered.sort((a, b) => (a.distance || 999) - (b.distance || 999));
  } else if (sort === 'urgent-first') {
    filtered.sort((a, b) => {
      const aU = a.urgency === 'asap' ? 0 : 1;
      const bU = b.urgency === 'asap' ? 0 : 1;
      return aU - bU;
    });
  }

  return filtered;
}

/** Results-count label (:1140). */
export function resultsCountLabel(n: number): string {
  return n === 1 ? '1 opportunity available' : `${n} opportunities available`;
}

// ── D-178 state gate (parked-state) ─────────────────────────────────────────

export interface StateGate {
  parked: boolean;
  stateCode: string;
  stateName: string;
}

/**
 * Parked-state gate: a contractor whose registered state is not in OPEN_STATES
 * sees the "launching soon" parked UI instead of opportunities. A missing state
 * is NOT parked (matches static :497-501). Pure — the page renders the result.
 */
export function resolveStateGate(
  contractor: { address_state?: string | null } | null | undefined,
): StateGate {
  const stateCode = (contractor?.address_state || '').toUpperCase();
  const parked = !!stateCode && !OPEN_STATES.includes(stateCode);
  return { parked, stateCode, stateName: STATE_NAMES[stateCode] || stateCode };
}

/** Supabase Edge Function base — from the public (client-safe) env var. */
export function efBase(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
}
