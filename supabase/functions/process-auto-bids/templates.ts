// templates.ts (gh-1824 footer batch 4)
//
// Email HTML/text builders for process-auto-bids, split out of index.ts so
// they can be unit-tested without importing index.ts (which calls `serve()`
// at module load time and would start listening for requests). Same
// convention as send-homeowner-next-steps/email-content.ts and
// admin-contractor-action/templates.ts (batch 3).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

// Email template (text/plain)
// #869 AC 5: text/plain alternative for the HTML-only send below. Per AC 2,
// bare URLs are correct — and required — in this text part.
export function buildEmailText(name: string, rcvAmount: number, feeAmount: number, feePct: number): string {
  const fmtUSD = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  return [
    `Hi ${name},`,
    ``,
    `We automatically submitted a bid on your behalf for a new insurance roofing project.`,
    ``,
    `Bid Amount: ${fmtUSD(rcvAmount)}`,
    `Platform Fee (${feePct}%): ${fmtUSD(feeAmount)}`,
    `Project Type: Insurance full replacement — roofing`,
    ``,
    `View Project: https://otterquote.com/contractor-opportunities.html`,
    ``,
    `To turn off auto-bidding, visit your auto-bid settings: https://otterquote.com/contractor-auto-bids.html`,
    ``,
    `— The Otter Quotes Team`,
    ``,
    footerPostalAddressText(),
  ].join('\n');
}

// Email template (HTML)
export function buildEmailHtml(name: string, rcvAmount: number, feeAmount: number, feePct: number): string {
  const fmtUSD = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  return `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
  <h2 style="color:#1a3c5e;">Auto-Bid Submitted ✓</h2>
  <p>Hi ${name},</p>
  <p>We automatically submitted a bid on your behalf for a new insurance roofing project.</p>
  <table style="border-collapse:collapse;width:100%;margin:16px 0;">
    <tr style="background:#f4f6f8;">
      <td style="padding:8px 12px;font-weight:bold;">Bid Amount</td>
      <td style="padding:8px 12px;">${fmtUSD(rcvAmount)}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-weight:bold;">Platform Fee (${feePct}%)</td>
      <td style="padding:8px 12px;">${fmtUSD(feeAmount)}</td>
    </tr>
    <tr style="background:#f4f6f8;">
      <td style="padding:8px 12px;font-weight:bold;">Project Type</td>
      <td style="padding:8px 12px;">Insurance full replacement — roofing</td>
    </tr>
  </table>
  <p>
    <a href="https://otterquote.com/contractor-opportunities.html"
       style="display:inline-block;background:#f59e0b;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">
      View Project
    </a>
  </p>
  <p style="font-size:13px;color:#666;">
    To turn off auto-bidding, visit your
    <a href="https://otterquote.com/contractor-auto-bids.html">auto-bid settings</a>.
  </p>
  <p>— The Otter Quotes Team</p>
  ${footerPostalAddressHtml()}
</body>
</html>
  `.trim();
}
