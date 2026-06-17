/**
 * Parity + unit tests for the contractor Bid Form pure logic (D-211 Phase 7).
 * Exercises the ported logic against the behavior of contractor-bid-form.html
 * @ main (52fd26c2): the init() gating order, trade/path flags, the fee
 * calculator/disclosure/config-lookup math, the D-202 warranty serialization,
 * the D-199 bid_can_submit gate inputs, the quotes / fee_acceptances / notify /
 * rescind payloads, and mode resolution. Network, the RPC, the EFs, and the DOM
 * live in the page, not here.
 */

import { describe, it, expect } from 'vitest';
import {
  hasAttestation, isCoiOk, isProfileComplete, isPendingApproval,
  preCpaBidGate, profileIncompleteRedirect, BID_GATE_ROUTES,
  deriveTradeFlags,
  feeConfigLookupParams, resolveFeePct, computeCalculatorFee, computeDisclosureFee, computeQuoteFeeBase,
  PLATFORM_FEE_CONTRACT_SIGNING, QUOTE_FEE_PERCENTAGE,
  serializeWarrantySelection,
  bidGateRpcParams, interpretBidGate,
  buildScopeSummary, buildQuoteInsert, buildQuoteUpdate, BID_RENEWAL_WINDOW_MS,
  applyCustomWarrantyReview, CUSTOM_WARRANTY_REVIEW_NOTE,
  buildFeeAcceptanceInsert, buildBidConfirmationBody, buildNotifyContractorsBody, buildBidUpdatedNotification,
  RESCINDABLE_STATUSES, isRescindable, buildRescindRequest,
  resolveClaimId, resolveBidMode,
  type BidGateContractor, type BidClaim,
} from '../utils';
import {
  BID_COPY, buildFeeDisclosureText, CUSTOM_WARRANTY_TAIL,
  bidRoutePath, renewBidRoutePath, rescindBidRoutePath,
} from '../copy';

// ── helpers ──
const activeContractor = (over: Partial<BidGateContractor> = {}): BidGateContractor => ({
  status: 'active',
  attestation_accepted_at: '2026-05-01T00:00:00Z',
  coi_file_url: 'https://x/coi.pdf',
  coi_expires_at: '2027-01-01',
  company_name: 'Acme Roofing',
  phone: '317-555-1212',
  trades: ['roofing'],
  service_counties: ['Marion'],
  ...over,
});
const NOW = new Date('2026-06-17T12:00:00Z');

// =============================================================================
describe('gating predicates (init() :3563-3602)', () => {
  it('hasAttestation', () => {
    expect(hasAttestation({ attestation_accepted_at: '2026-01-01' })).toBe(true);
    expect(hasAttestation({ attestation_accepted_at: null })).toBe(false);
    expect(hasAttestation(null)).toBe(false);
  });

  it('isCoiOk: file + future expiry passes; past / missing / invalid fails', () => {
    expect(isCoiOk(activeContractor(), NOW)).toBe(true);
    expect(isCoiOk(activeContractor({ coi_expires_at: '2026-01-01' }), NOW)).toBe(false); // past
    expect(isCoiOk(activeContractor({ coi_file_url: null }), NOW)).toBe(false); // no file
    expect(isCoiOk(activeContractor({ coi_expires_at: null }), NOW)).toBe(false); // no expiry
    expect(isCoiOk(activeContractor({ coi_expires_at: 'not-a-date' }), NOW)).toBe(false);
  });

  it('isCoiOk treats expiry as start-of-day local (T00:00:00, no Z)', () => {
    // matches `new Date(coi_expires_at + 'T00:00:00')` — local midnight, not UTC
    expect(isCoiOk(activeContractor({ coi_expires_at: '2026-06-17' }), new Date('2026-06-17T23:59:59'))).toBe(false);
    expect(isCoiOk(activeContractor({ coi_expires_at: '2026-06-18' }), new Date('2026-06-17T23:59:59'))).toBe(true);
  });

  it('isProfileComplete requires company_name, phone, ≥1 trade, ≥1 county', () => {
    expect(isProfileComplete(activeContractor())).toBe(true);
    expect(isProfileComplete(activeContractor({ company_name: '   ' }))).toBe(false);
    expect(isProfileComplete(activeContractor({ phone: '' }))).toBe(false);
    expect(isProfileComplete(activeContractor({ trades: [] }))).toBe(false);
    expect(isProfileComplete(activeContractor({ service_counties: [] }))).toBe(false);
    expect(isProfileComplete(activeContractor({ trades: null }))).toBe(false);
  });

  it('isPendingApproval: status present and !== active', () => {
    expect(isPendingApproval({ status: 'pending_approval' })).toBe(true);
    expect(isPendingApproval({ status: 'active' })).toBe(false);
    expect(isPendingApproval({ status: null })).toBe(false);
    expect(isPendingApproval(null)).toBe(false);
  });
});

