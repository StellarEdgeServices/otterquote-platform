// templates.ts (gh-1824 footer batch 3)
//
// Email HTML/text builders for mark-payout-paid, split out of index.ts so
// they can be unit-tested without importing index.ts (which calls serve()
// at module load time and would start listening for requests). Same
// convention as approve-payout/templates.ts (gh-1824 footer batch 3).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export const PARTNER_DASH_URL = "https://otterquote.com/partner-dashboard.html";

function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
      ${footerPostalAddressHtml()}
    </td>
  </tr>
</table>`.trim();
}

export function buildEmail(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                         font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">
              Otter Quotes
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            ${bodyHtml}
          </td>
        </tr>
        <tr><td>${emailFooter()}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

function ctaButton(text: string, url: string): string {
  return `
<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="#10B981" style="border-radius:8px;">
      <a href="${url}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">
        ${text}
      </a>
    </td>
  </tr>
</table>`.trim();
}

export function formatCurrency(amount: number): string {
  return `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPayoutType(type: string): string {
  return type === "commission_referral" ? "Referral Fee" : "Recruit Bonus";
}

/**
 * D-290: states only what happened. No mechanism, no timeline, no interval.
 * Tone matches approve-payout's reference copy ("Our team will follow up
 * separately with next steps to get you paid").
 */
export function paidEmailHtml(partnerName: string, payoutType: string, amount: string): string {
  const bodyHtml = `
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  Your referral fee has been paid!
</h2>
<p style="color:#374151;font-size:0.95rem;margin:0 0 24px;">
  Hi ${partnerName}, your ${payoutType.toLowerCase()} of <strong>${amount}</strong> has been marked as paid.
  Thank you for being an Otter Quotes partner.
</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#F0FDF4;border-radius:8px;border:1px solid #BBF7D0;margin-bottom:24px;">
  <tr>
    <td style="padding:20px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:4px 0;font-size:0.875rem;color:#64748B;width:140px;">Referral Fee Type</td>
          <td style="padding:4px 0;font-size:0.875rem;font-weight:600;color:#0B1929;">${payoutType}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-size:0.875rem;color:#64748B;">Amount</td>
          <td style="padding:4px 0;font-size:1.25rem;font-weight:700;color:#10B981;">${amount}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-size:0.875rem;color:#64748B;">Status</td>
          <td style="padding:4px 0;font-size:0.875rem;font-weight:600;color:#10B981;">✓ Paid</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

${ctaButton("View Your Dashboard →", PARTNER_DASH_URL)}

<p style="font-size:0.8rem;color:#94A3B8;">
  Questions? Email us at
  <a href="mailto:support@otterquote.com" style="color:#0EA5E9;">support@otterquote.com</a>.
</p>
`;
  return buildEmail(bodyHtml);
}

export function paidEmailText(partnerName: string, payoutType: string, amount: string): string {
  return [
    `Hi ${partnerName},`,
    ``,
    `Your ${payoutType.toLowerCase()} of ${amount} has been marked as paid.`,
    `Thank you for being an Otter Quotes partner.`,
    ``,
    `View your dashboard: ${PARTNER_DASH_URL}`,
    ``,
    footerPostalAddressText(),
  ].join("\n");
}
