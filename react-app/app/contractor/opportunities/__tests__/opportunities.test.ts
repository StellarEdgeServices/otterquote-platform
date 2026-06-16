/**
 * Parity + unit tests for the contractor Opportunities page (D-211 Phase 3).
 * Exercises the ported pure logic against the behavior of
 * contractor-opportunities.html @ main: ZIP-distance (haversine), claim→opp
 * mapping, the D-165 trade/release filter, the D-030 6-bid cap, D-150
 * exclude-own-active-bids, client-side filters/sort, display helpers, and the
 * D-178 state gate. Network + the get-hover-pdf EF live in the page, not here.
 */

import { describe, it, expect } from 'vitest';
import {
  OPEN_STATES, computeZipDistance, getZipLatLng, haversineMiles,
  mapClaimToOpportunity, filterByTradeRelease, excludeCappedClaims, applyMyBids,
  applyOppFilters, valueDisplay, calcFees, expiryCountdown, tradeReleaseBadges,
  tradeDisplay, resolveStateGate, resultsCountLabel, fmtCurrency,
  type RawClaim, type Opportunity,
} from '../utils';
import {
  JOB_TYPE_OPTIONS, TRADE_OPTIONS, SORT_OPTIONS, submitBidHref, renewBidHref, detailBidHref,
} from '../copy';

// ── helper: a minimal opportunity ──
function opp(partial: Partial<Opportunity>): Opportunity {
  return {
    id: 'c1', propertyAddress: null, location: 'Carmel', zip: '46032', state: 'IN',
    jobType: 'insurance_rcv', trades: ['roofing'], damageType: 'Roof', damageDetail: 'Hail',
    insuranceCarrier: 'State Farm', material: null, estimatedValue: null, acvPayout: null,
    deductible: null, roofSquares: null, repairSquares: null, totalSquares: null,
    existingShingle: null, estimateAvailable: false, measurementsAvailable: false,
    claimFiledDate: '2026-03-15', distance: null, urgency: 'flexible', urgencyDeadline: null,
    urgencyReason: null, homeownerNotes: null, contractorScopeSummary: null, fundingType: 'insurance',
    releasedTrades: { roofing: true, gutters: false, siding: false, windows: false },
    bidWindowExpiresAt: null, estimateFilename: null,
    ...partial,
  };
}

describe('ZIP distance (haversine via centroids)', () => {
  it('looks up known Indiana zip centroids', () => {
    expect(getZipLatLng('46032')).toEqual([39.9784, -86.1180]);
    expect(getZipLatLng('46032-1234')).toEqual([39.9784, -86.1180]); // 5-digit slice
    expect(getZipLatLng('99999')).toBeNull();
    expect(getZipLatLng('')).toBeNull();
    expect(getZipLatLng(null)).toBeNull();
  });
  it('returns null distance when either zip is unknown (not 0)', () => {
    expect(computeZipDistance('46032', '99999')).toBeNull();
    expect(computeZipDistance(null, '46032')).toBeNull();
  });
  it('computes a sane rounded mileage between two known zips', () => {
    const d = computeZipDistance('46220', '46032'); // Indy → Carmel
    expect(typeof d).toBe('number');
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(30);
  });
  it('haversine is ~0 for identical points and symmetric', () => {
    expect(Math.round(haversineMiles(39.97, -86.11, 39.97, -86.11))).toBe(0);
    expect(haversineMiles(39.97, -86.11, 40.1, -86.0)).toBeCloseTo(
      haversineMiles(40.1, -86.0, 39.97, -86.11), 6,
    );
  });
});

describe('mapClaimToOpportunity', () => {
  const claim: RawClaim = {
    id: 'CL1', property_address: '123 Main St, Carmel, IN 46032', job_type: 'insurance_rcv',
    selected_trades: ['roofing', 'gutters'], damage_type: 'Roof', damage_description: 'Hail',
    rcv_amount: 22000, roofing_bid_released_at: '2026-03-01T00:00:00Z', created_at: '2026-03-15',
  };
  it('parses city/zip from the address and derives released trades', () => {
    const o = mapClaimToOpportunity(claim, '46220');
    expect(o.location).toBe('Carmel');
    expect(o.zip).toBe('46032');
    expect(o.trades).toEqual(['roofing', 'gutters']);
    expect(o.releasedTrades.roofing).toBe(true);
    expect(o.releasedTrades.gutters).toBe(false);
    expect(o.estimatedValue).toBe(22000);
    expect(typeof o.distance).toBe('number'); // both zips known
  });
  it('defaults trades to roofing and falls back through address parts', () => {
    const o = mapClaimToOpportunity({ id: 'X', property_address: 'Indianapolis 46220' }, null);
    expect(o.trades).toEqual(['roofing']);
    expect(o.zip).toBe('46220');
    expect(o.distance).toBeNull(); // contractor zip null
  });
});

