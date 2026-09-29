// templates.ts (gh-1824 footer batch 5)
//
// Email HTML/text builders for resend-hover-link's homeowner measurement-link
// reminder, split out of index.ts so they can be unit-tested without
// importing index.ts (which calls `serve()` at module load time and would
// start listening for requests). Same convention as
// send-message-notification/templates.ts (gh-1824 footer batch 2).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

// ── Inlined from _shared/email.ts (#869) — see that file's header comment ──
// for why this is duplicated rather than imported (the EF body-deploy path
// does not resolve `_shared/` imports). Table-based CTA + MSO VML conditional
// so Outlook renders a real filled rectangle, not a bare link. Brand amber #E07B00.
export function emailButton({ href, label }: { href: string; label: string }): string {
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

// #869 AC 4: this was the one genuinely customer-facing bare-URL offender —
// the homeowner-facing capture link was printed as raw text with no HTML
// part at all. The text/plain part below deliberately KEEPS the bare URL
// (#869 AC 2 — accessibility / HTML-blocked-client fallback); only the new
// HTML part turns it into a button.
export function buildHtmlBody(homeownerName: string, propertyAddress: string, captureLink: string): string {
  const body = `
<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Hi ${homeownerName},</p>
<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Here&rsquo;s a reminder with your measurement link for <strong>${propertyAddress}</strong>.</p>
<p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">To get accurate bids from contractors, we need aerial measurements of your roof. It&rsquo;s easy &mdash; just use the button below to submit photos from your phone or computer, and professional measurements will be generated automatically.</p>
${emailButton({ href: captureLink, label: "Open Your Measurement Link →" })}
<p style="margin:20px 0 8px;color:#374151;font-size:15px;font-weight:600;">What to do:</p>
<ol style="margin:0 0 20px;padding-left:20px;color:#374151;font-size:15px;line-height:1.8;">
  <li>Click the button above</li>
  <li>Follow the on-screen instructions to submit photos</li>
  <li>Your photos will be processed to generate measurements</li>
  <li>You&rsquo;ll be notified when measurements are ready</li>
</ol>
<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">This usually takes less than 24 hours. Once complete, you&rsquo;ll be able to submit your project for contractor bids.</p>
<p style="margin:0;color:#64748B;font-size:13px;line-height:1.6;">If you have questions, reply to this email or call us at (844) 875-3412.</p>
`;

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
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            ${body}
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

export function buildTextBody(homeownerName: string, propertyAddress: string, captureLink: string): string {
  return `Hi ${homeownerName},

Here's a reminder with your measurement link for ${propertyAddress}.

To get accurate bids from contractors, we need aerial measurements of your roof. It's easy — just use the link below to submit photos from your phone or computer, and professional measurements will be generated automatically.

Your Measurement Link:
${captureLink}

What to do:
1. Click the link above
2. Follow the on-screen instructions to submit photos
3. Your photos will be processed to generate measurements
4. You'll be notified when measurements are ready

This usually takes less than 24 hours. Once complete, you'll be able to submit your project for contractor bids.

If you have questions, reply to this email or call us at (844) 875-3412.

The Otter Quotes Team
https://otterquote.com

${footerPostalAddressText()}`;
}
