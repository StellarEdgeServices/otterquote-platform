/**
 * gh-2105 batch 12 -- zero-row `.update()` guards on four static client pages:
 * contractor-settings.html, admin-referrals.html, dashboard.html and
 * contractor-dashboard.html. Same source-guard convention as
 * gh2105-batch11-static-zero-row.test.ts (these pages have no runnable harness).
 *
 * Decision (a): chain .select('id'), treat an empty result as a failure and
 * route it through the page's EXISTING failure handling (no new copy).
 * Decision (b): `update-no-select-ok:` annotation with the reason.
 * Log-only: dashboard.html best-effort writes (console.warn, no UI change).
 *
 * FAIL-FIRST: run against origin/main's pages -- none of these sites chains
 * .select('id') and no annotation or zero-row branch exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

/** Slice from `startMarker` to the first `endMarker` after it. */
function block(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('contractor-settings.html (gh-2105 batch 12)', () => {
  const src = read('contractor-settings.html');

  it('payment-method default/promote/clear writes select id and assert a row was written', () => {
    const b = block(src, 'window.setDefaultMethod = async function', 'await loadPaymentMethods();\n        gtag(');
    expect(b.split("assertRowsWritten(await sb").length - 1).toBe(5);
    expect(b.split(".select('id')").length - 1).toBe(5);
  });

  it('assertRowsWritten throws on an error or an empty result', () => {
    const b = block(src, 'function assertRowsWritten', 'window.setDefaultMethod');
    expect(b).toContain('throw res.error');
    expect(b).toContain('res.data.length === 0');
    expect(b).toContain('zero_rows_updated');
  });

  it('clearing the old defaults is annotated decision (b) directly above the .update(', () => {
    const idx = src.indexOf('.update({ is_default: false })');
    expect(idx).toBeGreaterThan(-1);
    const prevLine = src.slice(0, idx).split('\n').slice(-2)[0];
    expect(prevLine).toContain('update-no-select-ok');
  });

  it('template upload, field-mapping and settings saves throw on zero rows into their existing catches', () => {
    expect(block(src, "const { data: updatedRows, error: updateError }", 'contractorRecord.contract_templates = updatedTemplates;'))
      .toContain("throw new Error('zero_rows_updated: contractors.contract_templates')");
    expect(block(src, 'const { data: mappedRows, error }', "statusEl.textContent = '\\u2705"))
      .toContain('zero_rows_updated');
    expect(block(src, 'const { data: savedRows, error }', 'Object.assign(contractorRecord, settings);'))
      .toContain('zero_rows_updated');
  });

  it('existing failure strings are unchanged', () => {
    expect(src).toContain("alert('Error setting default payment method. Please try again.');");
    expect(src).toContain("alert('Error removing payment method. Please try again.');");
    expect(src).toContain("alert('Failed to upload template. Please try again.');");
    expect(src).toContain("statusEl.textContent = 'Error saving. Please try again.';");
  });
});

describe('admin-referrals.html (gh-2105 batch 12)', () => {
  const src = read('admin-referrals.html');

  it.each([
    ['verifyW9', 'w9Rows', 'Error verifying W-9: '],
    ['manualUnblock', 'unblockRows', 'Error unblocking partner: '],
    ['changeAgentType', 'typeRows', 'Error changing partner type: '],
  ])('%s selects id and routes a zero-row match to the existing error toast', (fn, rowsVar, toast) => {
    const b = block(src, `async function ${fn}(`, 'await loadPartners();');
    expect(b).toContain(".select('id')");
    expect(b).toContain(`!Array.isArray(${rowsVar}) || ${rowsVar}.length === 0`);
    expect(b).toContain(toast);
    // the success toast comes after the error return
    expect(b.indexOf('if (error) {')).toBeGreaterThan(-1);
  });
});

describe('dashboard.html (gh-2105 batch 12)', () => {
  const src = read('dashboard.html');

  it('submitForBids throws on zero rows into the existing catch (no success state)', () => {
    const b = block(src, 'const { data: submittedRows, error } = await sb', "// Notify contractors via Edge Function (non-fatal)");
    expect(b).toContain(".select('id')");
    expect(b).toContain("throw new Error('zero_rows_updated: claims submit-for-bids')");
    expect(src).toContain("showError('Failed to submit your project. Please try again.');");
  });

  it('waitlisted status write keeps its literal, selects id and is log-only', () => {
    const b = block(src, ".update({ status: 'waitlisted' })", 'window.saveWaitlistSpot');
    expect(b).toContain(".select('id')");
    expect(b).toContain('console.warn');
    expect(b).not.toMatch(/throw\s/);
  });

  it('adjuster_id link is log-only', () => {
    const b = block(src, '.update({ adjuster_id: adjData })', 'currentClaim.adjuster_id = adjData;');
    expect(b).toContain(".select('id')");
    expect(b).toContain('console.warn');
    expect(b).not.toMatch(/throw\s/);
  });

  it('the document-upload claims write still selects (scanner false positive reworded)', () => {
    const b = block(src, '[updateField]: true,', 'if (updateError) throw updateError;');
    expect(b).toContain(".select('id')");
    expect(b).toContain('.single()');
  });
});

describe('contractor-dashboard.html (gh-2105 batch 12)', () => {
  const src = read('contractor-dashboard.html');

  it('agreement acceptance treats zero rows as the existing failure branch', () => {
    const b = block(src, 'const { data: acceptedRows, error: acceptErr }', 'location.reload();');
    expect(b).toContain(".select('id')");
    expect(b).toContain('acceptedRows.length === 0');
    expect(src).toContain("alert('Error accepting agreement. Please try again.');");
  });

  it('CPA re-acceptance treats zero rows as the existing failure branch', () => {
    const b = block(src, 'const { data: cpaRows, error: cpaWriteErr }', "// 2. Record server-side IP");
    expect(b).toContain(".select('id')");
    expect(b).toContain('const updateErr = cpaWriteErr ||');
    expect(b).toContain("alert('Error saving agreement acceptance. Please try again.');");
  });

  it('dunning retry throws on zero rows into the existing catch', () => {
    const b = block(src, 'const { data: dunningRows, error } = await sb', 'const banner = document.getElementById(\'dunningAlertBanner\');');
    expect(b).toContain(".select('id')");
    expect(b).toContain("throw new Error('zero_rows_updated: payment_failures.dunning_status')");
  });

  it('notification dismiss is annotated decision (b) directly above the .update(', () => {
    const idx = src.indexOf(".update({ read_at: new Date().toISOString() })");
    expect(idx).toBeGreaterThan(-1);
    const prevLine = src.slice(0, idx).split('\n').slice(-2)[0];
    expect(prevLine).toContain('update-no-select-ok');
  });
});