describe('D-165 filterByTradeRelease', () => {
  const base = [
    opp({ id: 'a', trades: ['roofing'], releasedTrades: { roofing: true, gutters: false, siding: false, windows: false } }),
    opp({ id: 'b', trades: ['siding'], releasedTrades: { roofing: false, gutters: false, siding: true, windows: false } }),
    opp({ id: 'c', trades: ['roofing'], releasedTrades: { roofing: false, gutters: false, siding: false, windows: false } }),
  ];
  it('keeps only trades the contractor serves AND that are released', () => {
    const out = filterByTradeRelease(base, ['roofing']);
    expect(out.map((o) => o.id)).toEqual(['a']); // b=wrong trade, c=roofing not released
  });
  it('with no contractor trades, applies no trade filter', () => {
    expect(filterByTradeRelease(base, []).length).toBe(3);
    expect(filterByTradeRelease(base, null).length).toBe(3);
  });
});

describe('D-030 cap + D-150 my-bids', () => {
  const base = [opp({ id: 'a' }), opp({ id: 'b' }), opp({ id: 'c' }), opp({ id: 'd' })];
  it('excludes opportunities at the 6-bid cap', () => {
    const out = excludeCappedClaims(base, { b: 6, c: 5 });
    expect(out.map((o) => o.id)).toEqual(['a', 'c', 'd']);
  });
  it('excludes active bids, keeps + flags expired ones', () => {
    const out = applyMyBids(base, {
      a: { quoteId: 'q-a', bidStatus: 'submitted' }, // active → excluded
      c: { quoteId: 'q-c', bidStatus: 'expired' },   // expired → kept + flagged
    });
    expect(out.map((o) => o.id)).toEqual(['b', 'c', 'd']);
    const c = out.find((o) => o.id === 'c')!;
    expect(c.hasExpiredBid).toBe(true);
    expect(c.expiredQuoteId).toBe('q-c');
    expect(out.find((o) => o.id === 'b')!.hasExpiredBid).toBeUndefined();
  });
});

describe('applyOppFilters (filters + sort)', () => {
  const list = [
    opp({ id: 'rcv', jobType: 'insurance_rcv', estimatedValue: 10000, distance: 30, trades: ['roofing'] }),
    opp({ id: 'retail', jobType: 'retail', estimatedValue: 0, distance: 5, trades: ['roofing'], material: 'GAF Architectural' }),
    opp({ id: 'multi', jobType: 'insurance_rcv', estimatedValue: 50000, distance: 12, trades: ['roofing', 'siding'], urgency: 'asap' }),
  ];
  it('filters by job type, trade=multi, material keyword, and distance', () => {
    expect(applyOppFilters(list, { jobType: 'retail' }).map((o) => o.id)).toEqual(['retail']);
    expect(applyOppFilters(list, { trade: 'multi' }).map((o) => o.id)).toEqual(['multi']);
    expect(applyOppFilters(list, { trade: 'siding' }).map((o) => o.id)).toEqual(['multi']);
    expect(applyOppFilters(list, { material: 'architectural' }).map((o) => o.id)).toEqual(['retail']);
    expect(applyOppFilters(list, { distance: '10' }).map((o) => o.id)).toEqual(['retail']);
  });
  it('sorts by value-high, closest, and urgent-first', () => {
    expect(applyOppFilters(list, { sort: 'value-high' }).map((o) => o.id)).toEqual(['multi', 'rcv', 'retail']);
    expect(applyOppFilters(list, { sort: 'closest' }).map((o) => o.id)).toEqual(['retail', 'multi', 'rcv']);
    expect(applyOppFilters(list, { sort: 'urgent-first' })[0].id).toBe('multi');
  });
  it('does not mutate the input array', () => {
    const before = list.map((o) => o.id);
    applyOppFilters(list, { sort: 'value-high' });
    expect(list.map((o) => o.id)).toEqual(before);
  });
});

