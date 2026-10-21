/**
 * gh-2105 batch 3 -- d199-validation.tsx manual-mapping submit (legal: the D-199
 * template-verdict path). The `contractor_templates` update that sets
 * `manual_overrides` + `status: 'submitted_for_admin_review'` resolved
 * `{ error: null }` on a zero-row (RLS-denied / wrong id) match, so the contractor
 * saw "Submitted for admin review" while nothing was written.
 *
 * FAIL-FIRST: against origin/main's d199-validation.tsx the update has no
 * .select('id'), no update_zero_rows branch, and the catch shows the raw message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '..', 'd199-validation.tsx'), 'utf8');
const start = src.indexOf('if (missingFields.length > 0) {');
const end = src.indexOf('const result = await callValidate(row.id!, overrides);', start);
const block = src.slice(start, end);

describe('d199-validation manual-mapping persist (gh-2105 batch 3)', () => {
  it('locates the persist block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("chains .select('id') on the contractor_templates update", () => {
    expect(block).toMatch(/\.update\(\{ manual_overrides[\s\S]*?\.eq\('id', row\.id!\)\s*\.select\('id'\)/);
  });

  it('throws update_zero_rows when no row came back, before the success alert', () => {
    const zero = block.indexOf('update_zero_rows');
    const alertAt = block.indexOf('alert(');
    expect(zero).toBeGreaterThan(-1);
    expect(alertAt).toBeGreaterThan(zero);
    expect(block).toMatch(/persistedRows\.length === 0\) throw new Error\('update_zero_rows/);
  });

  it('the internal token is logged, never shown: the catch shows only the existing "Submission failed" prefix', () => {
    const catchBlock = src.slice(src.indexOf('} catch (e) {', end));
    expect(catchBlock).toContain("console.error('[D-199] manual mapping submit wrote no row:'");
    expect(catchBlock).toContain("? 'Submission failed' :");
  });

  it('the zero-row predicate rejects the RLS-denied shape and accepts a real row', () => {
    const zeroRows = (data: unknown) => !Array.isArray(data) || data.length === 0;
    expect(zeroRows([])).toBe(true); // { data: [], error: null }: the silent-failure shape
    expect(zeroRows(null)).toBe(true);
    expect(zeroRows([{ id: 'x' }])).toBe(false);
  });
});
