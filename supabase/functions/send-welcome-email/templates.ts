// templates.ts (gh-1824 footer batch 2)
//
// Email HTML/text builders for send-welcome-email, split out of index.ts so
// they can be unit-tested without importing index.ts (which calls `serve()`
// at module load time and would start listening for requests). Same
// convention as send-homeowner-next-steps/email-content.ts.

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

/** Escape user-supplied strings before interpolating into HTML email templates. */
export function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildWelcomeText(greeting: string, settingsUrl: string): string {
  return `Hi ${greeting},

Welcome to Otter Quotes — your application is now in review.

Our team typically completes reviews within 2–5 business days. Here's what happens during that time:
- You give us your contractor license information for each trade and municipality, and attest that it is current
- You upload a Certificate of Insurance (COI) that meets our coverage minimums
- We review your profile for completeness before activating your account

While you wait, use the time to get everything ready so you can hit the ground running the moment you're approved.

What to prepare:
1. Valid CGL Certificate of Insurance — $1M per occurrence / $2M aggregate, with Stellar Edge Services LLC listed as additional insured
2. Contractor license information for each trade and municipality you work in
3. Contract template (PDF) for each trade you offer
4. Stripe payment method — required before you can receive projects

Complete your profile now:
${settingsUrl}

Questions? support@otterquote.com | (844) 875-3412

The Otter Quotes Team
https://otterquote.com

${footerPostalAddressText()}`;
}

export function buildWelcomeHtml(greeting: string, settingsUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
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
            <p style="margin:0 0 6px;color:#14B8A6;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Application In Review</p>
            <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Welcome to Otter Quotes, ${escapeHtml(greeting)}!</h2>
            <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Your application is in review. Our team typically completes the process within <strong>2&ndash;5 business days</strong>. Here&rsquo;s what happens:</p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8FAFC;border-radius:8px;margin-bottom:24px;">
              <tr><td style="padding:16px 20px;border-bottom:1px solid #E2E8F0;">
                <table cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:2px;">
                    <div style="width:22px;height:22px;background:#14B8A6;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#ffffff;">1</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;color:#0F172A;font-size:14px;font-weight:600;">License Information</p>
                    <p style="margin:4px 0 0;color:#64748B;font-size:13px;">You give us your license information for each trade and municipality you serve, and attest that it is current. We do not independently verify it.</p>
                  </td>
                </tr></table>
              </td></tr>
              <tr><td style="padding:16px 20px;border-bottom:1px solid #E2E8F0;">
                <table cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:2px;">
                    <div style="width:22px;height:22px;background:#14B8A6;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#ffffff;">2</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;color:#0F172A;font-size:14px;font-weight:600;">COI Requirements</p>
                    <p style="margin:4px 0 0;color:#64748B;font-size:13px;">You upload a current Certificate of Insurance. Our coverage minimums are $1M per occurrence / $2M aggregate CGL, with Stellar Edge Services LLC named as additional insured.</p>
                  </td>
                </tr></table>
              </td></tr>
              <tr><td style="padding:16px 20px;">
                <table cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:2px;">
                    <div style="width:22px;height:22px;background:#14B8A6;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#ffffff;">3</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;color:#0F172A;font-size:14px;font-weight:600;">Profile Check</p>
                    <p style="margin:4px 0 0;color:#64748B;font-size:13px;">We review your profile for completeness before activating your account.</p>
                  </td>
                </tr></table>
              </td></tr>
            </table>
            <p style="margin:0 0 12px;color:#0F172A;font-size:15px;font-weight:700;">What to prepare while you wait:</p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0FDFA;border:1px solid #99F6E4;border-radius:8px;margin-bottom:24px;">
              <tr><td style="padding:16px 20px;">
                <table cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Valid CGL Certificate of Insurance</strong> &mdash; $1M per occurrence / $2M aggregate, with <em>Stellar Edge Services LLC</em> listed as additional insured
                  </td></tr>
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Contractor license information</strong> for each trade and municipality you serve
                  </td></tr>
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Contract template (PDF)</strong> for each trade you offer
                  </td></tr>
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Stripe payment method</strong> &mdash; required before you can receive projects
                  </td></tr>
                </table>
              </td></tr>
            </table>
            <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Head to your profile settings to upload documents and connect your payment method before your review completes &mdash; it speeds things up.</p>
            <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
              <tr>
                <td align="center" bgcolor="#14B8A6" style="border-radius:8px;">
                  <a href="${settingsUrl}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">Complete Your Profile &rarr;</a>
                </td>
              </tr>
            </table>
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
</html>`;
}
