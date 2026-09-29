/**
 * gh-2105 batch 7 -- admin-cpa.html's CPA (contractor participation
 * agreement) publish flow has two `.update()` writes with no `.select()`.
 * `admin-cpa.html` has no React twin (there is no D-211 migration of this
 * page), so -- following gh2105-admin-fee-config-html-zero-row.test.ts's
 * established source-guard convention for un-migrated static admin
 * pages -- this reads it as text and asserts the fix's wiring is present.
 *
 * Both sites are deliberately handled differently:
 *   1. Step 1 (`cpa_versions.is_current=false`) is decision (b): a zero-row
 *      match is the EXPECTED, normal outcome on the very first-ever CPA
 *      publish (no row has is_current=true yet) -- annotated
 *      `update-no-select-ok`, not selected/thrown.
 *   2. Step 3 (`contractors.needs_cpa_reattestation=true`) is decision
 *      (a)-with-alert: a zero-row match can also be legitimate (every
 *      active/pending contractor already carries the new label) but can
 *      also mean the filter matched nothing while contractors DO still
 *      need re-attestation, so it is not thrown (must not block the CPA
 *      version itself from publishing) but IS surfaced via console.warn.
 *
 * FAIL-FIRST: run against origin/k72/gh2105-batch6's (pre-batch-7)
 * admin-cpa.html -- Step 1 has no `update-no-select-ok` annotation and
 * Step 3 has no `.select('id')` / zero-row warning. Both assertions below
 * fail there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// react-app/app/test -> repo root is 3 levels up.
const repoRoot = resolve(here, '..', '..', '..');
const htmlSrc = readFileSync(resolve(repoRoot, 'admin-cpa.html'), 'utf8');

describe('admin-cpa.html source guards', () => {
  it('publishes a CPA version via cpa_versions and contractors writes', () => {
    expect(htmlSrc).toContain("from('cpa_versions')");
    expect(htmlSrc).toContain("from('contractors')");
    expect(htmlSrc).toContain('needs_cpa_reattestation: true');
  });

  it('gh-2105 (decision b): the is_current deactivation is annotated update-no-select-ok, not selected', () => {
    const idxDeactivate = htmlSrc.indexOf(".update({ is_current: false })");
    expect(idxDeactivate).toBeGreaterThan(-1);
    const line = htmlSrc.slice(idxDeactivate, htmlSrc.indexOf('\n', idxDeactivate));
    expect(line).toContain('update-no-select-ok');
  });

  it('gh-2105 (decision a-with-alert, legal): the bulk re-attestation flag chains .select() and warns on a zero-row match', () => {
    const idxFlag = htmlSrc.indexOf(".update({ needs_cpa_reattestation: true })");
    const idxToast = htmlSrc.indexOf('showToast(`✅ CPA', idxFlag);
    expect(idxFlag).toBeGreaterThan(-1);
    expect(idxToast).toBeGreaterThan(idxFlag);
    const block = htmlSrc.slice(idxFlag, idxToast);
    expect(block).toContain(".select('id')");
    expect(block).toContain('console.warn');
    expect(block).toContain('gh-2105');
    // The zero-row branch itself must not throw -- a genuinely
    // zero-contractors-flagged outcome is legitimate and must not block the
    // CPA version publish. Only the real database-error branch (flagErr)
    // throws; the zero-row check is a separate `if` after it.
    const zeroRowIdx = block.indexOf('!Array.isArray(flagRows)');
    expect(zeroRowIdx).toBeGreaterThan(-1);
    const zeroRowBlock = block.slice(zeroRowIdx, block.indexOf('showToast', zeroRowIdx));
    expect(zeroRowBlock).not.toContain('throw');
  });
});
