// templates.ts (gh-1824 footer batch 3)
//
// Email HTML/text builders for approve-warranty-drift's deprecated-warranty
// contractor notification, split out of index.ts so they can be
// unit-tested without importing index.ts (which calls `Deno.serve()` at
// module load time and would start listening for requests). Same
// convention as send-message-notification/templates.ts (gh-1824 footer
// batch 2) and admin-contractor-action/templates.ts (gh-1824 footer batch 3).

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

/** Shared HTML shell for approve-warranty-drift's contractor notifications (gh-1013). */
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

/** HTML counterpart of the deprecated-warranty-program contractor notice (gh-1013). */
export function deprecatedWarrantyEmailHtml(businessName: string, manufacturer: string, tier: string): string {
  const body = `
    <p style="margin:0 0 16px;">Hi ${escapeHtml(businessName)},</p>
    <p style="margin:0 0 16px;">We wanted to let you know that the ${escapeHtml(manufacturer)} ${escapeHtml(tier)} warranty program has been updated in the Otter Quotes platform.</p>
    <p style="margin:0 0 16px;">Please log in to your contractor profile and review your saved warranty selections to ensure they reflect the current program offerings.</p>
    <p style="margin:0 0 16px;">If you have any questions, reply to this email.</p>
    <p style="margin:0;">&mdash; Otter Quotes Platform</p>
  `;
  return buildEmail(body);
}

/** Plain-text counterpart of the deprecated-warranty-program contractor notice (gh-1013). */
export function deprecatedWarrantyEmailText(businessName: string, manufacturer: string, tier: string): string {
  return [
    `Hi ${businessName},`,
    ``,
    `We wanted to let you know that the ${manufacturer} ${tier} warranty program`,
    `has been updated in the Otter Quotes platform.`,
    ``,
    `Please log in to your contractor profile and review your saved warranty`,
    `selections to ensure they reflect the current program offerings.`,
    ``,
    `If you have any questions, reply to this email.`,
    ``,
    `— Otter Quotes Platform`,
    ``,
    footerPostalAddressText(),
  ].join("\n");
}
