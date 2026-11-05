/**
 * gh-3480: the React fee section must RENDER the GC-approved #547 item 1A sentence
 * (what the contractor sees == fee_acceptances.fee_text_displayed) and must make
 * no disbursement promise (D-229: the fee is charged to the card; nothing is paid out).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { FeeSection } from '../fee-section';
import { buildFeeDisclosureText } from '../copy';

function render(mode: 'submit' | 'change' | 'renew' = 'submit', insurance = false): { html: string; text: string } {
  const html = renderToStaticMarkup(
    <FeeSection mode={mode} bidAmount={10000} feePct={7.5} disclosure={{ feeAmount: 750 }}
      claimRcv={insurance ? 20000 : null} isInsuranceRcv={insurance}
      autoRenew={false} setAutoRenew={() => {}} feeAccepted={false} setFeeAccepted={() => {}} />,
  );
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
  return { html, text };
}

describe('FeeSection rendered output (gh-3480)', () => {
  it('shows the approved sentence, equal to the stored fee text', () => {
    const { html } = render();
    const stored = buildFeeDisclosureText(7.5, 750);
    expect(stored).toBe(
      'Platform fee for this job: $750.00 (7.50% of your bid). By submitting this bid, you agree to pay Otter Quotes this fee if the homeowner selects your bid and a contract is signed. ' +
      'The fee is due upon contract execution and will be charged to your card on file. Submitting this bid constitutes your acceptance of this fee.',
    );
    expect(html).toContain(`>${stored}</p>`);
  });

  it('uses the HTML form checkbox label and no net, payout or deduction wording', () => {
    for (const [mode, ins] of [['submit', false], ['change', false], ['submit', true]] as const) {
      const { text } = render(mode, ins);
      expect(text).toContain('I understand and agree to the platform fee of 7.50% ($750.00)');
      expect(text).not.toMatch(/will receive/i);
      expect(text).not.toMatch(/\bnet\b/i);
      expect(text).not.toMatch(/deducted from my bid/i);
      expect(text).not.toMatch(/deducted/i);
      expect(text).not.toMatch(/disburse/i);
      expect(text).not.toContain('$9,250.00');
    }
  });
});
