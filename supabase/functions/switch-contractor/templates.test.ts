// Deno unit test for gh-1824 footer-batch-5: switch-contractor's contractor
// notification and internal support alert must both carry the D-237 postal
// address.
// Run: deno test supabase/functions/switch-contractor/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  contractorSwitchEmailHtml,
  contractorSwitchEmailText,
  switchSupportEmailText,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const REFUND_LINE = "Your platform fee has been refunded in full.";

Deno.test("gh-1824 switch-contractor: contractorSwitchEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    contractorSwitchEmailHtml("Acme Roofing", REFUND_LINE).includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 switch-contractor: contractorSwitchEmailText includes the D-237 postal address", () => {
  assertEquals(
    contractorSwitchEmailText("Acme Roofing", REFUND_LINE).includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 switch-contractor: switchSupportEmailText (internal, to Dustin) includes the D-237 postal address", () => {
  assertEquals(
    switchSupportEmailText("claim-123", "123 Main St", "Acme Roofing", true, "price", "none").includes(POSTAL_ADDRESS),
    true,
  );
});

// ---------------------------------------------------------------------------
// gh-1824 REVIEW FAIL 5870472283 on #2292 / HOLD 5870481359 on #2286: pin the
// full rendered text AND HTML for all three builders, not just an
// .includes() check -- see process-payout-reminders/templates.test.ts for
// the fuller explanation of how these goldens were captured.
// ---------------------------------------------------------------------------

const GOLDEN_HTML = `<!DOCTYPE html>
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
            
    <p style="margin:0 0 16px;">Hi Acme Roofing,</p>
    <p style="margin:0 0 16px;">We're writing to let you know that the homeowner on the following project has chosen to switch contractors through Otter Quotes.</p>
    <p style="margin:0 0 16px;">This is a platform feature available to homeowners up to 3 days before their scheduled installation date.</p>
    <p style="margin:0 0 16px;">Your platform fee has been refunded in full.</p>
    <p style="margin:0 0 16px;">The project has been re-opened to the Otter Quotes contractor network. You are welcome to bid again when it reappears in your Opportunities dashboard.</p>
    <p style="margin:0 0 16px;">We appreciate your participation on Otter Quotes and look forward to connecting you with future projects.</p>
    <p style="margin:0;">Best regards,<br>The Otter Quotes Team</p>
  
          </td>
        </tr>
        <tr>
          <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
            <div style="margin-top:6px;">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

const GOLDEN_TEXT = `Hi Acme Roofing,

We're writing to let you know that the homeowner on the following project has chosen to switch contractors through Otter Quotes.

This is a platform feature available to homeowners up to 3 days before their scheduled installation date.

Your platform fee has been refunded in full.

The project has been re-opened to the Otter Quotes contractor network. You are welcome to bid again when it reappears in your Opportunities dashboard.

We appreciate your participation on Otter Quotes and look forward to connecting you with future projects.

Best regards,
The Otter Quotes Team
support@otterquote.com | (844) 875-3412

Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224`;

const GOLDEN_SUPPORT_TEXT = `[Action Required] Homeowner contractor switch — 123 Main St

A homeowner has submitted a contractor switch request. Per D-171, please contact them directly to confirm their next contractor placement.

Claim ID:        claim-123
Property:        123 Main St
Original contractor: Acme Roofing
Refund issued:   Yes

--- Homeowner Switch Survey ---
Reasons selected: price
Additional notes: none

Please reach out to the homeowner to confirm their new contractor placement.
Admin: https://otterquote.com/admin-contractors.html

— OtterQuote automated alert

Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224`;

Deno.test("gh-1824 switch-contractor: contractorSwitchEmailHtml(...) exact-matches the pinned golden HTML", () => {
  assertEquals(contractorSwitchEmailHtml("Acme Roofing", REFUND_LINE), GOLDEN_HTML);
});

Deno.test("gh-1824 switch-contractor: contractorSwitchEmailText(...) exact-matches the pinned golden text", () => {
  assertEquals(contractorSwitchEmailText("Acme Roofing", REFUND_LINE), GOLDEN_TEXT);
});

Deno.test("gh-1824 switch-contractor: switchSupportEmailText(...) exact-matches the pinned golden text", () => {
  assertEquals(
    switchSupportEmailText("claim-123", "123 Main St", "Acme Roofing", true, "price", "none"),
    GOLDEN_SUPPORT_TEXT,
  );
});
