// Deno unit test for gh-1824 footer-batch-5: resend-hover-link's homeowner
// measurement-link reminder must carry the D-237 postal address (both parts).
// Run: deno test supabase/functions/resend-hover-link/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildHtmlBody, buildTextBody } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 resend-hover-link: buildHtmlBody includes the D-237 postal address", () => {
  assertEquals(
    buildHtmlBody("Jane", "123 Main St", "https://hover.example/capture/abc").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 resend-hover-link: buildTextBody includes the D-237 postal address", () => {
  assertEquals(
    buildTextBody("Jane", "123 Main St", "https://hover.example/capture/abc").includes(POSTAL_ADDRESS),
    true,
  );
});

// ---------------------------------------------------------------------------
// gh-1824 REVIEW FAIL 5870472283 on #2292 / HOLD 5870481359 on #2286: pin the
// full rendered text AND HTML, not just an .includes() check -- see
// process-payout-reminders/templates.test.ts for the fuller explanation of
// how this golden was captured.
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
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            
<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Hi Jane,</p>
<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Here&rsquo;s a reminder with your measurement link for <strong>123 Main St</strong>.</p>
<p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">To get accurate bids from contractors, we need aerial measurements of your roof. It&rsquo;s easy &mdash; just use the button below to submit photos from your phone or computer, and professional measurements will be generated automatically.</p>
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="https://hover.example/capture/abc" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="15%" strokecolor="#E07B00" fillcolor="#E07B00">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;">Open Your Measurement Link →</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="#E07B00" style="border-radius:8px;">
      <a href="https://hover.example/capture/abc" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">Open Your Measurement Link →</a>
    </td>
  </tr>
</table>
<!--<![endif]-->
<p style="margin:20px 0 8px;color:#374151;font-size:15px;font-weight:600;">What to do:</p>
<ol style="margin:0 0 20px;padding-left:20px;color:#374151;font-size:15px;line-height:1.8;">
  <li>Click the button above</li>
  <li>Follow the on-screen instructions to submit photos</li>
  <li>Your photos will be processed to generate measurements</li>
  <li>You&rsquo;ll be notified when measurements are ready</li>
</ol>
<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">This usually takes less than 24 hours. Once complete, you&rsquo;ll be able to submit your project for contractor bids.</p>
<p style="margin:0;color:#64748B;font-size:13px;line-height:1.6;">If you have questions, reply to this email or call us at (844) 875-3412.</p>

          </td>
        </tr>
        <tr>
          <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
            <div style="margin-top:6px;">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

const GOLDEN_TEXT = `Hi Jane,

Here's a reminder with your measurement link for 123 Main St.

To get accurate bids from contractors, we need aerial measurements of your roof. It's easy — just use the link below to submit photos from your phone or computer, and professional measurements will be generated automatically.

Your Measurement Link:
https://hover.example/capture/abc

What to do:
1. Click the link above
2. Follow the on-screen instructions to submit photos
3. Your photos will be processed to generate measurements
4. You'll be notified when measurements are ready

This usually takes less than 24 hours. Once complete, you'll be able to submit your project for contractor bids.

If you have questions, reply to this email or call us at (844) 875-3412.

The Otter Quotes Team
https://otterquote.com

Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224`;

Deno.test("gh-1824 resend-hover-link: buildHtmlBody(...) exact-matches the pinned golden HTML", () => {
  assertEquals(buildHtmlBody("Jane", "123 Main St", "https://hover.example/capture/abc"), GOLDEN_HTML);
});

Deno.test("gh-1824 resend-hover-link: buildTextBody(...) exact-matches the pinned golden text", () => {
  assertEquals(buildTextBody("Jane", "123 Main St", "https://hover.example/capture/abc"), GOLDEN_TEXT);
});
