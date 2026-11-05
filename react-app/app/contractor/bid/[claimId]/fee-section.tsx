'use client';

/**
 * Platform Fee & Submission card (D-214/D-215). gh-3480: the HTML form's
 * #feeDisclosureText sentence (buildFeeDisclosureText, GC-approved #547 item 1A)
 * is rendered here, so what the contractor sees equals the stored
 * fee_acceptances.fee_text_displayed. The checkbox label is the HTML form's
 * ("I understand and agree to the platform fee of X% ($Y)"). No net, payout or
 * "deducted" wording: nothing is disbursed to the contractor (D-229).
 */
import { Card, Checkbox, formatCurrency } from './bid-ui';
import { BID_COPY, buildFeeDisclosureText } from './copy';
import type { BidMode } from './utils';

export function FeeSection({ mode, bidAmount, feePct, disclosure, claimRcv, isInsuranceRcv, autoRenew, setAutoRenew, feeAccepted, setFeeAccepted }: {
  mode: BidMode; bidAmount: number; feePct: number;
  disclosure: { feeAmount: number };
  claimRcv: number | null; isInsuranceRcv: boolean;
  autoRenew: boolean; setAutoRenew: (v: boolean) => void;
  feeAccepted: boolean; setFeeAccepted: (v: boolean) => void;
}) {
  const feeInfo = isInsuranceRcv && claimRcv ? BID_COPY.fee.feeInfoInsurance(formatCurrency(claimRcv)) : BID_COPY.fee.feeInfoRetail;
  return (
    <Card title="Platform Fee & Submission">
      <div className="oqb-fee-box">
        <div className="oqb-fee-row"><span>Your bid</span><span>{formatCurrency(bidAmount)}</span></div>
        <div className="oqb-fee-row"><span>Platform fee ({feePct.toFixed(2)}%)</span><span>{formatCurrency(disclosure.feeAmount)}</span></div>
        <div className="oqb-fee-info">{feeInfo}</div>
      </div>

      <p id="feeDisclosureText" data-testid="fee-disclosure-text">{buildFeeDisclosureText(feePct, disclosure.feeAmount)}</p>

      {mode !== 'change' && (
        <Checkbox checked={autoRenew} onChange={setAutoRenew} label="Auto-renew this bid for another 14-day window if it expires (D-150)." />
      )}

      <label className="oqb-accept">
        <input type="checkbox" checked={feeAccepted} onChange={(e) => setFeeAccepted(e.target.checked)} />
        <span>I understand and agree to the platform fee of {feePct.toFixed(2)}% ({formatCurrency(disclosure.feeAmount)})</span>
      </label>
    </Card>
  );
}
