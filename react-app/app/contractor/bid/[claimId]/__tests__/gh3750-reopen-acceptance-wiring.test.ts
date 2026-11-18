/**
 * gh-3750 (REVIEW 6901068974 / LEGAL-READ 6901069249): source-level wiring for BOTH bid forms. Re-bidding a withdrawn bid (renew_quote 'reopen',
 * same quote id) must write a fresh fee_acceptances row after the quotes field UPDATE, once per bid, as a first submission does.
 * gh-3490 rebase: the reopen insert is now the one block shared with change/renew (condition `!reopened || not yet done`); the assertions below
 * are the same checks against that block's text (identifiers renamed in the source, intent unchanged).
 * On 8042784a neither form has it, so these fail there. Behaviour in a real browser: tests/gh3750-reopen-acceptance-chromium.mjs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const tsx = readFileSync(join(__dirname, '..', 'bid-form.tsx'), 'utf8');
const html = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'contractor-bid-form.html'), 'utf8');

describe('gh-3750 reopen writes a fresh fee acceptance', () => {
  it('HTML form: flag read before the RPC, insert after the UPDATE zero-row check, same quote id, same fee text, once', () => {
    const flag = html.indexOf("const _reopenedWithdrawnBid = _renewRpcMode === 'reopen'");
    const zero = html.indexOf('bid_update_zero_rows: no matching quote row was updated');
    const ins = html.indexOf('if (!_reopenedWithdrawnBid || existingQuote.id !== _reopenAcceptanceDoneId)');
    expect(flag).toBeGreaterThan(0);
    expect(zero).toBeGreaterThan(flag);
    expect(ins).toBeGreaterThan(zero);
    const block = html.slice(ins, ins + 2200);
    expect(block).toMatch(/from\('fee_acceptances'\)\.insert\(\{/);
    expect(block).toMatch(/bid_id: existingQuote\.id,/);
    expect(block).toMatch(/fee_text_displayed: _exactFeeText,/);
    expect(block).toMatch(/fee_amount: _feeAmount,/);
    expect(block).toMatch(/if \(_reopenedWithdrawnBid\) _reopenAcceptanceDoneId = existingQuote\.id;/);
  });

  it('React form: same, through buildFeeAcceptanceInsert', () => {
    const flag = tsx.indexOf("const reopenedWithdrawnBid = renewRpcMode === 'reopen'");
    const zero = tsx.indexOf('bid_update_zero_rows: no matching quote row was updated');
    const ins = tsx.indexOf('if (!reopenedWithdrawnBid || (existingQuote && reopenAcceptanceDoneRef.current !== existingQuote.id))');
    expect(flag).toBeGreaterThan(0);
    expect(zero).toBeGreaterThan(flag);
    expect(ins).toBeGreaterThan(zero);
    const block = tsx.slice(ins, ins + 4200);
    expect(block).toMatch(/from\('fee_acceptances'\)\.insert\(buildFeeAcceptanceInsert\(\{/);
    expect(block).toMatch(/bidId: feeBidId/);
    expect(block).toMatch(/feeTextDisplayed: exactFeeText/);
    expect(block).toMatch(/if \(reopenedWithdrawnBid\) reopenAcceptanceDoneRef\.current = feeBidId;/);
  });
});
