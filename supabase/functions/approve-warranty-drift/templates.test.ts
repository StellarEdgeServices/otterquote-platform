// Deno unit test for gh-1824 footer-batch-3: approve-warranty-drift's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/approve-warranty-drift/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { deprecatedWarrantyEmailText, deprecatedWarrantyEmailHtml } from "./templates.ts";
import { POSTAL_ADDRESS, footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

Deno.test("gh-1824 approve-warranty-drift: deprecatedWarrantyEmailText includes the D-237 postal address", () => {
  assertEquals(
    deprecatedWarrantyEmailText("Acme Roofing", "GAF", "Golden Pledge").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 approve-warranty-drift: deprecatedWarrantyEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    deprecatedWarrantyEmailHtml("Acme Roofing", "GAF", "Golden Pledge").includes(POSTAL_ADDRESS),
    true,
  );
});

// =============================================================================
// REVIEW FAIL 5870472283 must-fix: exact-equality goldens for fixed inputs.
//
// Independent copy of the pre-extraction wording from origin/main's
// approve-warranty-drift/index.ts, reproduced here as a plain literal with
// the footer wired in exactly as this PR's change does. If templates.ts's
// wording drifts, this golden still carries the original wording and
// assertEquals fails. Manually verified by mutating templates.ts and
// re-running -- see PR/issue comments.
// =============================================================================

const BUSINESS_NAME = "Acme Roofing & Restoration";
const MANUFACTURER = "GAF";
const TIER = "Golden Pledge";

Deno.test("gh-1824 approve-warranty-drift: deprecatedWarrantyEmailText exact-pins the full rendered body for fixed inputs", () => {
  const golden = [
    `Hi ${BUSINESS_NAME},`,
    ``,
    `We wanted to let you know that the ${MANUFACTURER} ${TIER} warranty program`,
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
  assertEquals(deprecatedWarrantyEmailText(BUSINESS_NAME, MANUFACTURER, TIER), golden);
});

Deno.test("gh-1824 approve-warranty-drift: deprecatedWarrantyEmailHtml exact-pins the full rendered body for fixed inputs", () => {
  const body = `
    <p style="margin:0 0 16px;">Hi ${escapeHtmlGolden(BUSINESS_NAME)},</p>
    <p style="margin:0 0 16px;">We wanted to let you know that the ${escapeHtmlGolden(MANUFACTURER)} ${escapeHtmlGolden(TIER)} warranty program has been updated in the Otter Quotes platform.</p>
    <p style="margin:0 0 16px;">Please log in to your contractor profile and review your saved warranty selections to ensure they reflect the current program offerings.</p>
    <p style="margin:0 0 16px;">If you have any questions, reply to this email.</p>
    <p style="margin:0;">&mdash; Otter Quotes Platform</p>
  `;
  const golden = buildGoldenEmail(body);
  assertEquals(deprecatedWarrantyEmailHtml(BUSINESS_NAME, MANUFACTURER, TIER), golden);
});

/** Independent copy of templates.ts's escapeHtml(), for golden construction only. */
function escapeHtmlGolden(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/** Independent copy of templates.ts's buildEmail() shell, for golden construction only. */
function buildGoldenEmail(bodyHtml: string): string {
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
