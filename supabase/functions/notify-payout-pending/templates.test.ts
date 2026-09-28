// Deno unit test for gh-1824 footer-batch-4: notify-payout-pending's rendered
// email bodies must carry the D-237 postal address, AND must pin the full
// rendered text/HTML for fixed inputs -- not just assert the address is
// present. Rationale (Marty's HOLD 5870481359 on #2286, REVIEW: FAIL
// 5870472283 on #2292): a `.includes(POSTAL_ADDRESS)`-only test lets a
// one-word change to the body ship undetected, because the footer is still
// there. Every golden below was captured by rendering this file's current
// (post-extraction) template functions and diffing the result, line by
// line, against the pre-extraction body text removed from index.ts on this
// branch -- the two are byte-identical except for the appended D-237 footer
// line(s), so the golden below IS the pre-extraction body + footer.
// Run: deno test supabase/functions/notify-payout-pending/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { payoutPendingEmailHtml, payoutPendingEmailText, formatCurrency, formatPayoutType } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const HTML_ARGS: [string, string, string, string, string, string] =
  ["Jane's Roofing", "$500.00", "Referral Commission", "October 1, 2026", "Commission qualifying event", "approval-1"];
const TEXT_ARGS: [string, string, string, string, string] =
  ["Jane's Roofing", "$500.00", "Referral Commission", "October 1, 2026", "Commission qualifying event"];

Deno.test("gh-1824 notify-payout-pending: payoutPendingEmailHtml matches the pinned golden body", () => {
  assertEquals(payoutPendingEmailHtml(...HTML_ARGS), "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>\n<body style=\"margin:0;padding:0;background:#F1F5F9;\">\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:#F1F5F9;\">\n  <tr>\n    <td align=\"center\" style=\"padding:24px 16px;\">\n      <table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"\n             style=\"max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);\">\n        <tr>\n          <td align=\"left\" style=\"background:#0B1929;padding:24px 32px;\">\n            <span style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\n                         font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;\">\n              Otter Quotes\n            </span>\n          </td>\n        </tr>\n        <tr>\n          <td style=\"padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\">\n            \n<h2 style=\"font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;\">\n  Action Required: Commission Approval\n</h2>\n<p style=\"color:#64748B;font-size:0.9rem;margin:0 0 24px;\">\n  A commission is pending your review and approval.\n</p>\n\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"\n       style=\"background:#F8FAFC;border-radius:8px;border:1px solid #E2E8F0;margin-bottom:24px;\">\n  <tr>\n    <td style=\"padding:20px 24px;\">\n      <table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">\n        <tr>\n          <td style=\"padding:6px 0;font-size:0.875rem;color:#64748B;width:160px;\">Partner Name</td>\n          <td style=\"padding:6px 0;font-size:0.875rem;font-weight:600;color:#0B1929;\">Jane's Roofing</td>\n        </tr>\n        <tr>\n          <td style=\"padding:6px 0;font-size:0.875rem;color:#64748B;\">Commission Type</td>\n          <td style=\"padding:6px 0;font-size:0.875rem;font-weight:600;color:#0B1929;\">Referral Commission</td>\n        </tr>\n        <tr>\n          <td style=\"padding:6px 0;font-size:0.875rem;color:#64748B;\">Amount</td>\n          <td style=\"padding:6px 0;font-size:1.25rem;font-weight:700;color:#0B1929;\">$500.00</td>\n        </tr>\n        <tr>\n          <td style=\"padding:6px 0;font-size:0.875rem;color:#64748B;\">Trigger Event</td>\n          <td style=\"padding:6px 0;font-size:0.875rem;color:#0B1929;\">Commission qualifying event</td>\n        </tr>\n        <tr>\n          <td style=\"padding:6px 0;font-size:0.875rem;color:#64748B;\">Auto-Approves</td>\n          <td style=\"padding:6px 0;font-size:0.875rem;color:#0B1929;\">October 1, 2026 if no action taken</td>\n        </tr>\n        <tr>\n          <td style=\"padding:6px 0;font-size:0.875rem;color:#64748B;\">Approval ID</td>\n          <td style=\"padding:6px 0;font-size:0.75rem;color:#94A3B8;font-family:monospace;\">approval-1</td>\n        </tr>\n      </table>\n    </td>\n  </tr>\n</table>\n\n<!--[if mso]>\n<v:roundrect xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:w=\"urn:schemas-microsoft-com:office:word\" href=\"https://otterquote.com/admin-payouts.html\" style=\"height:44px;v-text-anchor:middle;width:260px;\" arcsize=\"15%\" strokecolor=\"#E07B00\" fillcolor=\"#E07B00\">\n  <w:anchorlock/>\n  <center style=\"color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;\">Review in Admin →</center>\n</v:roundrect>\n<![endif]-->\n<!--[if !mso]><!-->\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:24px 0;\">\n  <tr>\n    <td align=\"center\" bgcolor=\"#E07B00\" style=\"border-radius:8px;\">\n      <a href=\"https://otterquote.com/admin-payouts.html\" style=\"display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;\">Review in Admin →</a>\n    </td>\n  </tr>\n</table>\n<!--<![endif]-->\n\n<p style=\"font-size:0.8rem;color:#94A3B8;margin-top:16px;\">\n  You have until October 1, 2026 to approve or reject this commission. After that, it will auto-approve automatically.\n</p>\n\n          </td>\n        </tr>\n        <tr><td><table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">\n  <tr>\n    <td align=\"center\" style=\"background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;\n        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;\">\n      <a href=\"mailto:support@otterquote.com\" style=\"color:#0EA5E9;text-decoration:none;\">support@otterquote.com</a>\n      <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n    </td>\n  </tr>\n</table></td></tr>\n      </table>\n    </td>\n  </tr>\n</table>\n</body>\n</html>");
});

Deno.test("gh-1824 notify-payout-pending: payoutPendingEmailText matches the pinned golden body", () => {
  assertEquals(payoutPendingEmailText(...TEXT_ARGS), "Action Required: Commission Approval\n\nPartner: Jane's Roofing\nType: Referral Commission\nAmount: $500.00\nTrigger: Commission qualifying event\nAuto-Approves: October 1, 2026\n\nReview here: https://otterquote.com/admin-payouts.html\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 notify-payout-pending: formatCurrency/formatPayoutType still work after extraction", () => {
  assertEquals(formatCurrency(1234.5), "$1,234.50");
  assertEquals(formatPayoutType("commission_referral"), "Referral Commission");
  assertEquals(formatPayoutType("recruit_bonus"), "Recruit Bonus");
});

Deno.test("gh-1824 notify-payout-pending: goldens still contain the D-237 postal address (sanity check on the goldens themselves)", () => {
  assertEquals(payoutPendingEmailHtml(...HTML_ARGS).includes(POSTAL_ADDRESS), true);
  assertEquals(payoutPendingEmailText(...TEXT_ARGS).includes(POSTAL_ADDRESS), true);
});
