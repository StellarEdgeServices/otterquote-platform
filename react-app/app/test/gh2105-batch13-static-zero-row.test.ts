/**
 * gh-2105 batch 13 -- zero-row `.update()` guards on admin-measurements.html (the three
 * writes that deliver the paid measurement upgrade) plus the two decision-(b) annotations
 * on the platform_alerts_log acknowledge writes. Same source-guard convention as
 * gh2105-batch12-static-zero-row.test.ts (the page has no runnable harness), plus a
 * behavioural check of the page's own `rowsWritten` helper extracted from the HTML.
 *
 * FAIL-FIRST: against origin/main's admin-measurements.html none of the three updates chains
 * .select('id') and `rowsWritten` does not exist, so every assertion below fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

function block(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('admin-measurements.html (gh-2105 batch 13)', () => {
  const src = read('admin-measurements.html');
  // Pull the page's own helper out of the HTML and run it, so the behaviour is tested, not just the text.
  const helperSrc = block(src, 'function rowsWritten(res) {', '\nasync function saveFulfillment');
  const rowsWritten = new Function(`${helperSrc}; return rowsWritten;`)() as (r: unknown) => boolean;

  it('NEGATIVE CONTROL: rowsWritten is false for error:null with zero rows, and for null/undefined data', () => {
    expect(rowsWritten({ data: [], error: null })).toBe(false);
    expect(rowsWritten({ data: null, error: null })).toBe(false);
    expect(rowsWritten({ error: null })).toBe(false);
    expect(rowsWritten(undefined)).toBe(false);
  });
  it('rowsWritten is true only when a row came back with no error', () => {
    expect(rowsWritten({ data: [{ id: 'o1' }], error: null })).toBe(true);
    expect(rowsWritten({ data: [{ id: 'o1' }], error: { message: 'x' } })).toBe(false);
  });

  it('hover_orders save: .select(id), error check, then a zero-row throw into the existing catch', () => {
    const b = block(src, "var upd = await sb.from('hover_orders')", 'Mirror onto the claim');
    expect(b).toContain(".eq('id', row.id).select('id')");
    expect(b).toContain('if (upd.error) throw');
    expect(b).toMatch(/if \(!rowsWritten\(upd\)\) throw new Error\('zero_rows_updated: hover_orders/);
  });
  it('claim measurement mirror: .select(id) and a zero-row throw with the existing "Order saved, but" prefix', () => {
    const b = block(src, "var cUpd = await sb.from('claims')", 'gh-1411 / D-317');
    expect(b).toContain(".eq('id', row.claim_id).select('id')");
    expect(b).toMatch(/if \(!rowsWritten\(cUpd\)\) throw new Error\('Order saved, but writing measurements to the claim failed: zero_rows_updated/);
  });
  it('measurement_shape flip (the paid upgrade): zero rows takes the same alert path as an error', () => {
    const b = block(src, "var shapeUpd = await sb.from('claims')", 'gh-1412');
    expect(b).toContain(".eq('id', row.claim_id).select('id')");
    expect(b).toMatch(/else if \(!rowsWritten\(shapeUpd\)\) \{[\s\S]*alert\('Order delivered, but marking the claim as fully detailed failed/);
  });
  it('no un-selected .update( is left in the page', () => {
    for (const line of src.split('\n')) {
      if (line.includes('.update(') && !line.trim().startsWith('//')) expect(line).toContain(".select('id')");
    }
  });
});

describe('platform_alerts_log acknowledge writes are annotated decision (b) (gh-2105 batch 13)', () => {
  for (const f of ['admin-contractors.html', 'react-app/app/admin/contractors/page.tsx']) {
    it(f, () => {
      const lines = read(f).split('\n');
      const i = lines.findIndex((l) => l.includes(".update({ acknowledged_at:"));
      expect(i).toBeGreaterThan(0);
      expect(lines[i - 1]).toContain('update-no-select-ok');
      expect(lines[i - 1]).toContain("is('acknowledged_at', null)");
    });
  }
});
