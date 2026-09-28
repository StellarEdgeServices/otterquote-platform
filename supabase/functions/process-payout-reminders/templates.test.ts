// Deno unit test for gh-1824 footer-batch-5: process-payout-reminders' Day-2
// digest email must carry the D-237 postal address.
// Run: deno test supabase/functions/process-payout-reminders/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmail, reminderDigestBodyHtml, reminderDigestBodyText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

// created_at is deliberately null (renders "—", TZ-independent) -- an
// absolute UTC timestamp here made the golden below flaky across the dev
// sandbox's local TZ vs. the CI runner's TZ (the sandbox rendered "Sep 1"
// for 2026-09-01T00:00:00Z, CI rendered "Aug 31" -- toLocaleDateString()
// is local-TZ-sensitive, which a pinned golden must never depend on).
const ROW = { partner_name: "Acme Roofing", amount: 125.5, payout_type: "commission_referral", created_at: null as string | null };
const URL = "https://otterquote.com/admin-payouts.html";

Deno.test("gh-1824 process-payout-reminders: reminderDigestBodyText includes the D-237 postal address", () => {
  assertEquals(reminderDigestBodyText([ROW], 125.5, URL).includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-payout-reminders: buildEmail(reminderDigestBodyHtml(...)) includes the D-237 postal address in the rendered HTML shell", () => {
  const html = buildEmail(reminderDigestBodyHtml([ROW], 125.5, URL));
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

// ---------------------------------------------------------------------------
// gh-1824 REVIEW FAIL 5870472283 on #2292 / HOLD 5870481359 on #2286: an
// .includes() check does not pin the rendered body -- a one-word change to
// the commission/amount/partner text would pass silently. These exact-
// equality tests pin the FULL rendered text and HTML for fixed inputs.
// Golden captured by: (1) confirming the body-building logic here is
// byte-identical to the pre-extraction code on origin/main (diffed during
// this PR's construction -- only the footer lines and the export/import
// wrapper changed, see the PR description), then (2) rendering with the
// fixed ROW/URL inputs above and recording the exact output as the golden
// below (see scratchpad/goldens/gen_ppr.ts in this session for the capture
// script). A negative control (a one-word change to this golden) was run
// and confirmed to fail -- see the HANDOFF-LIVE delta on PR #2293.
// ---------------------------------------------------------------------------

const GOLDEN_HTML = `<!DOCTYPE html>
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
            
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  ⏰ Reminder: 1 Commission Awaiting Approval
</h2>
<p style="color:#374151;font-size:0.95rem;margin:0 0 24px;">
  The following commissions have been pending for more than 2 days and require your review.
  Total pending: <strong>$125.50</strong>
</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border-radius:8px;border:1px solid #E2E8F0;overflow:hidden;margin-bottom:24px;">
  <thead>
    <tr style="background:#F8FAFC;">
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Partner</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Type</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Amount</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Pending Since</th>
    </tr>
  </thead>
  <tbody>
<tr>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#0B1929;">Acme Roofing</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#64748B;">Referral</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;font-weight:600;color:#0B1929;">$125.50</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#EF4444;">—</td>
</tr></tbody>
</table>

<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="https://otterquote.com/admin-payouts.html" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="15%" strokecolor="#E07B00" fillcolor="#E07B00">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;">Review All Pending Approvals →</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="#E07B00" style="border-radius:8px;">
      <a href="https://otterquote.com/admin-payouts.html" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">Review All Pending Approvals →</a>
    </td>
  </tr>
</table>
<!--<![endif]-->

          </td>
        </tr>
        <tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      <div style="margin-top:6px;">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>
    </td>
  </tr>
</table></td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

const GOLDEN_TEXT = `Reminder: 1 commission(s) awaiting approval (>2 days pending)
Total: $125.50

- Acme Roofing: $125.50 (Referral)

Review here: https://otterquote.com/admin-payouts.html

Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224`;

Deno.test("gh-1824 process-payout-reminders: buildEmail(reminderDigestBodyHtml(...)) exact-matches the pinned golden HTML", () => {
  assertEquals(buildEmail(reminderDigestBodyHtml([ROW], 125.5, URL)), GOLDEN_HTML);
});

Deno.test("gh-1824 process-payout-reminders: reminderDigestBodyText(...) exact-matches the pinned golden text", () => {
  assertEquals(reminderDigestBodyText([ROW], 125.5, URL), GOLDEN_TEXT);
});

// ---------------------------------------------------------------------------
// gh-1824 REVIEW FAIL 5871298554 on #2293 (nit): the ROW fixture above only
// exercises payout_type "commission_referral" ("Referral"), so the
// "Recruit Bonus" branch of formatPayoutType() was never pinned. Add a
// second fixture/golden with any other payout_type to cover it.
// ---------------------------------------------------------------------------

const ROW2 = { partner_name: "Beta Gutters", amount: 200, payout_type: "commission_recruit", created_at: null as string | null };

const GOLDEN_HTML_RECRUIT = `<!DOCTYPE html>
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
            
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  ⏰ Reminder: 1 Commission Awaiting Approval
</h2>
<p style="color:#374151;font-size:0.95rem;margin:0 0 24px;">
  The following commissions have been pending for more than 2 days and require your review.
  Total pending: <strong>$200.00</strong>
</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border-radius:8px;border:1px solid #E2E8F0;overflow:hidden;margin-bottom:24px;">
  <thead>
    <tr style="background:#F8FAFC;">
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Partner</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Type</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Amount</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Pending Since</th>
    </tr>
  </thead>
  <tbody>
<tr>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#0B1929;">Beta Gutters</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#64748B;">Recruit Bonus</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;font-weight:600;color:#0B1929;">$200.00</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#EF4444;">—</td>
</tr></tbody>
</table>

<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="https://otterquote.com/admin-payouts.html" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="15%" strokecolor="#E07B00" fillcolor="#E07B00">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;">Review All Pending Approvals →</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="#E07B00" style="border-radius:8px;">
      <a href="https://otterquote.com/admin-payouts.html" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">Review All Pending Approvals →</a>
    </td>
  </tr>
</table>
<!--<![endif]-->

          </td>
        </tr>
        <tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      <div style="margin-top:6px;">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>
    </td>
  </tr>
</table></td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

const GOLDEN_TEXT_RECRUIT = `Reminder: 1 commission(s) awaiting approval (>2 days pending)
Total: $200.00

- Beta Gutters: $200.00 (Recruit Bonus)

Review here: https://otterquote.com/admin-payouts.html

Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224`;

Deno.test("gh-1824 process-payout-reminders: buildEmail(reminderDigestBodyHtml(...)) exact-matches the pinned golden HTML for the Recruit Bonus branch", () => {
  assertEquals(buildEmail(reminderDigestBodyHtml([ROW2], 200, URL)), GOLDEN_HTML_RECRUIT);
});

Deno.test("gh-1824 process-payout-reminders: reminderDigestBodyText(...) exact-matches the pinned golden text for the Recruit Bonus branch", () => {
  assertEquals(reminderDigestBodyText([ROW2], 200, URL), GOLDEN_TEXT_RECRUIT);
});
