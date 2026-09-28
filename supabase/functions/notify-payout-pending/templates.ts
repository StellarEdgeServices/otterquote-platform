// templates.ts (gh-1824 footer batch 4)
//
// Email HTML/text builders for notify-payout-pending, split out of index.ts
// so they can be unit-tested without importing index.ts (which calls
// `serve()` at module load time and would start listening for requests).
// Same convention as send-homeowner-next-steps/email-content.ts and
// admin-contractor-action/templates.ts (batch 3).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export const ADMIN_PAYOUTS_URL = "https://otterquote.com/admin-payouts.html";

export function formatCurrency(amount: number): string {
  return `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPayoutType(type: string): string {
  return type === "commission_referral" ? "Referral Commission" : "Recruit Bonus";
}

function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      ${footerPostalAddressHtml()}
    </td>
  </tr>
</table>`.trim();
}

function buildEmail(bodyHtml: string): string {
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

// ── Inlined from _shared/email.ts (#869) — see that file's header comment ──
// for why this is duplicated rather than imported (the EF body-deploy path
// does not resolve `_shared/` imports). Table-based CTA + MSO VML conditional
// so Outlook renders a real filled rectangle, not a bare link. Brand amber
// #E07B00 (this function already defaulted to it — now canonical + Outlook-safe).
function emailButton({ href, label }: { href: string; label: string }): string {
  const BRAND_AMBER = "#E07B00";
  const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  return `
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="15%" strokecolor="${BRAND_AMBER}" fillcolor="${BRAND_AMBER}">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:${FONT_STACK};font-size:16px;font-weight:700;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="${BRAND_AMBER}" style="border-radius:8px;">
      <a href="${href}" style="display:inline-block;font-family:${FONT_STACK};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">${label}</a>
    </td>
  </tr>
</table>
<!--<![endif]-->`.trim();
}

export function payoutPendingEmailHtml(
  partnerName: string,
  amount: string,
  payoutType: string,
  autoApproveOn: string,
  triggerEvent: string,
  payoutApprovalId: string
): string {
  const bodyHtml = `
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  Action Required: Commission Approval
</h2>
<p style="color:#64748B;font-size:0.9rem;margin:0 0 24px;">
  A commission is pending your review and approval.
</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#F8FAFC;border-radius:8px;border:1px solid #E2E8F0;margin-bottom:24px;">
  <tr>
    <td style="padding:20px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;width:160px;">Partner Name</td>
          <td style="padding:6px 0;font-size:0.875rem;font-weight:600;color:#0B1929;">${partnerName}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Commission Type</td>
          <td style="padding:6px 0;font-size:0.875rem;font-weight:600;color:#0B1929;">${payoutType}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Amount</td>
          <td style="padding:6px 0;font-size:1.25rem;font-weight:700;color:#0B1929;">${amount}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Trigger Event</td>
          <td style="padding:6px 0;font-size:0.875rem;color:#0B1929;">${triggerEvent}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Auto-Approves</td>
          <td style="padding:6px 0;font-size:0.875rem;color:#0B1929;">${autoApproveOn} if no action taken</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Approval ID</td>
          <td style="padding:6px 0;font-size:0.75rem;color:#94A3B8;font-family:monospace;">${payoutApprovalId}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

${emailButton({ href: ADMIN_PAYOUTS_URL, label: "Review in Admin →" })}

<p style="font-size:0.8rem;color:#94A3B8;margin-top:16px;">
  You have until ${autoApproveOn} to approve or reject this commission. After that, it will auto-approve automatically.
</p>
`;
  return buildEmail(bodyHtml);
}

export function payoutPendingEmailText(
  partnerName: string,
  amount: string,
  payoutType: string,
  autoApproveOn: string,
  triggerEvent: string
): string {
  return [
    `Action Required: Commission Approval`,
    ``,
    `Partner: ${partnerName}`,
    `Type: ${payoutType}`,
    `Amount: ${amount}`,
    `Trigger: ${triggerEvent}`,
    `Auto-Approves: ${autoApproveOn}`,
    ``,
    `Review here: ${ADMIN_PAYOUTS_URL}`,
    ``,
    footerPostalAddressText(),
  ].join("\n");
}
