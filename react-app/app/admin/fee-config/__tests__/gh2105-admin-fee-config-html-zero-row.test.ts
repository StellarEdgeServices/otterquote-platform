/**
 * gh-2105 batch 6 -- admin-fee-config.html is the un-migrated HTML twin of
 * this same directory's page.tsx (see fee-config.test.ts's own "gh-2105"
 * test for the React side). Both pages' `platform_fee_config` fee-rule
 * update had no `.select()`, so a zero-row RLS/id-mismatch match reported
 * "Fee rule updated successfully" while the platform fee percentage every
 * contractor's bid disclosure is computed from never actually changed.
 *
 * This file can't be imported (it's a raw static HTML page with an inline
 * <script>, not a module), so — following the project's established
 * source-guard convention (see fee-config.test.ts's own page.tsx guards) —
 * this reads it as text and asserts the fix's wiring is present.
 *
 * FAIL-FIRST: run against main's (pre-batch-6) admin-fee-config.html --
 * `.update(data).eq('id', currentEditingId)` has no `.select('id')` chained
 * and there is no currentEditingId-guarded zero-row throw. Both assertions
 * below fail there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// react-app/app/admin/fee-config/__tests__ -> repo root is 5 levels up.
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const htmlSrc = readFileSync(resolve(repoRoot, 'admin-fee-config.html'), 'utf8');

describe('admin-fee-config.html source guards', () => {
  it('reads/writes platform_fee_config with the same call shapes as the React twin', () => {
    expect(htmlSrc).toContain("from('platform_fee_config')");
    expect(htmlSrc).toContain('.update(data)');
    expect(htmlSrc).toContain('.insert([data])');
  });

  it('gh-2105 (decision a, money — HIGH PRIORITY): the fee-rule update chains .select() and throws on a zero-row match', () => {
    expect(htmlSrc).toContain(".eq('id', currentEditingId)\n                        .select('id')");
    expect(htmlSrc).toContain('gh2105_zero_rows');
    expect(htmlSrc).toContain('currentEditingId && (!Array.isArray(result.data) || result.data.length === 0)');
  });

  it('mutation control: the zero-row guard is anchored to the update branch, not the insert branch', () => {
    const updateIdx = htmlSrc.indexOf(".from('platform_fee_config')\n                        .update(data)");
    const insertIdx = htmlSrc.indexOf(".from('platform_fee_config')\n                        .insert([data]);");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(updateIdx);
    const guardIdx = htmlSrc.indexOf('gh2105_zero_rows');
    // The guard must sit between the update call and the insert branch's
    // close, i.e. it only fires for the update path.
    expect(guardIdx).toBeGreaterThan(updateIdx);
    expect(guardIdx).toBeLessThan(htmlSrc.indexOf('closeRuleModal();'));
  });
});
