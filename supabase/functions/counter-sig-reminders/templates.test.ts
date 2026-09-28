// Deno unit test for gh-1824 footer-batch-3: counter-sig-reminders'
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/counter-sig-reminders/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildReminderEmail, CONTRACTOR_DASHBOARD_URL } from "./templates.ts";
import { POSTAL_ADDRESS, footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

Deno.test("gh-1824 counter-sig-reminders: buildReminderEmail text includes the D-237 postal address", () => {
  const { text } = buildReminderEmail({
    contractorName: "Jane",
    propertyAddress: "123 Main St",
    jobNumber: "J-1001",
    hoursSinceSigned: 4,
  });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 counter-sig-reminders: buildReminderEmail html includes the D-237 postal address", () => {
  const { html } = buildReminderEmail({
    contractorName: "Jane",
    propertyAddress: "123 Main St",
    jobNumber: "J-1001",
    hoursSinceSigned: 4,
  });
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

// =============================================================================
// REVIEW FAIL 5870472283 must-fix: exact-equality goldens for fixed inputs.
//
// Independent copy of the pre-extraction wording from origin/main's
// counter-sig-reminders/index.ts, reproduced here as a plain literal with
// the footer wired in exactly as this PR's change does. If templates.ts's
// wording drifts, this golden still carries the original wording and
// assertEquals fails. Manually verified by mutating templates.ts and
// re-running -- see PR/issue comments.
// =============================================================================

const CONTRACTOR_NAME = "Jane Contractor";
const PROPERTY_ADDRESS = "123 Main St, Indianapolis, IN";
const JOB_NUMBER = "J-1001";
const HOURS_SINCE_SIGNED = 4;

Deno.test("gh-1824 counter-sig-reminders: buildReminderEmail exact-pins subject, text and html for fixed inputs", () => {
  const { subject, text, html } = buildReminderEmail({
    contractorName: CONTRACTOR_NAME,
    propertyAddress: PROPERTY_ADDRESS,
    jobNumber: JOB_NUMBER,
    hoursSinceSigned: HOURS_SINCE_SIGNED,
  });

  const goldenSubject = "Reminder: contract awaiting your counter-signature";
  assertEquals(subject, goldenSubject);

  const goldenText = `Hi ${CONTRACTOR_NAME},

The homeowner signed the contract for ${PROPERTY_ADDRESS} (${JOB_NUMBER}) about ${HOURS_SINCE_SIGNED} hours ago, and it is still awaiting your counter-signature.

Once you sign, the agreement is fully executed and the project can move forward.

Counter-sign from your dashboard:
${CONTRACTOR_DASHBOARD_URL}

You will continue to receive these reminders every 2 hours during business hours until the contract is fully executed.

Questions? Reply to this email or call (844) 875-3412.

— The Otter Quotes Team

${footerPostalAddressText()}`;
  assertEquals(text, goldenText);

  const bodyHtml = `
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Hi ${CONTRACTOR_NAME},
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      The homeowner signed the contract for <strong>${PROPERTY_ADDRESS}</strong>
      (${JOB_NUMBER}) about <strong>${HOURS_SINCE_SIGNED} hours ago</strong>, and it is
      still awaiting your counter-signature.
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Once you sign, the agreement is fully executed and the project can move forward.
    </p>
    <p style="margin:0;color:#3D4F60;font-size:13px;line-height:1.6;">
      You will continue to receive these reminders every 2 hours during business
      hours until the contract is fully executed.
    </p>`;
  const goldenHtml = buildGoldenWrapEmail({
    heading: "Contract awaiting your counter-signature",
    bodyHtml,
    ctaText: "Counter-Sign Now",
    ctaUrl: CONTRACTOR_DASHBOARD_URL,
  });
  assertEquals(html, goldenHtml);
});

/** Independent copy of templates.ts's wrapEmail(), for golden construction only. */
function buildGoldenWrapEmail(params: {
  heading: string;
  bodyHtml: string;
  ctaText: string;
  ctaUrl: string;
}): string {
  const { heading, bodyHtml, ctaText, ctaUrl } = params;

  const ctaBlock = `<p style="text-align:center;margin:28px 0 0;">
         <a href="${ctaUrl}"
            style="display:inline-block;background:#E07B00;color:#fff;padding:13px 28px;
                   border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;
                   letter-spacing:0.01em;">
           ${ctaText}
         </a>
       </p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#F8F9FC;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F9FC;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:10px;overflow:hidden;
                      box-shadow:0 2px 8px rgba(0,0,0,0.07);">
          <!-- Header bar -->
          <tr>
            <td style="background:#0D1B2E;padding:20px 32px;">
              <span style="color:#E07B00;font-size:20px;font-weight:700;
                           letter-spacing:0.03em;">Otter Quotes</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 32px 24px;">
              <h2 style="margin:0 0 18px;color:#0D1B2E;font-size:20px;
                          font-weight:700;line-height:1.3;">${heading}</h2>
              ${bodyHtml}
              ${ctaBlock}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#F8F9FC;padding:16px 32px;
                       border-top:1px solid #E2E8F0;">
              <p style="margin:0;color:#94A3B8;font-size:11px;line-height:1.5;">
                Otter Quotes &nbsp;&bull;&nbsp; Powered by Stellar Edge Services LLC
                &nbsp;&bull;&nbsp;
                <a href="https://otterquote.com" style="color:#94A3B8;">otterquote.com</a>
                <br />
                You received this email because you have an active contractor account.
                Questions? Reply to this email or call (844) 875-3412.
                ${footerPostalAddressHtml()}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
