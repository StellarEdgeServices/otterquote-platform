/**
 * PR-2 (BF-2) parity + unit tests for the NEW pure logic the page UI consumes:
 *   - buildValueAdds      — the quotes.value_adds JSON builder (contractor-bid-form.html:5149-5285)
 *   - the D-162 wizard    — computeWizardEligibility + wizardReducer (:2473-2665)
 * The page (page.tsx) owns the DOM/network/localStorage; these stay pure.
 */

import { describe, it, expect } from 'vitest';
import {
  buildValueAdds,
  computeWizardEligibility,
  wizardReducer,
  orderWizardTrades,
  WIZARD_TRADE_ORDER,
  type ValueAddsFormState,
  type ValueAddsContext,
  type WizardState,
} from '../utils';

const insuranceCtx = (over: Partial<ValueAddsContext> = {}): ValueAddsContext => ({
  gutterTradeActive: false,
  sidingTradeActive: false,
  claimTrades: ['roofing'],
  wizardMode: false,
  wizardTradeQueue: [],
  ...over,
});

describe('buildValueAdds — baseline (insurance roofing, no add-ons)', () => {
  it('produces the exact static value_adds object for a minimal RCV bid', () => {
    const form: ValueAddsFormState = { bidTypeOption: 'rcv_plus_supplements' };
    expect(buildValueAdds(form, insuranceCtx())).toEqual({
      bid_type_option: 'rcv_plus_supplements',
      other_bid_description: null,
      gutters: { option: 'none', additional_cost_5inch: null, additional_cost_6inch: null, other_text: null },
      gutter_guards: { pricing_on_request: false, mesh_oop: null, screw_in_oop: null, notes: null },
      chimney: { type: 'na', option: null, oop_price: null },
      chimney_flashing: null,
      chimney_reflash: null,
      skylights: 'na',
      other_shingles: [],
      other_shingles_notes: null,
      underlayment: { type: null, notes: null },
      ice_water_shield: { coverage: 'not_applicable' },
      ventilation: { ridge_vent_included: false, ridge_vent_oop: null, notes: null },
      starter_strip: null,
      drip_edge: { option: 'na', oop_price: null },
      warranties: null,
      other_trades_covered: {
        siding_full: null, siding_repair: null, gutters_full: null, gutters_repair: null,
        interior: null, paint: null, windows: null, other: null, additional_notes: null,
      },
      other_offers: null,
      num_stories: null,
    });
  });

  it('other bid description only carried when bid_type_option === "other"', () => {
    expect(buildValueAdds({ bidTypeOption: 'rcv_plus_supplements', otherBidDescription: 'flat bid' }, insuranceCtx()).other_bid_description).toBeNull();
    expect(buildValueAdds({ bidTypeOption: 'other', otherBidDescription: 'flat bid' }, insuranceCtx()).other_bid_description).toBe('flat bid');
  });
});

describe('buildValueAdds — numeric coercion (parseFloat || null)', () => {
  it('0, empty and non-numeric all collapse to null; real numbers pass through', () => {
    const va = buildValueAdds({
      bidTypeOption: 'other',
      gutterOption: '5inch_additional',
      gutter5AdditionalCost: '0',          // 0 → null
      ridgeVentIncluded: true,
      ridgeVentOopPrice: '125.50',         // → 125.5
    }, insuranceCtx());
    expect((va.gutters as Record<string, unknown>).additional_cost_5inch).toBeNull();
    expect((va.ventilation as Record<string, unknown>).ridge_vent_oop).toBe(125.5);
    expect((va.ventilation as Record<string, unknown>).ridge_vent_included).toBe(true);
  });

  it('gutter option branches gate which additional-cost field is populated', () => {
    const six = buildValueAdds({ bidTypeOption: 'other', gutterOption: '6inch_additional', gutter6AdditionalCost: '300' }, insuranceCtx());
    expect((six.gutters as Record<string, unknown>).additional_cost_6inch).toBe(300);
    expect((six.gutters as Record<string, unknown>).additional_cost_5inch).toBeNull();
    const other = buildValueAdds({ bidTypeOption: 'other', gutterOption: 'other', gutterOtherText: 'custom' }, insuranceCtx());
    expect((other.gutters as Record<string, unknown>).other_text).toBe('custom');
  });

  it('chimney option/oop gated by chimney type and "oop" option', () => {
    const incl = buildValueAdds({ bidTypeOption: 'other', chimneyType: 'brick' }, insuranceCtx());
    expect((incl.chimney as Record<string, unknown>).option).toBe('included');
    expect((incl.chimney as Record<string, unknown>).oop_price).toBeNull();
    const oop = buildValueAdds({ bidTypeOption: 'other', chimneyType: 'brick', chimneyOption: 'oop', chimneyOopPrice: '450' }, insuranceCtx());
    expect((oop.chimney as Record<string, unknown>).oop_price).toBe(450);
  });
});