describe('preCpaBidGate ordering (pending → attestation → COI)', () => {
  it('pending wins first', () => {
    expect(preCpaBidGate(activeContractor({ status: 'pending_approval', attestation_accepted_at: null }), NOW))
      .toBe(BID_GATE_ROUTES.pending);
  });
  it('then attestation', () => {
    expect(preCpaBidGate(activeContractor({ attestation_accepted_at: null }), NOW))
      .toBe(BID_GATE_ROUTES.attestation);
  });
  it('then COI', () => {
    expect(preCpaBidGate(activeContractor({ coi_expires_at: '2020-01-01' }), NOW))
      .toBe(BID_GATE_ROUTES.coi);
  });
  it('all clear → null (CPA + profile gates run after, in the page)', () => {
    expect(preCpaBidGate(activeContractor(), NOW)).toBeNull();
  });
  it('routes are flipped to the live React contractor routes', () => {
    expect(BID_GATE_ROUTES.pending).toBe('/contractor/dashboard?msg=pending_approval');
    expect(BID_GATE_ROUTES.attestation).toBe('/contractor/settings?reason=attestation_required');
    expect(BID_GATE_ROUTES.coi).toBe('/contractor/settings?reason=coi_required#coiCard');
    expect(BID_GATE_ROUTES.profileIncomplete).toBe('/contractor/profile?incomplete=bid');
    expect(BID_GATE_ROUTES.profileTemplates).toBe('/contractor/profile#templates');
  });
  it('profileIncompleteRedirect', () => {
    expect(profileIncompleteRedirect(activeContractor())).toBeNull();
    expect(profileIncompleteRedirect(activeContractor({ phone: '' }))).toBe(BID_GATE_ROUTES.profileIncomplete);
  });
});

// =============================================================================
describe('deriveTradeFlags (:3123-3128)', () => {
  it('retail by job_type or cash funding', () => {
    expect(deriveTradeFlags({ job_type: 'retail', trades: ['roofing'] }).isRetailJob).toBe(true);
    expect(deriveTradeFlags({ funding_type: 'cash', trades: ['roofing'] }).isRetailJob).toBe(true);
    expect(deriveTradeFlags({ job_type: 'insurance_rcv', trades: ['roofing'] }).isRetailJob).toBe(false);
  });
  it('gutterTradeActive only when gutters and NOT roofing/siding', () => {
    expect(deriveTradeFlags({ trades: ['gutters'] }).gutterTradeActive).toBe(true);
    expect(deriveTradeFlags({ trades: ['gutters', 'roofing'] }).gutterTradeActive).toBe(false);
  });
  it('sidingTradeActive only when siding AND retail', () => {
    expect(deriveTradeFlags({ job_type: 'retail', trades: ['siding'] }).sidingTradeActive).toBe(true);
    expect(deriveTradeFlags({ job_type: 'insurance_rcv', trades: ['siding'] }).sidingTradeActive).toBe(false);
  });
});

