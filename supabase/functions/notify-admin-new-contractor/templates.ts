// templates.ts (gh-1824 footer batch 3)
//
// Email HTML/text builders for notify-admin-new-contractor's admin alert,
// split out of index.ts so they can be unit-tested without importing
// index.ts (which calls `serve()` at module load time and would start
// listening for requests). Same convention as
// send-message-notification/templates.ts (gh-1824 footer batch 2).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export const ADMIN_PORTAL_URL = "https://otterquote.com/admin-contractors.html";

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildEmailHtml(
  companyName: string,
  contactName: string,
  email: string,
  signupTs: string,
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr>
          <td style="background:#0B1929;padding:20px 24px;">
            <h2 style="color:#F59E0B;margin:0;font-size:1.1rem;font-family:sans-serif;">
              🦦 New Contractor Signup — Review Required
            </h2>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              A new contractor has signed up and is awaiting approval.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="border-collapse:collapse;font-size:14px;margin-bottom:24px;">
              <tr>
                <td style="padding:8px 0;color:#64748B;width:130px;vertical-align:top;">Company</td>
                <td style="padding:8px 0;font-weight:600;">${escapeHtml(companyName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Contact</td>
                <td style="padding:8px 0;">${escapeHtml(contactName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Email</td>
                <td style="padding:8px 0;">
                  <a href="mailto:${escapeHtml(email)}" style="color:#0369A1;">${escapeHtml(email)}</a>
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Signed up</td>
                <td style="padding:8px 0;">${escapeHtml(signupTs)} CT</td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#F59E0B" style="border-radius:8px;">
                  <a href="${ADMIN_PORTAL_URL}"
                     style="display:inline-block;font-family:sans-serif;font-size:15px;font-weight:700;
                            color:#0B1929;text-decoration:none;padding:12px 24px;">
                    Review in Admin Portal &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td align="center"
              style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px;
                     font-family:sans-serif;font-size:12px;color:#94A3B8;">
            Otter Quotes &nbsp;|&nbsp;
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
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

export function buildEmailText(
  companyName: string,
  contactName: string,
  email: string,
  signupTs: string,
): string {
  return [
    `New contractor signup on Otter Quotes — review required.`,
    ``,
    `Company  : ${companyName}`,
    `Contact  : ${contactName}`,
    `Email    : ${email}`,
    `Signed up: ${signupTs} CT`,
    ``,
    `Review in admin portal:`,
    ADMIN_PORTAL_URL,
    ``,
    footerPostalAddressText(),
  ].join("\n");
}