describe('buildValueAdds — gutter-trade append', () => {
  it('adds gutter pricing + retail guards + trimmed notes when gutterTradeActive', () => {
    const va = buildValueAdds({
      bidTypeOption: 'other',
      gutterLinearFootage: '180',
      gutter5InchPrice: '12',
      gutter6InchPrice: '0',                       // 0 → null
      gutterGuardsRetail: [{ type: 'mesh', price: 4 }],
      rottenWoodPricing: '  $35/ft  ',             // trimmed
      gutterAdditionalNotes: '   ',                // blank → null
      gutterWarrantyInfo: 'Lifetime',
    }, insuranceCtx({ gutterTradeActive: true, claimTrades: ['gutters'] }));
    expect((va.gutters as Record<string, unknown>).linearFootage).toBe(180);
    expect(va.gutter_5inch_price).toBe(12);
    expect(va.gutter_6inch_price).toBeNull();
    expect(va.gutter_guards_retail).toEqual([{ type: 'mesh', price: 4 }]);
    expect(va.rotten_wood_pricing).toBe('$35/ft');
    expect(va.gutter_additional_notes).toBeNull();
    expect(va.gutter_warranty).toBe('Lifetime');
  });

  it('does NOT add gutter-trade keys when gutterTradeActive is false', () => {
    const va = buildValueAdds({ bidTypeOption: 'other' }, insuranceCtx());
    expect('gutter_5inch_price' in va).toBe(false);
    expect('gutter_guards_retail' in va).toBe(false);
  });
});

describe('buildValueAdds — siding-trade append', () => {
  it('siding-only (no roofing) includes per-square pricing', () => {
    const va = buildValueAdds({
      bidTypeOption: 'other',
      sidingProductSupply: 'contractor',
      sidingInstallPerSquare: '95',
      sidingTrimPrice: '8',
      sidingWindowWrapPrice: '0',                  // 0 → null
      sidingTeardownPrice: '15',
    }, insuranceCtx({ sidingTradeActive: true, claimTrades: ['siding'] }));
    expect(va.siding_product_supply).toBe('contractor');
    expect(va.siding_install_per_square).toBe(95);
    expect(va.siding_trim_price).toBe(8);
    expect(va.siding_window_wrap_price).toBeNull();
    expect(va.siding_teardown_price).toBe(15);
  });

  it('roofing+siding bundle OMITS siding per-square pricing (roofing present)', () => {
    const va = buildValueAdds({
      bidTypeOption: 'other',
      sidingProductSupply: 'equivalent',
      sidingInstallPerSquare: '95',
    }, insuranceCtx({ sidingTradeActive: true, claimTrades: ['roofing', 'siding'] }));
    expect(va.siding_product_supply).toBe('equivalent');
    expect('siding_install_per_square' in va).toBe(false);
  });
});

describe('buildValueAdds — second-layer contingency + wizard step-3', () => {
  it('SLC present only when a price is given; method defaults to per_square', () => {
    expect('secondLayerContingency' in buildValueAdds({ bidTypeOption: 'other' }, insuranceCtx())).toBe(false);
    const slc = buildValueAdds({ bidTypeOption: 'other', slcPricePerSquare: '75' }, insuranceCtx());
    expect(slc.secondLayerContingency).toEqual({ pricePerSquare: 75, flatFeeAlternative: null, method: 'per_square' });
    const flat = buildValueAdds({ bidTypeOption: 'other', slcFlatFeeAlternative: '500', slcMethod: 'flat_fee' }, insuranceCtx());
    expect(flat.secondLayerContingency).toEqual({ pricePerSquare: null, flatFeeAlternative: 500, method: 'flat_fee' });
  });

  it('wizard fields recorded only in wizardMode; blank note/rationale omitted', () => {
    const va = buildValueAdds(
      { bidTypeOption: 'other', wizardBundleNote: '  bundle  ', wizardRationale: '   ' },
      insuranceCtx({ wizardMode: true, wizardTradeQueue: ['roofing', 'gutters'] }),
    );
    expect(va.wizard_bundle_note).toBe('bundle');
    expect('wizard_rationale' in va).toBe(false);
    expect(va.wizard_trade_queue).toEqual(['roofing', 'gutters']);
    // empty queue → null
    const va2 = buildValueAdds({ bidTypeOption: 'other' }, insuranceCtx({ wizardMode: true, wizardTradeQueue: [] }));
    expect(va2.wizard_trade_queue).toBeNull();
  });
});

