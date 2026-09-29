// Deno unit test for gh-1824 footer-batch-3: mark-payout-paid's rendered
// email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/mark-payout-paid/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { paidEmailText, paidEmailHtml, formatCurrency, formatPayoutType, PARTNER_DASH_URL } from "./templates.ts";
import { POSTAL_ADDRESS, footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

Deno.test("gh-1824 mark-payout-paid: paidEmailText includes the D-237 postal address", () => {
  assertEquals(
    paidEmailText("Jane", formatPayoutType("commission_referral"), formatCurrency(500)).includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 mark-payout-paid: paidEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    paidEmailHtml("Jane", formatPayoutType("commission_recruit"), formatCurrency(500)).includes(POSTAL_ADDRESS),
    true,
  );
});

// =============================================================================
// REVIEW FAIL 5870472283 must-fix: exact-equality goldens for fixed inputs.
//
// Independent copy of the pre-extraction wording from origin/main's
// mark-payout-paid/index.ts, reproduced here as a plain literal with the
// footer wired in exactly as this PR's change does. If templates.ts's
// wording drifts (e.g. "paid" -> "refunded", as the reviewer's own
// negative control demonstrated), this golden still carries the original
// wording and assertEquals fails. Manually verified by mutating
// templates.ts and re-running -- see PR/issue comments.
// =============================================================================

const PARTNER_NAME = "Jane Partner";
const PAYOUT_TYPE = formatPayoutType("commission_referral"); // "Referral Fee"
const AMOUNT = formatCurrency(500); // "$500.00"

Deno.test("gh-1824 mark-payout-paid: paidEmailText exact-pins the full rendered body for fixed inputs", () => {
  const golden = [
    `Hi ${PARTNER_NAME},`,
    ``,
    `Your ${PAYOUT_TYPE.toLowerCase()} of ${AMOUNT} has been marked as paid.`,
    `Thank you for being an Otter Quotes partner.`,
    ``,
    `View your dashboard: ${PARTNER_DASH_URL}`,
    ``,
    footerPostalAddressText(),
  ].join("\n");
  assertEquals(paidEmailText(PARTNER_NAME, PAYOUT_TYPE, AMOUNT), golden);
});

Deno.test("gh-1824 mark-payout-paid: paidEmailHtml exact-pins the full rendered body for fixed inputs", () => {
  const ctaBlock = `
<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="#10B981" style="border-radius:8px;">
      <a href="${PARTNER_DASH_URL}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">
        View Your Dashboard →
      </a>
    </td>
  </tr>
</table>`.trim();

  const bodyHtml = `
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  Your referral fee has been paid!
</h2>
<p style="color:#374151;font-size:0.95rem;margin:0 0 24px;">
  Hi ${PARTNER_NAME}, your ${PAYOUT_TYPE.toLowerCase()} of <strong>${AMOUNT}</strong> has been marked as paid.
  Thank you for being an Otter Quotes partner.
</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#F0FDF4;border-radius:8px;border:1px solid #BBF7D0;margin-bottom:24px;">
  <tr>
    <td style="padding:20px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:4px 0;font-size:0.875rem;color:#64748B;width:140px;">Referral Fee Type</td>
          <td style="padding:4px 0;font-size:0.875rem;font-weight:600;color:#0B1929;">${PAYOUT_TYPE}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-size:0.875rem;color:#64748B;">Amount</td>
          <td style="padding:4px 0;font-size:1.25rem;font-weight:700;color:#10B981;">${AMOUNT}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-size:0.875rem;color:#64748B;">Status</td>
          <td style="padding:4px 0;font-size:0.875rem;font-weight:600;color:#10B981;">✓ Paid</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

${ctaBlock}

<p style="font-size:0.8rem;color:#94A3B8;">
  Questions? Email us at
  <a href="mailto:support@otterquote.com" style="color:#0EA5E9;">support@otterquote.com</a>.
</p>
`;
  const golden = buildGoldenEmail(bodyHtml);
  assertEquals(paidEmailHtml(PARTNER_NAME, PAYOUT_TYPE, AMOUNT), golden);
});

/** Independent copy of templates.ts's buildEmail()/emailFooter() shell, for golden construction only. */
function buildGoldenEmail(bodyHtml: string): string {
  const footer = `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
      ${footerPostalAddressHtml()}
    </td>
  </tr>
</table>`.trim();
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
        <tr><td>${footer}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}
