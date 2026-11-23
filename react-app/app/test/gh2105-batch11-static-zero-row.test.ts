/**
 * gh-2105 batch 11 -- static-page zero-row-update guards on two legal/money
 * client sites that have no other test coverage:
 *
 *  1. contract-signing.html: (gh-2864) the signature-stamp writes were REMOVED; the
 *     test now asserts the page makes none. The docusign-webhook is the only writer.
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

describe('contract-signing.html makes no signature-stamp write (gh-2864, supersedes gh-2105 batch 11 site 1)', () => {
  // gh-2864: quotes.contractor_signed_at / homeowner_signed_at are platform-only
  // (trigger quotes_refuse_client_signature_change). The page used to write them
  // after the embed finished; the docusign-webhook (service_role) is the only writer.
  const src = read('contract-signing.html');
  const start = src.indexOf('async function onSigningComplete()');
  const end = src.indexOf('// \u2500\u2500 Navigate to Step', start);
  const block = src.slice(start, end);

  it('locates onSigningComplete', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('onSigningComplete issues no quotes update and names no signature column in a write', () => {
    expect(block).not.toContain('_signedField');
    expect(block).not.toMatch(/\.update\(/);
    expect(block).not.toMatch(/\.from\(['"]quotes['"]\)/);
  });

  it('no .update() anywhere in the page writes a signature stamp', () => {
    expect(src).not.toMatch(/\.update\(\s*\{[^}]*(homeowner|contractor)_signed_at/);
    expect(src).not.toContain('[_signedField]');
  });

  it('still reads the stamps (recheckSigningState and the init gate)', () => {
    expect(src).toContain("contractor_signed_at, homeowner_signed_at, docusign_envelope_id");
  });
});

describe('contractor-bid-form.html change/renew bid update (gh-2105 batch 11)', () => {
  const src = read('contractor-bid-form.html');
  const start = src.indexOf('if (changeBidMode && existingQuote) {');
  // gh-3880: the homeowner notice is no longer a client-side notifications insert (RLS 42501 for a contractor session); it is the
  // notify_homeowner_bid_updated RPC, wrapped in callWithTimeout(..., withAbortSignal(...)), so match the call itself
  const end = src.indexOf("sb.rpc('notify_homeowner_bid_updated'", start);
  const block = src.slice(start, end);

  it('locates the change-bid block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("chains .select('id') on the quotes update", () => {
    // Whitespace/line-break tolerant: the chain may sit on one line or several.
    expect(block).toMatch(/\.eq\(\s*'id'\s*,\s*existingQuote\.id\s*\)\s*\.select\(\s*'id'\s*\)/);
  });

  it('throws bid_update_zero_rows on a zero-row match, after the existing error check', () => {
    const errIdx = block.indexOf('if (updateError) throw updateError;');
    const zeroIdx = block.indexOf("bid_update_zero_rows");
    expect(errIdx).toBeGreaterThan(-1);
    expect(zeroIdx).toBeGreaterThan(errIdx);
    expect(block).toMatch(/throw new Error\('bid_update_zero_rows/);
  });

  it('sends the homeowner notice through the notify_homeowner_bid_updated RPC, not a client notifications insert', () => {
    expect(end).toBeGreaterThan(start);
    expect(src).toContain("sb.rpc('notify_homeowner_bid_updated', { p_quote_id: existingQuote.id })");
    expect(src).not.toMatch(/sb\.from\(['"]notifications['"]\)\.insert\(\{\s*user_id:\s*currentClaim\.user_id/);
  });

  it('reads the RPC result: supabase-js returns {error} and does not throw, and false means refused', () => {
    const tail = src.slice(end - 300, end + 700);
    expect(tail).toMatch(/const \{ data: _notifOk, error: _notifErr \} = await/);
    expect(tail).toMatch(/_notifErr \|\| _notifOk === false/);
    expect(tail).toContain('non-fatal');
  });

  it("surfaces through the page's existing 'Error submitting bid: ' alert (no new copy)", () => {
    expect(src).toContain("alert('Error submitting bid: ' + (err.message || 'Unknown error'));");
  });
});
