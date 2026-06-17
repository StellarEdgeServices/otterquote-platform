/**
 * Unit + parity tests for Admin Platform Fee Configuration (D-211 Phase 11).
 *
 * Pins, against admin-fee-config.html @ main behavior:
 *   - TRADE_OPTIONS / FEE_BASIS_OPTIONS (exact form option lists)
 *   - feeBasisLabel, formatEffectiveDate, isDefaultRule, isLastRule
 *   - parseFeePct / isFeePctValid (UNCHANGED fee math — no rounding/rescale)
 *   - nextSortState / sortFees (sortTable comparator parity)
 *   - buildFeePayload — the form → write body is BYTE-IDENTICAL in shape/units
 *
 * Plus source-level guards on page.tsx that pin:
 *   - the supabase singleton import (audit fold: NO createClient, NO literal key)
 *   - the <RequireAdmin tier="super"> gate
 *   - the platform_fee_config read/insert/update/delete call shapes
 *
 * No network / supabase calls — all helpers are side-effect-free.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  type FeeConfigRow,
  TRADE_OPTIONS,
  FEE_BASIS_OPTIONS,
  feeBasisLabel,
  formatEffectiveDate,
  isDefaultRule,
  isLastRule,
  parseFeePct,
  isFeePctValid,
  nextSortState,
  sortFees,
  buildFeePayload,
} from '../utils';

// ── Fixture ──────────────────────────────────────────────────────────────────

function mkRow(over: Partial<FeeConfigRow> = {}): FeeConfigRow {
  return {
    id: over.id ?? 'f-1',
    state: over.state ?? null,
    trade: over.trade ?? null,
    fee_pct: over.fee_pct ?? 10,
    fee_basis: over.fee_basis ?? 'bid_amount',
    effective_date: over.effective_date ?? '2026-01-01',
    ...over,
  };
}

// ── Form option lists ──────────────────────────────────────────────────────

describe('TRADE_OPTIONS', () => {
  it('exposes the exact values in static-page order (All Trades first)', () => {
    expect(TRADE_OPTIONS.map((o) => o.value)).toEqual([
      '',
      'Roofing',
      'Siding',
      'Windows',
      'Gutters',
      'Painting',
      'Decking',
      'HVAC',
      'Plumbing',
      'Electrical',
    ]);
  });

  it('the empty value is labelled "All Trades"', () => {
    expect(TRADE_OPTIONS[0]).toEqual({ value: '', label: 'All Trades' });
  });
});

describe('FEE_BASIS_OPTIONS', () => {
  it('exposes only bid_amount → "Bid Amount" (the single static option)', () => {
    expect(FEE_BASIS_OPTIONS).toEqual([{ value: 'bid_amount', label: 'Bid Amount' }]);
  });
});

// ── feeBasisLabel ─────────────────────────────────────────────────────────────

describe('feeBasisLabel', () => {
  it('"bid_amount" → "Bid Amount"', () => {
    expect(feeBasisLabel('bid_amount')).toBe('Bid Amount');
  });

  it('any other value passes through unchanged', () => {
    expect(feeBasisLabel('flat_fee')).toBe('flat_fee');
    expect(feeBasisLabel('')).toBe('');
  });
});

// ── formatEffectiveDate ───────────────────────────────────────────────────────

describe('formatEffectiveDate', () => {
  it('matches new Date(value).toLocaleDateString() (locale default, no options)', () => {
    const value = '2026-06-17';
    // Assert against the same call to avoid TZ/locale-dependent hardcoding,
    // while still pinning that NO options object is passed (static parity).
    expect(formatEffectiveDate(value)).toBe(new Date(value).toLocaleDateString());
  });
});

// ── isDefaultRule ─────────────────────────────────────────────────────────────

describe('isDefaultRule', () => {
  it('null state AND null trade → true', () => {
    expect(isDefaultRule({ state: null, trade: null })).toBe(true);
  });

  it('empty-string state AND trade → true (both falsy)', () => {
    expect(isDefaultRule({ state: '', trade: '' })).toBe(true);
  });

  it('a state present → false', () => {
    expect(isDefaultRule({ state: 'OH', trade: null })).toBe(false);
  });

  it('a trade present → false', () => {
    expect(isDefaultRule({ state: null, trade: 'Roofing' })).toBe(false);
  });
});

// ── isLastRule ────────────────────────────────────────────────────────────────

describe('isLastRule', () => {
  it('count === 1 → true (Delete blocked)', () => {
    expect(isLastRule(1)).toBe(true);
  });

  it('count !== 1 → false', () => {
    expect(isLastRule(0)).toBe(false);
    expect(isLastRule(2)).toBe(false);
    expect(isLastRule(99)).toBe(false);
  });
});

// ── parseFeePct + isFeePctValid (UNCHANGED FEE MATH) ─────────────────────────

describe('parseFeePct', () => {
  it('parses a decimal percent verbatim (no rounding)', () => {
    expect(parseFeePct('15.5')).toBe(15.5);
    expect(parseFeePct('15.999')).toBe(15.999);
    expect(parseFeePct('0')).toBe(0);
    expect(parseFeePct('50')).toBe(50);
  });

  it('blank / invalid → NaN (mirrors parseFloat)', () => {
    expect(Number.isNaN(parseFeePct(''))).toBe(true);
    expect(Number.isNaN(parseFeePct('abc'))).toBe(true);
  });
});

describe('isFeePctValid', () => {
  it('boundaries 0 and 50 inclusive → true', () => {
    expect(isFeePctValid(0)).toBe(true);
    expect(isFeePctValid(50)).toBe(true);
    expect(isFeePctValid(25.5)).toBe(true);
  });

  it('out of [0,50] → false', () => {
    expect(isFeePctValid(-0.01)).toBe(false);
    expect(isFeePctValid(50.01)).toBe(false);
  });

  it('NaN → false', () => {
    expect(isFeePctValid(NaN)).toBe(false);
  });
});

// ── nextSortState ─────────────────────────────────────────────────────────────

describe('nextSortState', () => {
  it('same column flips direction', () => {
    expect(nextSortState({ column: 'state', ascending: true }, 'state')).toEqual({
      column: 'state',
      ascending: false,
    });
    expect(nextSortState({ column: 'state', ascending: false }, 'state')).toEqual({
      column: 'state',
      ascending: true,
    });
  });

  it('new column resets to ascending', () => {
    expect(nextSortState({ column: 'state', ascending: false }, 'fee_pct')).toEqual({
      column: 'fee_pct',
      ascending: true,
    });
  });
});

// ── sortFees ──────────────────────────────────────────────────────────────────

describe('sortFees', () => {
  const rows: FeeConfigRow[] = [
    mkRow({ id: 'a', state: 'OH', fee_pct: 20 }),
    mkRow({ id: 'b', state: 'in', fee_pct: 5 }), // lowercase → case-insensitive check
    mkRow({ id: 'c', state: null, fee_pct: 12.5 }), // null → '' sorts first ascending
  ];

  it('sorts by state ascending (null → "" first, case-insensitive)', () => {
    expect(sortFees(rows, 'state', true).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts by state descending', () => {
    expect(sortFees(rows, 'state', false).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by fee_pct numerically ascending', () => {
    expect(sortFees(rows, 'fee_pct', true).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by fee_pct numerically descending', () => {
    expect(sortFees(rows, 'fee_pct', false).map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('returns a NEW array and does not mutate the input', () => {
    const before = rows.map((r) => r.id);
    const out = sortFees(rows, 'fee_pct', true);
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

// ── buildFeePayload (BYTE-IDENTICAL WRITE CONTRACT) ──────────────────────────

describe('buildFeePayload', () => {
  it('builds the exact static-page write body with all fields present', () => {
    const payload = buildFeePayload({
      state: 'OH',
      trade: 'Roofing',
      feePct: 15.5,
      feeBasis: 'bid_amount',
      effectiveDate: '2026-06-17',
    });
    expect(payload).toEqual({
      state: 'OH',
      trade: 'Roofing',
      fee_pct: 15.5,
      fee_basis: 'bid_amount',
      effective_date: '2026-06-17',
    });
  });

  it('blank state / trade coerce to null (value || null)', () => {
    const payload = buildFeePayload({
      state: '',
      trade: '',
      feePct: 10,
      feeBasis: 'bid_amount',
      effectiveDate: '2026-06-17',
    });
    expect(payload.state).toBeNull();
    expect(payload.trade).toBeNull();
  });

  it('emits EXACTLY the 5 contract keys — no notes/created_at/updated_at', () => {
    const payload = buildFeePayload({
      state: 'IN',
      trade: 'HVAC',
      feePct: 12,
      feeBasis: 'bid_amount',
      effectiveDate: '2026-01-01',
    });
    expect(Object.keys(payload).sort()).toEqual(
      ['effective_date', 'fee_basis', 'fee_pct', 'state', 'trade'].sort(),
    );
  });

  it('fee_pct is forwarded VERBATIM — never rounded, rescaled, or basis-point converted', () => {
    // 15.5 percent must stay 15.5 — NOT 1550 (bps), NOT 0.155 (decimal fraction).
    expect(buildFeePayload({ state: '', trade: '', feePct: 15.5, feeBasis: 'bid_amount', effectiveDate: 'd' }).fee_pct).toBe(15.5);
    expect(buildFeePayload({ state: '', trade: '', feePct: 7, feeBasis: 'bid_amount', effectiveDate: 'd' }).fee_pct).toBe(7);
    expect(buildFeePayload({ state: '', trade: '', feePct: 0.5, feeBasis: 'bid_amount', effectiveDate: 'd' }).fee_pct).toBe(0.5);
    expect(buildFeePayload({ state: '', trade: '', feePct: 12.375, feeBasis: 'bid_amount', effectiveDate: 'd' }).fee_pct).toBe(12.375);
  });
});

// ── Source-level guards on page.tsx ──────────────────────────────────────────
// These pin the audit fold (anon-key), the super-gate, and the
// platform_fee_config call shapes without mounting the page (which would require
// supabase env + router + auth context — the established Phase-8+ test approach).

describe('page.tsx source guards', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pageSrc = readFileSync(resolve(here, '..', 'page.tsx'), 'utf8');

  it('imports the shared supabase singleton', () => {
    expect(pageSrc).toContain("from '@/lib/supabase'");
    expect(pageSrc).toContain('import { supabase }');
  });

  it('audit fold: no direct supabase-js import, no hardcoded anon key, no bogus project ref', () => {
    // The only module allowed to import the SDK / call createClient is the
    // singleton — a page importing it would mean a rogue client.
    expect(pageSrc).not.toContain('@supabase/supabase-js');
    // No hardcoded JWT literal (the static page's bogus anon key).
    expect(pageSrc).not.toMatch(/eyJ[A-Za-z0-9_.-]{20,}/);
    // No reference to the wrong/nonexistent static project ref.
    expect(pageSrc).not.toContain('yeszghaspz');
  });

  it('gates on <RequireAdmin tier="super">', () => {
    expect(pageSrc).toContain('tier="super"');
    expect(pageSrc).toContain('RequireAdmin');
  });

  it('reads/writes platform_fee_config with the static call shapes', () => {
    expect(pageSrc).toContain("from('platform_fee_config')");
    expect(pageSrc).toContain("order('state', { ascending: true, nullsFirst: false })");
    expect(pageSrc).toContain("order('trade', { ascending: true, nullsFirst: false })");
    expect(pageSrc).toContain('.insert([payload])'); // array-wrapped, like static .insert([data])
    expect(pageSrc).toContain('.update(payload)');
    expect(pageSrc).toContain('.delete()');
    expect(pageSrc).toContain(".eq('id', editingId)");
    expect(pageSrc).toContain(".eq('id', deletingId)");
  });
});