// =============================================================================
describe('fee math', () => {
  it('feeConfigLookupParams uppercases state, lowercases first trade, defaults roofing', () => {
    expect(feeConfigLookupParams({ state: 'in' }, { trades: ['Gutters'] })).toEqual({ state: 'IN', trade: 'gutters' });
    expect(feeConfigLookupParams({ state: null }, { trades: [] })).toEqual({ state: '', trade: 'roofing' });
  });

  it('resolveFeePct: first row fee_pct, parses string, 0/NaN/empty → fallback', () => {
    expect(resolveFeePct([{ fee_pct: 7.5 }])).toBe(7.5);
    expect(resolveFeePct([{ fee_pct: '10' }])).toBe(10);
    expect(resolveFeePct([{ fee_pct: 0 }])).toBe(5.0); // `|| default` parity
    expect(resolveFeePct([])).toBe(5.0);
    expect(resolveFeePct(null)).toBe(5.0);
    expect(resolveFeePct([{ fee_pct: 'abc' }])).toBe(5.0);
    expect(resolveFeePct([{ fee_pct: 6 }], 5.0)).toBe(6);
  });

  it('computeCalculatorFee uses RCV base for insurance_rcv, bid base otherwise', () => {
    const ins = computeCalculatorFee({ job_type: 'insurance_rcv' }, 20000, 18000);
    expect(ins.feeBase).toBe(20000);
    expect(ins.contractSigningFee).toBe(1000);
    expect(ins.totalFeePercent).toBe('5.0');
    expect(ins.netAmount).toBe(17000);

    const retail = computeCalculatorFee({ job_type: 'retail' }, null, 10000);
    expect(retail.feeBase).toBe(10000);
    expect(retail.totalFee).toBe(500);
    expect(retail.netAmount).toBe(9500);
  });

  it('computeCalculatorFee guards divide-by-zero', () => {
    expect(computeCalculatorFee({ job_type: 'retail' }, null, 0).totalFeePercent).toBe('0');
  });

  it('computeDisclosureFee is always bid-amount based', () => {
    expect(computeDisclosureFee(10000, 5)).toEqual({ feeAmount: 500, netAmount: 9500 });
    expect(computeDisclosureFee(10000, 7.5)).toEqual({ feeAmount: 750, netAmount: 9250 });
  });

  it('computeQuoteFeeBase: insurance_rcv reads parsed_line_items.summary.rcv (object or JSON string)', () => {
    expect(computeQuoteFeeBase({ job_type: 'insurance_rcv', parsed_line_items: { summary: { rcv: 20000 } } }, 18000)).toBe(20000);
    expect(computeQuoteFeeBase({ job_type: 'insurance_rcv', parsed_line_items: '{"summary":{"rcv":15000}}' }, 18000)).toBe(15000);
    expect(computeQuoteFeeBase({ job_type: 'insurance_rcv', parsed_line_items: null }, 18000)).toBe(18000);
    expect(computeQuoteFeeBase({ job_type: 'retail' }, 9000)).toBe(9000);
    expect(computeQuoteFeeBase({ job_type: 'insurance_rcv', parsed_line_items: 'not json' }, 7000)).toBe(7000);
  });

  it('constants match the static page', () => {
    expect(PLATFORM_FEE_CONTRACT_SIGNING).toBe(0.05);
    expect(QUOTE_FEE_PERCENTAGE).toBe(5.0);
  });
});

// =============================================================================
describe('buildFeeDisclosureText — VERBATIM (D-214/D-215, :5035)', () => {
  it('matches the static generateExactFeeText byte-for-byte', () => {
    expect(buildFeeDisclosureText(5, 500, 10000)).toBe(
      'By submitting this bid, you agree to pay Otter Quotes a platform fee of 5.00% ($500.00) upon contract execution. ' +
      'This fee is deducted from your bid amount before disbursement. You will receive $9,500.00 upon completion. ' +
      'I understand and agree to the platform fee of 5.00% ($500.00)',
    );
  });
  it('formats pct to 2 decimals and amounts as USD currency', () => {
    expect(buildFeeDisclosureText(7.5, 750, 10000)).toContain('platform fee of 7.50% ($750.00)');
    expect(buildFeeDisclosureText(7.5, 750, 10000)).toContain('You will receive $9,250.00 upon completion');
  });
});

