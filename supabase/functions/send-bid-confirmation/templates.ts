// templates.ts (gh-1824 footer batch 2)
//
// Email HTML/text builders for send-bid-confirmation, split out of index.ts
// so they can be unit-tested without importing index.ts (which calls
// `serve()` at module load time and would start listening for requests).
// Same convention as send-homeowner-next-steps/email-content.ts.

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export function formatCurrency(amount: number): string {
  // #485: fractional amounts must render both decimals — "$0.5" in the fee
  // disclosure email misstates a legal disclosure. Whole dollars stay clean.
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function buildEmailHtml(
  firstName: string,
  jobNumber: string,   // D-216: "Job #XXXXXXXX"
  claimId: string,     // for rescind/review links
  trade: string,
  bidAmount: number,
  feePct: number,
  feeAmount: number
): string {
  const bidAmountFormatted = formatCurrency(bidAmount);
  const feeAmountFormatted = formatCurrency(feeAmount);
  const bidFormUrl = `https://otterquote.com/contractor-bid-form.html?claim_id=${claimId}`;
  // D-225 bugfix (86e1ex733): rescind link must carry action=rescind so the
  // bid form opens the rescind UI (was on the live EF, lost in repo drift).
  const rescindUrl = `https://otterquote.com/contractor-bid-form.html?action=rescind&claim_id=${claimId}`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { margin-bottom: 30px; }
    .section { margin: 20px 0; padding: 15px; border-left: 4px solid #0066cc; background-color: #f5f5f5; }
    .section-title { font-weight: bold; margin-bottom: 10px; }
    .summary-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #ddd; }
    .summary-row:last-child { border-bottom: none; }
    .label { font-weight: 500; }
    .value { text-align: right; }
    .btn { display: inline-block; margin: 8px 4px; padding: 12px 24px; color: #fff; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 14px; }
    .btn-rescind { background-color: #cc3300; }
    .btn-review { background-color: #0066cc; }
    .footer { margin-top: 30px; font-size: 12px; color: #666; border-top: 1px solid #ddd; padding-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <p>Hi ${firstName},</p>
      <p>Your bid for <strong>${jobNumber}</strong> has been successfully submitted.</p>
    </div>

    <div class="section">
      <div class="section-title">--- BID SUMMARY ---</div>
      <div class="summary-row">
        <span class="label">Trade:</span>
        <span class="value">${trade}</span>
      </div>
      <div class="summary-row">
        <span class="label">Bid Amount:</span>
        <span class="value">${bidAmountFormatted}</span>
      </div>
      <div class="summary-row">
        <span class="label">Platform Fee (${feePct}%):</span>
        <span class="value">${feeAmountFormatted}</span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">--- PLATFORM FEE AGREEMENT ---</div>
      <p>By submitting this bid, you agreed to pay Otter Quotes a platform fee of ${feePct}% (${feeAmountFormatted}) upon contract execution. If the homeowner accepts your bid and executes the contract, this fee will be charged to your card on file. This email serves as confirmation of your fee agreement.</p>
      <p>Questions? Reply to this email or contact support@otterquote.com.</p>
      <p>— The Otter Quotes Team</p>
    </div>

    <div class="section" style="border-left-color: #cc3300; text-align: center;">
      <div class="section-title">--- YOUR BID IS LIVE ---</div>
      <p>Not comfortable with these terms? Rescind your bid now. Your offer is currently live and could be accepted by the homeowner at any time.</p>
      <a href="${rescindUrl}" class="btn btn-rescind">Rescind My Bid</a>
      <a href="${bidFormUrl}" class="btn btn-review">Review My Bid</a>
    </div>

    <div class="footer">
      <p>This email confirms your bid submission and fee agreement. Keep this email for your records.</p>
      ${footerPostalAddressHtml()}
    </div>
  </div>
</body>
</html>
  `.trim();
}

export function buildEmailText(
  firstName: string,
  jobNumber: string,
  claimId: string,
  trade: string,
  bidAmount: number,
  feePct: number,
  feeAmount: number
): string {
  const bidAmountFormatted = formatCurrency(bidAmount);
  const feeAmountFormatted = formatCurrency(feeAmount);
  const bidFormUrl = `https://otterquote.com/contractor-bid-form.html?claim_id=${claimId}`;
  const rescindUrl = `https://otterquote.com/contractor-bid-form.html?action=rescind&claim_id=${claimId}`;

  return `Hi ${firstName},

Your bid for ${jobNumber} has been successfully submitted.

--- BID SUMMARY ---
Trade: ${trade}
Bid Amount: ${bidAmountFormatted}
Platform Fee (${feePct}%): ${feeAmountFormatted}

--- PLATFORM FEE AGREEMENT ---
By submitting this bid, you agreed to pay Otter Quotes a platform fee of ${feePct}% (${feeAmountFormatted}) upon contract execution. If the homeowner accepts your bid and executes the contract, this fee will be charged to your card on file. This email serves as confirmation of your fee agreement.

Questions? Reply to this email or contact support@otterquote.com.

— The Otter Quotes Team

--- YOUR BID IS LIVE ---
Not comfortable with these terms? Rescind your bid now. Your offer is currently live and could be accepted by the homeowner at any time.

Rescind My Bid: ${rescindUrl}
Review My Bid: ${bidFormUrl}

${footerPostalAddressText()}`;
}
