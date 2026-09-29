// templates.ts (gh-1824 footer batch 5)
//
// Email HTML/text builders for switch-contractor's two Mailgun sends — the
// original contractor's switch notification, and the internal support alert
// to Dustin (D-171 survey payload) — split out of index.ts so they can be
// unit-tested without importing index.ts (which calls `serve()` at module
// load time and would start listening for requests). Same convention as
// send-message-notification/templates.ts (gh-1824 footer batch 2).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

/** Escape HTML special characters in dynamic DB-sourced strings before interpolation. */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/** Shared HTML shell for switch-contractor's contractor notification (gh-1013). */
export function buildEmail(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#374151;font-size:15px;line-height:1.6;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
            ${footerPostalAddressHtml()}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

/**
 * HTML counterpart of the contractor-switch notification (gh-1013). No CTA
 * link exists in the source text, so none is added here — structure only,
 * same sentences, no new copy.
 */
export function contractorSwitchEmailHtml(contractorName: string, refundLine: string): string {
  const body = `
    <p style="margin:0 0 16px;">Hi ${escapeHtml(contractorName)},</p>
    <p style="margin:0 0 16px;">We're writing to let you know that the homeowner on the following project has chosen to switch contractors through Otter Quotes.</p>
    <p style="margin:0 0 16px;">This is a platform feature available to homeowners up to 3 days before their scheduled installation date.</p>
    <p style="margin:0 0 16px;">${escapeHtml(refundLine)}</p>
    <p style="margin:0 0 16px;">The project has been re-opened to the Otter Quotes contractor network. You are welcome to bid again when it reappears in your Opportunities dashboard.</p>
    <p style="margin:0 0 16px;">We appreciate your participation on Otter Quotes and look forward to connecting you with future projects.</p>
    <p style="margin:0;">Best regards,<br>The Otter Quotes Team</p>
  `;
  return buildEmail(body);
}

export function contractorSwitchEmailText(contractorName: string, refundLine: string): string {
  return `Hi ${contractorName},\n\nWe're writing to let you know that the homeowner on the following project has chosen to switch contractors through Otter Quotes.\n\nThis is a platform feature available to homeowners up to 3 days before their scheduled installation date.\n\n${refundLine}\n\nThe project has been re-opened to the Otter Quotes contractor network. You are welcome to bid again when it reappears in your Opportunities dashboard.\n\nWe appreciate your participation on Otter Quotes and look forward to connecting you with future projects.\n\nBest regards,\nThe Otter Quotes Team\nsupport@otterquote.com | (844) 875-3412\n\n${footerPostalAddressText()}`;
}

export function switchSupportEmailText(
  claimId: string,
  propertyAddress: string,
  contractorName: string,
  refundIssued: boolean,
  reasonsLine: string,
  notesLine: string,
): string {
  return `[Action Required] Homeowner contractor switch — ${propertyAddress}\n\nA homeowner has submitted a contractor switch request. Per D-171, please contact them directly to confirm their next contractor placement.\n\nClaim ID:        ${claimId}\nProperty:        ${propertyAddress}\nOriginal contractor: ${contractorName}\nRefund issued:   ${refundIssued ? "Yes" : "Pending"}\n\n--- Homeowner Switch Survey ---\nReasons selected: ${reasonsLine}\nAdditional notes: ${notesLine}\n\nPlease reach out to the homeowner to confirm their new contractor placement.\nAdmin: https://otterquote.com/admin-contractors.html\n\n— OtterQuote automated alert\n\n${footerPostalAddressText()}`;
}
