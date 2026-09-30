// templates.ts (gh-1824 footer batch 6)
//
// Email bodies (plain text + HTML) for notify-admin-new-partner's admin alert,
// split out of index.ts so they can be unit-tested directly. Pure functions:
// no I/O, no clock. Wording is moved verbatim from index.ts; templates.test.ts
// pins every rendered body with exact-equality goldens. The D-237 postal footer
// is NOT added here: index.ts appends it at the single Mailgun send via
// footer-append.ts, and the goldens compose the same way.

export const ADMIN_PORTAL_URL = "https://otterquote.com/admin-referrals.html";

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildEmailHtml(
  isTest: boolean,
  fullName: string,
  agentType: string,
  email: string,
  company: string,
  funnelId: string,
  fbclidPresent: boolean,
  signupTs: string,
): string {
  const testBanner = isTest
    ? `<tr><td style="background:#FEF3C7;color:#92400E;padding:8px 24px;font-family:sans-serif;font-size:13px;font-weight:600;">TEST SIGNUP — not a real partner lead</td></tr>`
    : "";
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
              🦦 New Partner Signup
            </h2>
          </td>
        </tr>
        ${testBanner}
        <!-- Body -->
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              A new partner has signed up.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="border-collapse:collapse;font-size:14px;margin-bottom:24px;">
              <tr>
                <td style="padding:8px 0;color:#64748B;width:130px;vertical-align:top;">Name</td>
                <td style="padding:8px 0;font-weight:600;">${escapeHtml(fullName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Agent type</td>
                <td style="padding:8px 0;">${escapeHtml(agentType)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Email</td>
                <td style="padding:8px 0;">
                  <a href="mailto:${escapeHtml(email)}" style="color:#0369A1;">${escapeHtml(email)}</a>
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Company</td>
                <td style="padding:8px 0;">${escapeHtml(company)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Funnel</td>
                <td style="padding:8px 0;">${escapeHtml(funnelId)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">fbclid</td>
                <td style="padding:8px 0;">${fbclidPresent ? "present" : "not present"}</td>
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
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

/** Plain-text body for the new-partner-signup admin alert. */
export function partnerSignupText(
  isTest: boolean,
  fullName: string,
  agentType: string,
  email: string,
  company: string,
  funnelId: string,
  fbclidPresent: boolean,
  signupTs: string,
): string {
  return [
    isTest ? `TEST SIGNUP — not a real partner lead.` : null,
    isTest ? `` : null,
    `New partner signup on Otter Quotes.`,
    ``,
    `Name     : ${fullName}`,
    `Type     : ${agentType}`,
    `Email    : ${email}`,
    `Company  : ${company}`,
    `Funnel   : ${funnelId}`,
    `fbclid   : ${fbclidPresent ? "present" : "not present"}`,
    `Signed up: ${signupTs} CT`,
    ``,
    `Review in admin portal:`,
    ADMIN_PORTAL_URL,
  ].filter((l) => l !== null).join("\n");
}
