/**
 * gh-3480: the React fee section must RENDER the GC-approved #547 item 1A sentence
 * (what the contractor sees == fee_acceptances.fee_text_displayed) and must make
 * no disbursement promise (D-229: the fee is charged to the card; nothing is paid out).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { FeeSection } from '../fee-section';
import { BID_COPY, buildFeeDisclosureText, splitFeeDisclosureText } from '../copy';

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
    const { lead, rest } = splitFeeDisclosureText(7.5, 750);
    expect(`${lead} ${rest}`).toBe(stored);
    // Approved bold lead (#547 item 1A; <strong> at contractor-bid-form.html:2352).
    expect(html).toContain(`<p id="feeDisclosureText" data-testid="fee-disclosure-text"><strong>${lead}</strong> ${rest}</p>`);
    expect(html).toContain('<strong>Platform fee for this job: $750.00 (7.50% of your bid).</strong>');
  });

  it('shows the #547 item 1B explainer, verbatim, and never the retired flat-5% / RCV-basis lines', () => {
    const item1B =
      'A platform fee applies to each job won through Otter Quotes. The exact fee for your job — shown as a percentage and dollar amount — is displayed before you submit your bid. Fees may vary by job type and value. You will never be charged a fee that was not displayed to you at submission. If you pay by card, a processing fee of 2.9% + $0.30 is added to the platform fee shown above, as stated in Section 7.7 of your Contractor Partner Agreement.';
    expect(BID_COPY.fee.feeExplainer).toBe(item1B);
    // Every card state: all three modes, retail and insurance_rcv (RCV $20,000 vs bid $18,000).
    for (const mode of ['submit', 'change', 'renew'] as const) {
      for (const insurance of [false, true]) for (const [feePct, feeAmount, shown] of [[5, 900, '$900.00 (5.00%'], [7.5, 1350, '$1,350.00 (7.50%']] as const) {
        const html = renderToStaticMarkup(
          <FeeSection mode={mode} bidAmount={18000} feePct={feePct} disclosure={{ feeAmount }}
            claimRcv={insurance ? 20000 : null} isInsuranceRcv={insurance}
            autoRenew={false} setAutoRenew={() => {}} feeAccepted={false} setFeeAccepted={() => {}} />,
        );
        const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
        expect(text).toContain(item1B);
        expect(text).not.toMatch(/flat 5%/i);
        expect(text).not.toMatch(/based on the RCV/i);
        expect(text).not.toMatch(/\bRCV\b/);
        expect(text).not.toContain('$20,000.00');
        // Bold lead checked on the RAW html (tags stripped above would hide it), at both rates, both job types.
        expect(html).toContain(`<strong>Platform fee for this job: ${shown} of your bid).</strong>`);
      }
    }
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
