// templates.ts (gh-1824 footer batch 4)
//
// Email HTML/text builders for notify-partner-w9, split out of index.ts so
// they can be unit-tested without importing index.ts (which calls `serve()`
// at module load time and would start listening for requests). Same
// convention as send-homeowner-next-steps/email-content.ts and
// admin-contractor-action/templates.ts (batch 3).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export const PARTNER_DASHBOARD_URL = "https://otterquote.com/partner-dashboard.html#w9Upload";

// =============================================================================
// EMAIL HELPERS — mirrors notify-contractors pattern (Session 180)
// =============================================================================

function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
      ${footerPostalAddressHtml()}
    </td>
  </tr>
</table>`.trim();
}

// ── Inlined from _shared/email.ts (#869) — see that file's header comment ──
// for why this is duplicated rather than imported (the EF body-deploy path
// does not resolve `_shared/` imports). Table-based CTA + MSO VML conditional
// so Outlook renders a real filled rectangle, not a bare link. Brand amber
// #E07B00 — replaces the non-brand #14B8A6 teal this function used to default to.
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

function buildEmail(bodyHtml: string): string {
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
        <!-- Header -->
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            ${bodyHtml}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td>${emailFooter()}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

export function w9RequestEmailHtml(firstName: string): string {
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";

  const body = `
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Action Required</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Submit your W-9 to receive your referral payment</h2>

    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">${greeting}</p>

    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Your referral generated a referral fee payment, but we&rsquo;re unable to issue it yet. <strong>A completed IRS Form W-9 is required before any payment can be released.</strong></p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;margin:16px 0 24px;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 6px;color:#92400E;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">Why is this required?</p>
          <p style="margin:0;color:#78350F;font-size:14px;line-height:1.6;">The IRS requires Otter Quotes to collect a W-9 from any partner who receives $600 or more in referral payments during a calendar year. We&rsquo;re required to issue a 1099-MISC for qualifying payments, and we cannot do so without your taxpayer information on file.</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 8px;color:#374151;font-size:15px;font-weight:600;">To release your payment:</p>
    <ol style="margin:0 0 24px;padding-left:20px;color:#374151;font-size:15px;line-height:1.8;">
      <li>Log in to your partner dashboard</li>
      <li>Find the &ldquo;W-9 Form&rdquo; card and click <strong>Upload W-9</strong></li>
      <li>Upload a signed, completed IRS Form W-9 (PDF)</li>
    </ol>

    <p style="margin:0 0 4px;color:#374151;font-size:14px;">Once received, our team will process your W-9 and release your payment promptly.</p>

    ${emailButton({ href: PARTNER_DASHBOARD_URL, label: "Upload My W-9 &rarr;" })}

    <p style="margin:16px 0 0;color:#64748B;font-size:13px;line-height:1.6;">Need a blank W-9 form? <a href="https://www.irs.gov/pub/irs-pdf/fw9.pdf" style="color:#0EA5E9;text-decoration:none;">Download from the IRS website &rarr;</a></p>
    <p style="margin:8px 0 0;color:#64748B;font-size:13px;line-height:1.6;">Questions? Reply to this email or contact us at <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>.</p>
  `;

  return buildEmail(body);
}

export function w9RequestEmailText(firstName: string): string {
  return `Hi ${firstName || "there"},

Your referral generated a referral fee payment, but we need a completed W-9 before we can release it.

Please log in to your partner dashboard to upload your W-9:
${PARTNER_DASHBOARD_URL}

Questions? Email support@otterquote.com or call (844) 875-3412.

Otter Quotes Team

${footerPostalAddressText()}`;
}
