// Deno unit test for gh-1824 footer-batch-3: notify-admin-new-contractor's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/notify-admin-new-contractor/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmailHtml, buildEmailText, ADMIN_PORTAL_URL } from "./templates.ts";
import { POSTAL_ADDRESS, footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

Deno.test("gh-1824 notify-admin-new-contractor: buildEmailText includes the D-237 postal address", () => {
  assertEquals(
    buildEmailText("Acme Roofing", "Jane", "jane@example.com", "1/1/2026, 12:00:00 PM").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 notify-admin-new-contractor: buildEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    buildEmailHtml("Acme Roofing", "Jane", "jane@example.com", "1/1/2026, 12:00:00 PM").includes(POSTAL_ADDRESS),
    true,
  );
});

// =============================================================================
// REVIEW FAIL 5870472283 must-fix: exact-equality goldens for fixed inputs.
//
// Independent copy of the pre-extraction wording from origin/main's
// notify-admin-new-contractor/index.ts, reproduced here as a plain literal
// with the footer wired in exactly as this PR's change does. If
// templates.ts's wording drifts, this golden still carries the original
// wording and assertEquals fails. Manually verified by mutating
// templates.ts and re-running -- see PR/issue comments.
// =============================================================================

const COMPANY_NAME = "Acme Roofing & Restoration";
const CONTACT_NAME = "Jane Contact";
const EMAIL = "jane@acmeroofing.example.com";
const SIGNUP_TS = "1/1/2026, 12:00:00 PM";

Deno.test("gh-1824 notify-admin-new-contractor: buildEmailText exact-pins the full rendered body for fixed inputs", () => {
  const golden = [
    `New contractor signup on Otter Quotes — review required.`,
    ``,
    `Company  : ${COMPANY_NAME}`,
    `Contact  : ${CONTACT_NAME}`,
    `Email    : ${EMAIL}`,
    `Signed up: ${SIGNUP_TS} CT`,
    ``,
    `Review in admin portal:`,
    ADMIN_PORTAL_URL,
    ``,
    footerPostalAddressText(),
  ].join("\n");
  assertEquals(buildEmailText(COMPANY_NAME, CONTACT_NAME, EMAIL, SIGNUP_TS), golden);
});

Deno.test("gh-1824 notify-admin-new-contractor: buildEmailHtml exact-pins the full rendered body for fixed inputs", () => {
  const golden = `
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
                <td style="padding:8px 0;font-weight:600;">${COMPANY_NAME.replace("&", "&amp;")}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Contact</td>
                <td style="padding:8px 0;">${CONTACT_NAME}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Email</td>
                <td style="padding:8px 0;">
                  <a href="mailto:${EMAIL}" style="color:#0369A1;">${EMAIL}</a>
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Signed up</td>
                <td style="padding:8px 0;">${SIGNUP_TS} CT</td>
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
  assertEquals(buildEmailHtml(COMPANY_NAME, CONTACT_NAME, EMAIL, SIGNUP_TS), golden);
});
