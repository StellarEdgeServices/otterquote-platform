/**
 * gh-2105 batch 11 -- static-page zero-row-update guards on two legal/money
 * client sites that have no other test coverage:
 *
 *  1. contract-signing.html: the two role-aware signature-stamp writes
 *     (quotes.<role>_signed_at) after the BoldSign embed finishes. The
 *     docusign-webhook is the source of truth for these stamps, so a zero-row
 *     match is log-only (console.warn) -- it must not throw or alert the
 *     signer, and no new user-facing text is added.
 *  2. contractor-bid-form.html: the change/renew-bid quotes update (total_price,
 *     fees, warranty, renewal window). A silent miss shows the contractor a
 *     "Bid updated" success screen while the price the homeowner sees never
 *     changed. Decision (a): chain .select('id') and throw
 *     'bid_update_zero_rows', exactly as the React twin
 *     (react-app/app/contractor/bid/[claimId]/bid-form.tsx, batch 6) already
 *     does; the page's existing catch surfaces it through its existing
 *     'Error submitting bid: ' alert. No new string.
 *
 * FAIL-FIRST: run against origin/main's (pre-batch-11) pages -- none of the
 * sites chains .select('id') and neither zero-row branch exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

describe('contract-signing.html signature-stamp writes (gh-2105 batch 11)', () => {
  const src = read('contract-signing.html');
  const start = src.indexOf("const _signedField = state.signRole === 'contractor'");
  const end = src.indexOf("// fix4 (CEO ruling, PR #1979 comment 5698878146)", start);
  const block = src.slice(start, end);

  it('locates the stamp block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('both quotes updates chain .select(\'id\')', () => {
    const updates = block.split(".update({ [_signedField]").length - 1;
    expect(updates).toBe(2);
    expect(block.split(".select('id')").length - 1).toBe(2);
  });

  it('a zero-row match is logged via console.warn and never thrown', () => {
    expect(block.split('console.warn').length - 1).toBeGreaterThanOrEqual(2);
    expect(block).toContain('gh-2105');
    expect(block).not.toMatch(/throw\s/);
  });

  it('existing error logging is unchanged', () => {
    expect(block).toContain("console.error('Error updating ' + _signedField + ':', quoteErr);");
  });
});

describe('contractor-bid-form.html change/renew bid update (gh-2105 batch 11)', () => {
  const src = read('contractor-bid-form.html');
  const start = src.indexOf('if (changeBidMode && existingQuote) {');
  const end = src.indexOf("await sb.from('notifications').insert({", start);
  const block = src.slice(start, end);

  it('locates the change-bid block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("chains .select('id') on the quotes update", () => {
    expect(block).toContain(".eq('id', existingQuote.id)\n              .select('id')");
  });

  it('throws bid_update_zero_rows on a zero-row match, after the existing error check', () => {
    const errIdx = block.indexOf('if (updateError) throw updateError;');
    const zeroIdx = block.indexOf("bid_update_zero_rows");
    expect(errIdx).toBeGreaterThan(-1);
    expect(zeroIdx).toBeGreaterThan(errIdx);
    expect(block).toMatch(/throw new Error\('bid_update_zero_rows/);
  });

  it("surfaces through the page's existing 'Error submitting bid: ' alert (no new copy)", () => {
    expect(src).toContain("alert('Error submitting bid: ' + (err.message || 'Unknown error'));");
  });
});
