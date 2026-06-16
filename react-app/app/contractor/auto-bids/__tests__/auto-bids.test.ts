/**
 * Parity + unit tests for contractor Auto-Bid Settings (D-211 Phase 3).
 * Exercises the ported load/save/preview logic against contractor-auto-bids.html:
 * the default form, the exact `contractors` save payload, the hydrate↔payload
 * round-trip (load == save), and the "what the homeowner sees" preview builder.
 * The contractors-table update + the (shell-tested) CPA guard live in the page.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyAutoBidForm, hydrateAutoBidForm, buildAutoBidPayload, buildBidPreview,
  type AutoBidForm,
} from '../utils';
import { OTHER_SHINGLE_BRANDS, WARRANTY_ROWS, OTHER_TRADES_OPTIONS } from '../copy';
import { CURRENT_CPA_VERSION } from '../../_shell/cpa-guard';

describe('emptyAutoBidForm defaults (match the static `checked` defaults)', () => {
  it('uses the static radio/select defaults and everything off', () => {
    const f = emptyAutoBidForm();
    expect(f.autoBidEnabled).toBe(false);
    expect(f.gutterOption).toBe('none');
    expect(f.chimneyFlashing).toBe('na');
    expect(f.gutterGuards).toBe('insurance_covered');
    expect(f.gutterGuardType).toBe('mesh');
    expect(f.chimneyReflash).toBe('na');
    expect(f.underlayment).toBe('synthetic');
    expect(f.starterStrip).toBe('eaves');
    expect(f.otherShingles).toEqual([]);
    expect(f.otherTrades).toEqual([]);
    expect(Object.values(f.warranty).every((w) => w.offered === false && w.description === '')).toBe(true);
  });
});

describe('buildAutoBidPayload (exact contractors update shape)', () => {
  it('emits the constant auto_bid_settings + defaulted value_adds with nulls', () => {
    const p = buildAutoBidPayload(emptyAutoBidForm(), '2026-06-15T00:00:00.000Z');
    expect(p.auto_bid_enabled).toBe(false);
    expect(p.auto_bid_settings).toEqual({ funding_type: 'insurance', scope: 'full_replacement', trade: 'roofing', pricing: 'rcv' });
    expect(p.updated_at).toBe('2026-06-15T00:00:00.000Z');
    const va = p.auto_bid_value_adds;
    expect(va.gutters).toEqual({ option: 'none', other_text: null });
    expect(va.chimney_flashing).toBe('na');
    expect(va.gutter_guards).toEqual({ option: 'insurance_covered', type: null, other_text: null });
    expect(va.chimney_reflash).toEqual({ option: 'na', oop_price: null });
    expect(va.preferred_shingle).toEqual({ brand: null, line: null });
    expect(va.other_shingles).toEqual([]);
    expect(va.underlayment).toBe('synthetic');
    expect(va.starter_strip).toBe('eaves');
    expect(va.ventilation).toEqual({ free_ridge_vent: false, other_check: false, other_text: null });
    expect(va.warranty?.material_defects).toEqual({ offered: false, description: null });
    expect(va.warranty?.notes).toBeNull();
    expect(va.other_trades).toEqual([]);
    expect(va.review_sites).toEqual({});
  });

  it('only includes gutter/guard "other_text" + reflash oop in the matching branch', () => {
    const f = emptyAutoBidForm();
    f.gutterOption = 'other'; f.gutterOther = 'Seamless aluminum';
    f.gutterGuards = 'included'; f.gutterGuardType = 'screw_in';
    f.chimneyReflash = 'oop'; f.chimneyReflashOop = '250';
    const va = buildAutoBidPayload(f).auto_bid_value_adds;
    expect(va.gutters).toEqual({ option: 'other', other_text: 'Seamless aluminum' });
    expect(va.gutter_guards).toEqual({ option: 'included', type: 'screw_in', other_text: null });
    expect(va.chimney_reflash).toEqual({ option: 'oop', oop_price: 250 });
  });
});

describe('hydrate ↔ payload round-trip (load == save)', () => {
  function populated(): AutoBidForm {
    const f = emptyAutoBidForm();
    f.autoBidEnabled = true;
    f.gutterOption = 'other'; f.gutterOther = 'Custom';
    f.chimneyFlashing = 'replace';
    f.gutterGuards = 'included'; f.gutterGuardType = 'mesh';
    f.chimneyReflash = 'oop'; f.chimneyReflashOop = '300';
    f.preferredShingleBrand = 'GAF'; f.preferredShingleLine = 'Timberline HDZ';
    f.otherShingles = ['GAF|Timberline HDZ', 'CertainTeed|Landmark Pro'];
    f.underlayment = 'felt'; f.starterStrip = 'eaves_and_rakes';
    f.ventRidgeUpgrade = true; f.ventOtherCheck = true; f.ventOtherText = 'Extra intake vents';
    f.freeAtticInspection = true; f.otherServices = 'Drone photos';
    f.cleanupGuarantee = 'Magnetic sweep';
    f.propEquipter = true; f.propCatchAll = true; f.propOtherCheck = true; f.propOtherText = 'Plywood';
    f.warranty.materialDefects = { offered: true, description: '30-year' };
    f.warranty.labor = { offered: true, description: '10-year workmanship' };
    f.warrantyNotes = 'Transferable once';
    f.otherOffers = '0% financing';
    f.otherTrades = ['siding_full', 'paint'];
    return f;
  }
  it('a populated form survives save→load unchanged', () => {
    const f = populated();
    const p = buildAutoBidPayload(f);
    const back = hydrateAutoBidForm(p.auto_bid_enabled, p.auto_bid_value_adds);
    expect(back).toEqual(f);
  });
  it('the empty form survives save→load unchanged', () => {
    const f = emptyAutoBidForm();
    const p = buildAutoBidPayload(f);
    expect(hydrateAutoBidForm(p.auto_bid_enabled, p.auto_bid_value_adds)).toEqual(f);
  });
  it('hydrate accepts a JSON string (static stores value_adds as json)', () => {
    const f = populated();
    const p = buildAutoBidPayload(f);
    const back = hydrateAutoBidForm(true, JSON.stringify(p.auto_bid_value_adds));
    expect(back).toEqual(f);
  });
  it('missing value_adds yields the default form', () => {
    expect(hydrateAutoBidForm(undefined, null)).toEqual(emptyAutoBidForm());
    expect(hydrateAutoBidForm(null, 'not json')).toEqual(emptyAutoBidForm());
  });
});

describe('buildBidPreview (what the homeowner sees)', () => {
  it('defaults still surface the insurance-covered gutter-guard line', () => {
    const pv = buildBidPreview(emptyAutoBidForm(), null);
    expect(pv.companyName).toBe('Your Company');
    expect(pv.includes).toEqual(['🛡 Gutter Guards: As covered by insurance or paid for by homeowner']);
    expect(pv.warranty).toEqual([]);
    expect(pv.warrantyDisclaimer).toBeNull();
  });
  it('assembles includes + warranty from the form and names the company', () => {
    const f = emptyAutoBidForm();
    f.preferredShingleBrand = 'GAF'; f.preferredShingleLine = 'Timberline HDZ';
    f.gutterOption = '6inch_included';
    f.gutterGuards = 'included'; f.gutterGuardType = 'mesh';
    f.ventRidgeUpgrade = true;
    f.otherTrades = ['siding_full'];
    f.warranty.hail = { offered: true, description: 'Class 4' };
    const pv = buildBidPreview(f, { company_name: 'Acme Roofing' });
    expect(pv.companyName).toBe('Acme Roofing');
    expect(pv.includes).toContain('🏗 Preferred Shingle: GAF — Timberline HDZ');
    expect(pv.includes).toContain('✅ 6" Gutters Included');
    expect(pv.includes).toContain('✅ Gutter Guards Included (mesh)');
    expect(pv.includes).toContain('✅ Free Ridge Vent Upgrade');
    expect(pv.includes).toContain('🏠 Other Trades (if covered by insurance): Siding (full replace)');
    expect(pv.warranty).toEqual(['🌨 Hail: Class 4']);
    expect(pv.warrantyDisclaimer).toBe('* Warranty terms apply only to GAF Timberline HDZ. Different warranty terms may apply to other shingles.');
  });
});

describe('copy catalogs + shell reuse', () => {
  it('exposes the full shingle/trade/warranty catalogs', () => {
    const allShingles = OTHER_SHINGLE_BRANDS.flatMap((b) => b.items);
    expect(allShingles.length).toBe(36); // GAF7 + OC6 + CT7 + Atlas4 + Malarkey4 + IKO4 + TAMKO4
    expect(OTHER_SHINGLE_BRANDS.map((b) => b.brand)).toEqual(['GAF', 'Owens Corning', 'CertainTeed', 'Atlas', 'Malarkey', 'IKO', 'TAMKO']);
    expect(WARRANTY_ROWS.map((r) => r.key)).toEqual(['materialDefects', 'labor', 'algae', 'hail', 'wind']);
    expect(OTHER_TRADES_OPTIONS.map((o) => o.value)).toContain('siding_full');
  });
  it('reuses the shared CPA version constant (no re-declare)', () => {
    expect(CURRENT_CPA_VERSION).toBe('v1-2026-04');
  });
});