describe('display helpers', () => {
  it('valueDisplay varies by job type', () => {
    expect(valueDisplay(opp({ jobType: 'insurance_rcv', estimatedValue: 22000 }))).toEqual({ label: 'Est. Value', value: '$22,000' });
    expect(valueDisplay(opp({ jobType: 'retail', roofSquares: 28 }))).toEqual({ label: 'Roof Size', value: '28 squares' });
    expect(valueDisplay(opp({ jobType: 'repair', repairSquares: 1.5, totalSquares: 25 }))).toEqual({ label: 'Repair Scope', value: '1.5 sq of 25 sq total' });
    expect(valueDisplay(opp({ jobType: 'insurance_rcv', estimatedValue: null })).value).toBe('See estimate');
  });
  it('calcFees is 5% of value, with a roof-square fallback', () => {
    expect(calcFees(opp({ estimatedValue: 20000 }))).toEqual({ baseFee: '$1,000', total: '$1,000' });
    expect(calcFees(opp({ estimatedValue: null, roofSquares: 30 }))).toEqual({ baseFee: '$1,050', total: '$1,050' }); // 30*700*0.05
    expect(calcFees(opp({ estimatedValue: null, roofSquares: null }))).toBeNull();
  });
  it('expiryCountdown buckets by days remaining', () => {
    const now = new Date('2026-06-15T12:00:00Z').getTime();
    const inDays = (d: number) => new Date(now + d * 86400000).toISOString();
    expect(expiryCountdown({ bidWindowExpiresAt: null }, now)).toBeNull();
    expect(expiryCountdown({ bidWindowExpiresAt: inDays(-1) }, now)).toEqual({ tone: 'red', text: '⏰ Bid window closed' });
    expect(expiryCountdown({ bidWindowExpiresAt: inDays(0.5) }, now)).toEqual({ tone: 'red', text: '⏰ Closes today' });
    expect(expiryCountdown({ bidWindowExpiresAt: inDays(2.5) }, now)?.tone).toBe('amber');
    expect(expiryCountdown({ bidWindowExpiresAt: inDays(10) }, now)?.tone).toBe('neutral');
  });
  it('tradeReleaseBadges only shows when multi-trade or something is unreleased', () => {
    expect(tradeReleaseBadges(opp({ trades: ['roofing'], releasedTrades: { roofing: true, gutters: false, siding: false, windows: false } }))).toEqual([]);
    const multi = tradeReleaseBadges(opp({ trades: ['roofing', 'siding'], releasedTrades: { roofing: true, gutters: false, siding: false, windows: false } }));
    expect(multi).toEqual([{ label: 'Roofing', released: true }, { label: 'Siding', released: false }]);
  });
  it('tradeDisplay + resultsCountLabel + fmtCurrency format correctly', () => {
    expect(tradeDisplay(['roofing', 'siding'])).toBe('Roofing, Siding');
    expect(resultsCountLabel(1)).toBe('1 opportunity available');
    expect(resultsCountLabel(0)).toBe('0 opportunities available');
    expect(fmtCurrency(22000)).toBe('$22,000');
  });
});

describe('D-178 resolveStateGate', () => {
  it('parks a contractor whose state is not open; IN is open', () => {
    expect(resolveStateGate({ address_state: 'OH' })).toEqual({ parked: true, stateCode: 'OH', stateName: 'Ohio' });
    expect(resolveStateGate({ address_state: 'in' }).parked).toBe(false);
    expect(resolveStateGate({ address_state: null }).parked).toBe(false); // missing = not parked
    expect(resolveStateGate(null).parked).toBe(false);
    expect(OPEN_STATES).toEqual(['IN']);
  });
});

describe('copy: filter catalogs + bid deep-links', () => {
  it('exposes the static filter option sets', () => {
    expect(JOB_TYPE_OPTIONS[0]).toEqual({ value: '', label: 'All Types' });
    expect(TRADE_OPTIONS.map((o) => o.value)).toContain('multi');
    expect(SORT_OPTIONS[0].value).toBe('newest');
  });
  it('builds bid-form deep links (static stack until C3 migrates)', () => {
    expect(submitBidHref('CL1')).toBe('https://otterquote.com/contractor-bid-form.html?project=CL1');
    expect(renewBidHref('CL1', 'Q9')).toBe('https://otterquote.com/contractor-bid-form.html?renew=true&quote_id=Q9&claim_id=CL1');
    expect(detailBidHref('CL1')).toBe('https://otterquote.com/contractor-bid-form.html?claim_id=CL1');
  });
});