// =============================================================================
describe('D-202 warranty serialization (getD202WarrantySelection :4657-4709)', () => {
  it('manufacturer×tier selection → option id + snapshot from display_string', () => {
    const sel = serializeWarrantySelection({
      isCustom: false, optionId: 'opt-1', snapshot: 'GAF Golden Pledge — 50yr', workmanshipYearsRaw: '10',
    });
    expect(sel).toEqual({
      warranty_option_id: 'opt-1', warranty_snapshot: 'GAF Golden Pledge — 50yr',
      workmanship_warranty_years: 10, is_custom: false,
    });
  });

  it('custom selection → snapshot string with the D-204 verbatim tail + custom_payload', () => {
    const sel = serializeWarrantySelection({
      isCustom: true,
      custom: { manufacturer: 'Acme', tier: 'Pro', materialYears: '30', laborYears: '10', windMph: '130', hailClass: '4' },
      workmanshipYearsRaw: '5',
    });
    expect(sel.is_custom).toBe(true);
    expect(sel.warranty_option_id).toBeNull();
    expect(sel.warranty_snapshot).toBe(
      'Acme Pro — Material: 30; Labor: 10 years; Wind: 130 mph; Hail: 4' + CUSTOM_WARRANTY_TAIL,
    );
    expect(sel.warranty_snapshot!.endsWith('Otter Quotes is not the warrantor.')).toBe(true);
    expect(sel.workmanship_warranty_years).toBe(5);
    expect(sel.custom_payload).toEqual({
      manufacturer: 'Acme', tier: 'Pro', material_years: '30', labor_years: '10', wind_mph: '130', hail_class: '4',
    });
  });

  it('custom defaults for blank-but-not-all fields', () => {
    const sel = serializeWarrantySelection({ isCustom: true, custom: { manufacturer: 'Acme' }, workmanshipYearsRaw: '' });
    expect(sel.warranty_snapshot).toBe(
      'Acme  — Material: Per manufacturer; Labor: None; Wind: Per product; Hail: Standard' + CUSTOM_WARRANTY_TAIL,
    );
    expect(sel.workmanship_warranty_years).toBeNull();
  });

  it('custom with all fields blank → treated as no warranty (is_custom false)', () => {
    expect(serializeWarrantySelection({ isCustom: true, custom: {}, workmanshipYearsRaw: '7' })).toEqual({
      warranty_option_id: null, warranty_snapshot: null, workmanship_warranty_years: 7, is_custom: false,
    });
  });

  it('workmanship parse: number, NaN string → null, empty → null', () => {
    expect(serializeWarrantySelection({ isCustom: false, optionId: null, workmanshipYearsRaw: 12 }).workmanship_warranty_years).toBe(12);
    expect(serializeWarrantySelection({ isCustom: false, optionId: null, workmanshipYearsRaw: 'abc' }).workmanship_warranty_years).toBeNull();
    expect(serializeWarrantySelection({ isCustom: false, optionId: null, workmanshipYearsRaw: '' }).workmanship_warranty_years).toBeNull();
  });
});

// =============================================================================
describe('D-199 bid_can_submit gate', () => {
  it('bidGateRpcParams: trade fallback chain + funding collapse', () => {
    expect(bidGateRpcParams('Siding', { trades: ['roofing'] }, 'c1')).toEqual({
      p_contractor_id: 'c1', p_trade: 'siding', p_funding_type: 'retail',
    });
    expect(bidGateRpcParams(null, { selected_trades: ['Gutters'], trades: ['roofing'], job_type: 'insurance_rcv' }, 'c1')).toEqual({
      p_contractor_id: 'c1', p_trade: 'gutters', p_funding_type: 'insurance',
    });
    expect(bidGateRpcParams(null, { trades: ['roofing'], funding_type: 'insurance' }, 'c1').p_funding_type).toBe('insurance');
    expect(bidGateRpcParams(null, {}, 'c1')).toEqual({ p_contractor_id: 'c1', p_trade: 'roofing', p_funding_type: 'retail' });
  });

  it('interpretBidGate: error → verify-template copy; null → unknown; data passthrough', () => {
    const copy = { couldNotVerifyTemplate: BID_COPY.gate.couldNotVerifyTemplate, networkError: BID_COPY.gate.networkError };
    expect(interpretBidGate(null, new Error('boom'), copy)).toEqual({
      can_submit: false, reason: BID_COPY.gate.couldNotVerifyTemplate, status: null,
    });
    expect(interpretBidGate(null, null, copy)).toEqual({ can_submit: false, reason: 'Unknown error', status: null });
    expect(interpretBidGate({ can_submit: true, reason: null, status: 'ok' }, null, copy)).toEqual({
      can_submit: true, reason: null, status: 'ok',
    });
  });
});