describe('computeWizardEligibility (D-162 initWizard, :2473-2488)', () => {
  it('requires a retail job', () => {
    expect(computeWizardEligibility(['roofing', 'gutters'], { isRetailJob: false, sidingReleased: false }).eligible).toBe(false);
  });
  it('requires >= 2 ordered trades', () => {
    expect(computeWizardEligibility(['roofing'], { isRetailJob: true, sidingReleased: false }).eligible).toBe(false);
    expect(computeWizardEligibility(['roofing', 'gutters'], { isRetailJob: true, sidingReleased: false }))
      .toEqual({ eligible: true, queue: ['roofing', 'gutters'] });
  });
  it('D-165 siding gate: siding dropped until released; can fall below 2 → ineligible', () => {
    // roofing + siding, siding NOT released → only roofing left → ineligible
    expect(computeWizardEligibility(['roofing', 'siding'], { isRetailJob: true, sidingReleased: false }).eligible).toBe(false);
    // roofing + siding, siding released → both kept, in order
    expect(computeWizardEligibility(['siding', 'roofing'], { isRetailJob: true, sidingReleased: true }))
      .toEqual({ eligible: true, queue: ['roofing', 'siding'] });
    // roofing + gutters + siding (siding gated) → still 2 → eligible without siding
    expect(computeWizardEligibility(['roofing', 'gutters', 'siding'], { isRetailJob: true, sidingReleased: false }))
      .toEqual({ eligible: true, queue: ['roofing', 'gutters'] });
  });
  it('orders trades roofing → gutters → siding regardless of input order', () => {
    expect(orderWizardTrades(['siding', 'roofing', 'gutters'])).toEqual(['roofing', 'gutters', 'siding']);
    expect(WIZARD_TRADE_ORDER).toEqual(['roofing', 'gutters', 'siding']);
  });
});

describe('wizardReducer (wizardNext/Back/GoTo, :2521-2665)', () => {
  const base = (over: Partial<WizardState> = {}): WizardState => ({
    step: 1, tradeIdx: 0, queue: [], selectedTrades: ['roofing', 'gutters', 'siding'], ...over,
  });

  it('setSelected reorders to WIZARD_TRADE_ORDER', () => {
    expect(wizardReducer(base({ selectedTrades: [] }), { type: 'setSelected', selectedTrades: ['siding', 'roofing'] }).selectedTrades)
      .toEqual(['roofing', 'siding']);
  });

  it('next from step 1 with no selection is a no-op', () => {
    const s = base({ selectedTrades: [] });
    expect(wizardReducer(s, { type: 'next' })).toBe(s);
  });

  it('next from step 1 seeds the queue and enters step 2 at idx 0', () => {
    const s = wizardReducer(base({ selectedTrades: ['roofing', 'gutters'] }), { type: 'next' });
    expect(s).toMatchObject({ step: 2, tradeIdx: 0, queue: ['roofing', 'gutters'] });
  });

  it('next walks trades then advances to step 3 after the last', () => {
    let s: WizardState = { step: 2, tradeIdx: 0, queue: ['roofing', 'gutters'], selectedTrades: ['roofing', 'gutters'] };
    s = wizardReducer(s, { type: 'next' });
    expect(s).toMatchObject({ step: 2, tradeIdx: 1 });
    s = wizardReducer(s, { type: 'next' });
    expect(s).toMatchObject({ step: 3, tradeIdx: 0 });
  });

  it('back: step2 idx0 → step1; step2 idx>0 → idx-1; step3 → last trade of step2', () => {
    expect(wizardReducer({ step: 2, tradeIdx: 0, queue: ['roofing', 'gutters'], selectedTrades: [] }, { type: 'back' }))
      .toMatchObject({ step: 1, tradeIdx: 0 });
    expect(wizardReducer({ step: 2, tradeIdx: 1, queue: ['roofing', 'gutters'], selectedTrades: [] }, { type: 'back' }))
      .toMatchObject({ step: 2, tradeIdx: 0 });
    expect(wizardReducer({ step: 3, tradeIdx: 0, queue: ['roofing', 'gutters'], selectedTrades: [] }, { type: 'back' }))
      .toMatchObject({ step: 2, tradeIdx: 1 });
  });

  it('goto sets step + tradeIdx directly', () => {
    expect(wizardReducer(base(), { type: 'goto', step: 2, tradeIdx: 1 })).toMatchObject({ step: 2, tradeIdx: 1 });
  });
});
