// Deno unit test for gh-1824 footer-batch-2: send-incomplete-onboarding-
// reminders' rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/send-incomplete-onboarding-reminders/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildReminderEmail, buildReminderText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 send-incomplete-onboarding-reminders: buildReminderEmail includes the D-237 postal address", () => {
  const html = buildReminderEmail("Jane Doe");
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 send-incomplete-onboarding-reminders: buildReminderText includes the D-237 postal address", () => {
  const text = buildReminderText("Jane Doe");
  assertEquals(text.includes(POSTAL_ADDRESS), true);
});
// --- Must-fix per REVIEW: FAIL 5870472283 / HOLD 5870481359 -------------
// The includes()-only tests above would pass even if a word in the body
// changed (e.g. "approved" -> "denied" elsewhere in this series). These
// two tests pin the FULL rendered HTML and text for fixed inputs, golden-
// captured from this branch's pre-fix templates.ts (main's body content is
// unchanged by gh-1824 batch 2 -- the footer line is the only addition,
// per REVIEW: PASS 5869715273's body diff) plus the D-237 footer. A
// one-word change to either builder's wording will fail these tests.
// Negative control performed by hand for this PR (see HANDOFF-LIVE on
// #2286): changing one word in templates.ts made these two fail while the
// includes() tests above kept passing; reverted before push.

const EXPECTED_HTML = "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>\n<body style=\"margin:0;padding:0;background:#F1F5F9;\">\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:#F1F5F9;\">\n  <tr>\n    <td align=\"center\" style=\"padding:24px 16px;\">\n      <table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);\">\n        <tr>\n          <td align=\"left\" style=\"background:#0B1929;padding:24px 32px;\">\n            <span style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;\">Otter Quotes</span>\n          </td>\n        </tr>\n        <tr>\n          <td style=\"padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\">\n            <p style=\"margin:0 0 16px;font-size:16px;color:#1E293B;\">Hi Jane,</p>\n            <p style=\"margin:0 0 16px;font-size:16px;color:#1E293B;line-height:1.6;\">\n              You started your application to join the Otter Quotes contractor network but haven't finished yet.\n            </p>\n            <p style=\"margin:0 0 24px;font-size:16px;color:#1E293B;line-height:1.6;\">\n              It only takes a few more minutes to complete. Pick up right where you left off — your progress has been saved.\n            </p>\n            <table cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 24px;\">\n              <tr>\n                <td style=\"background:#E07B00;border-radius:8px;padding:14px 28px;\">\n                  <a href=\"https://otterquote.com/contractor-pre-approval.html\"\n                     style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;\">\n                    Complete Your Application →\n                  </a>\n                </td>\n              </tr>\n            </table>\n            <p style=\"margin:0 0 8px;font-size:14px;color:#64748B;line-height:1.6;\">\n              Once approved, you'll receive signed contracts directly — no cold calls, no chasing prospects.\n            </p>\n            <p style=\"margin:0;font-size:14px;color:#64748B;\">\n              Questions? Reply to this email or contact\n              <a href=\"mailto:support@otterquote.com\" style=\"color:#E07B00;\">support@otterquote.com</a>.\n            </p>\n          </td>\n        </tr>\n        <tr>\n          <td align=\"center\" style=\"background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;\">\n            <a href=\"mailto:support@otterquote.com\" style=\"color:#0EA5E9;text-decoration:none;\">support@otterquote.com</a>\n            &nbsp;&nbsp;|&nbsp;&nbsp;\n            <a href=\"tel:+18448753412\" style=\"color:#0EA5E9;text-decoration:none;\">(844) 875-3412</a>\n            <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n          </td>\n        </tr>\n      </table>\n    </td>\n  </tr>\n</table>\n</body>\n</html>";
const EXPECTED_TEXT = "Hi Jane Doe,\n\nYou started your application to join the Otter Quotes contractor network but haven't finished yet.\n\nPick up where you left off: https://otterquote.com/contractor-pre-approval.html\n\nQuestions? Contact support@otterquote.com\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

Deno.test("gh-1824 send-incomplete-onboarding-reminders: rendered HTML is pinned exactly (golden, catches wording drift)", () => {
  assertEquals(buildReminderEmail("Jane Doe"), EXPECTED_HTML);
});

Deno.test("gh-1824 send-incomplete-onboarding-reminders: rendered text is pinned exactly (golden, catches wording drift)", () => {
  assertEquals(buildReminderText("Jane Doe"), EXPECTED_TEXT);
});