// =============================================================================
describe('quote + acceptance + notify payloads', () => {
  const warranty = serializeWarrantySelection({ isCustom: false, optionId: 'opt-9', snapshot: 'GAF 50yr', workmanshipYearsRaw: '10' });
  const common = {
    claimId: 'claim-1', contractorId: 'con-1', totalPrice: 18000, feeBase: 20000, feePct: 6,
    acceptedAtIso: '2026-06-17T12:00:00.000Z', scopeSummary: '{"brand":"GAF"}', notes: 'hello',
    deckingPricePerSheet: 65, fullRedeckPrice: 1200, supplementAcknowledged: true, tradeType: null,
    valueAdds: { foo: 'bar' }, perTradeBreakdown: null, autoRenew: true, warranty,
  };

  it('buildQuoteInsert: hardcoded fee_percentage 5.0, fee_amount=feeBase*5%, config platform_fee_pct, defaults', () => {
    const q = buildQuoteInsert(common);
    expect(q.claim_id).toBe('claim-1');
    expect(q.fee_percentage).toBe(5.0);
    expect(q.fee_amount).toBe(1000); // 20000 * 0.05
    expect(q.platform_fee_pct).toBe(6); // config
    expect(q.platform_fee_basis).toBe('bid_amount');
    expect(q.is_auto_bid).toBe(false);
    expect(q.trade_type).toBe('roofing'); // null → default
    expect(q.warranty_option_id).toBe('opt-9');
    expect(q.warranty_snapshot).toBe('GAF 50yr');
    expect(q.workmanship_warranty_years).toBe(10);
    expect(q.fee_accepted_at).toBe('2026-06-17T12:00:00.000Z');
  });

  it('buildQuoteUpdate: base fields, no renew keys when not renewing', () => {
    const u = buildQuoteUpdate({ ...common, renewMode: false, now: NOW });
    expect(u.updated_at).toBe(NOW.toISOString());
    expect(u).not.toHaveProperty('bid_status');
    expect(u).not.toHaveProperty('expires_at');
    expect(u.fee_amount).toBe(1000);
  });

  it('buildQuoteUpdate renewal resets the 14-day window + increments renewals_count', () => {
    const u = buildQuoteUpdate({ ...common, renewMode: true, existingRenewalsCount: 2, now: NOW });
    expect(u.bid_status).toBe('submitted');
    expect(u.expired_at).toBeNull();
    expect(u.expires_at).toBe(new Date(NOW.getTime() + BID_RENEWAL_WINDOW_MS).toISOString());
    expect(u.renewals_count).toBe(3);
    expect(BID_RENEWAL_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('applyCustomWarrantyReview flags only custom warranties', () => {
    const custom = serializeWarrantySelection({ isCustom: true, custom: { manufacturer: 'Acme' }, workmanshipYearsRaw: '' });
    const va = applyCustomWarrantyReview({ a: 1 }, custom, '2026-06-17T12:00:00.000Z');
    expect((va.warranty_admin_review as { note: string }).note).toBe(CUSTOM_WARRANTY_REVIEW_NOTE);
    expect((va.warranty_admin_review as { payload: unknown }).payload).toEqual(custom.custom_payload);
    expect(applyCustomWarrantyReview({ a: 1 }, warranty, 'x')).toEqual({ a: 1 }); // non-custom untouched
  });

  it('buildFeeAcceptanceInsert (D-215 Layer 1)', () => {
    expect(buildFeeAcceptanceInsert({
      contractorId: 'con-1', claimId: 'claim-1', bidId: 'bid-1', feePct: 6, feeAmount: 1080,
      feeTextDisplayed: 'TEXT', acceptedAtIso: 'T', ipAddress: '1.2.3.4', userAgent: 'UA',
    })).toEqual({
      contractor_id: 'con-1', claim_id: 'claim-1', bid_id: 'bid-1', fee_pct: 6, fee_basis: 'bid_amount',
      fee_amount: 1080, fee_text_displayed: 'TEXT', accepted_at: 'T', ip_address: '1.2.3.4', user_agent: 'UA',
    });
  });

  it('buildBidConfirmationBody (D-215 Layer 2)', () => {
    expect(buildBidConfirmationBody({ quoteId: 'q1', contractorId: 'c1', bidAmount: 18000, feePct: 6, feeAmount: 1080, trade: 'roofing' })).toEqual({
      quote_id: 'q1', contractor_id: 'c1', bid_amount: 18000, platform_fee_pct: 6, platform_fee_amount: 1080, trade: 'roofing',
    });
  });

  it('buildNotifyContractorsBody: renewal vs update event_type', () => {
    expect(buildNotifyContractorsBody(true, 'cl', 'co').event_type).toBe('bid_renewal_requested');
    expect(buildNotifyContractorsBody(false, 'cl', 'co').event_type).toBe('bid_update_confirmed');
  });

  it('buildBidUpdatedNotification + preview copy fallback', () => {
    const n = buildBidUpdatedNotification({ claimUserId: 'u1', claimId: 'cl', previewText: BID_COPY.bidUpdatedPreview('Acme Roofing'), createdAtIso: 'T' });
    expect(n).toEqual({
      user_id: 'u1', claim_id: 'cl', channel: 'dashboard', notification_type: 'bid_updated',
      recipient: '', message_preview: 'Acme Roofing has updated their bid for your project. Please review the new figures.', created_at: 'T',
    });
    expect(BID_COPY.bidUpdatedPreview(null)).toBe('A contractor has updated their bid for your project. Please review the new figures.');
    expect(buildBidUpdatedNotification({ claimUserId: null, claimId: 'cl', previewText: 'x', createdAtIso: 'T' }).user_id).toBeNull();
  });

  it('buildScopeSummary nulls empties', () => {
    expect(JSON.parse(buildScopeSummary({ brand: 'GAF', estimatedStartDate: '', estimatedCompletionTime: '2 weeks' }))).toEqual({
      brand: 'GAF', estimated_start_date: null, estimated_completion_time: '2 weeks',
    });
  });
});

// =============================================================================
describe('rescind (:5746-5793)', () => {
  it('RESCINDABLE statuses', () => {
    expect([...RESCINDABLE_STATUSES]).toEqual(['submitted', 'pending', 'under_review']);
    expect(isRescindable('submitted')).toBe(true);
    expect(isRescindable('under_review')).toBe(true);
    expect(isRescindable('signed')).toBe(false);
    expect(isRescindable('expired')).toBe(false);
    expect(isRescindable(null)).toBe(false);
  });
  it('buildRescindRequest', () => {
    expect(buildRescindRequest('q1', 'c1')).toEqual({ quote_id: 'q1', contractor_id: 'c1', reason: 'contractor_initiated' });
  });
  it('notRescindable copy renders status as text', () => {
    expect(BID_COPY.rescind.notRescindable('signed')).toContain('Bid status: signed');
  });
});

// =============================================================================
describe('mode + claim-id resolution', () => {
  it('resolveClaimId: segment first, then ?claim_id, then ?project', () => {
    expect(resolveClaimId('abc', new URLSearchParams(''))).toBe('abc');
    expect(resolveClaimId(['abc', 'x'], new URLSearchParams(''))).toBe('abc');
    expect(resolveClaimId(undefined, new URLSearchParams('claim_id=xyz'))).toBe('xyz');
    expect(resolveClaimId(undefined, new URLSearchParams('project=p1'))).toBe('p1');
    expect(resolveClaimId(undefined, new URLSearchParams(''))).toBeNull();
  });

  it('resolveBidMode: rescind overrides; renew needs expired; else change/submit', () => {
    expect(resolveBidMode({ action: 'rescind', renewParam: null, hasExistingQuote: true })).toBe('rescind');
    expect(resolveBidMode({ action: null, renewParam: 'true', hasExistingQuote: true, existingBidStatus: 'expired' })).toBe('renew');
    expect(resolveBidMode({ action: null, renewParam: 'true', hasExistingQuote: true, existingBidStatus: 'submitted' })).toBe('change');
    expect(resolveBidMode({ action: null, renewParam: null, hasExistingQuote: true })).toBe('change');
    expect(resolveBidMode({ action: null, renewParam: null, hasExistingQuote: false })).toBe('submit');
    expect(resolveBidMode({ action: 'sign', renewParam: null, hasExistingQuote: false })).toBe('submit'); // deprecated → normal
  });
});

// =============================================================================
describe('React route helpers (copy.ts)', () => {
  it('bidRoutePath / renew / rescind', () => {
    expect(bidRoutePath('claim-1')).toBe('/contractor/bid/claim-1');
    expect(renewBidRoutePath('claim-1')).toBe('/contractor/bid/claim-1?renew=true');
    expect(rescindBidRoutePath('claim-1')).toBe('/contractor/bid/claim-1?action=rescind');
    expect(bidRoutePath('a/b')).toBe('/contractor/bid/a%2Fb'); // encoded
  });
  it('fee info copy', () => {
    expect(BID_COPY.fee.feeInfoInsurance('$20,000.00')).toBe('ℹ A flat 5% platform fee based on the RCV ($20,000.00) applies upon contract signing.');
    expect(BID_COPY.fee.feeInfoRetail).toBe('ℹ A flat 5% platform fee applies to all projects upon contract signing.');
  });
});
