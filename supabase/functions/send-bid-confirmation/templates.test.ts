// Deno unit test for gh-1824 footer-batch-2: send-bid-confirmation's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/send-bid-confirmation/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmailHtml, buildEmailText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const ARGS: [string, string, string, string, number, number, number] = [
  "Jane",
  "Job #12345678",
  "claim-abc-123",
  "Roofing",
  5000,
  10,
  500,
];

Deno.test("gh-1824 send-bid-confirmation: buildEmailHtml includes the D-237 postal address", () => {
  const html = buildEmailHtml(...ARGS);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 send-bid-confirmation: buildEmailText includes the D-237 postal address", () => {
  const text = buildEmailText(...ARGS);
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

const EXPECTED_HTML = "<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"UTF-8\">\n  <style>\n    body { font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; line-height: 1.6; color: #333; }\n    .container { max-width: 600px; margin: 0 auto; padding: 20px; }\n    .header { margin-bottom: 30px; }\n    .section { margin: 20px 0; padding: 15px; border-left: 4px solid #0066cc; background-color: #f5f5f5; }\n    .section-title { font-weight: bold; margin-bottom: 10px; }\n    .summary-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #ddd; }\n    .summary-row:last-child { border-bottom: none; }\n    .label { font-weight: 500; }\n    .value { text-align: right; }\n    .btn { display: inline-block; margin: 8px 4px; padding: 12px 24px; color: #fff; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 14px; }\n    .btn-rescind { background-color: #cc3300; }\n    .btn-review { background-color: #0066cc; }\n    .footer { margin-top: 30px; font-size: 12px; color: #666; border-top: 1px solid #ddd; padding-top: 20px; }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <div class=\"header\">\n      <p>Hi Jane,</p>\n      <p>Your bid for <strong>Job #12345678</strong> has been successfully submitted.</p>\n    </div>\n\n    <div class=\"section\">\n      <div class=\"section-title\">--- BID SUMMARY ---</div>\n      <div class=\"summary-row\">\n        <span class=\"label\">Trade:</span>\n        <span class=\"value\">Roofing</span>\n      </div>\n      <div class=\"summary-row\">\n        <span class=\"label\">Bid Amount:</span>\n        <span class=\"value\">$5,000</span>\n      </div>\n      <div class=\"summary-row\">\n        <span class=\"label\">Platform Fee (10%):</span>\n        <span class=\"value\">$500</span>\n      </div>\n    </div>\n\n    <div class=\"section\">\n      <div class=\"section-title\">--- PLATFORM FEE AGREEMENT ---</div>\n      <p>By submitting this bid, you agreed to pay Otter Quotes a platform fee of 10% ($500) upon contract execution. If the homeowner accepts your bid and executes the contract, this fee will be charged to your card on file. This email serves as confirmation of your fee agreement.</p>\n      <p>Questions? Reply to this email or contact support@otterquote.com.</p>\n      <p>— The Otter Quotes Team</p>\n    </div>\n\n    <div class=\"section\" style=\"border-left-color: #cc3300; text-align: center;\">\n      <div class=\"section-title\">--- YOUR BID IS LIVE ---</div>\n      <p>Not comfortable with these terms? Rescind your bid now. Your offer is currently live and could be accepted by the homeowner at any time.</p>\n      <a href=\"https://otterquote.com/contractor-bid-form.html?action=rescind&claim_id=claim-abc-123\" class=\"btn btn-rescind\">Rescind My Bid</a>\n      <a href=\"https://otterquote.com/contractor-bid-form.html?claim_id=claim-abc-123\" class=\"btn btn-review\">Review My Bid</a>\n    </div>\n\n    <div class=\"footer\">\n      <p>This email confirms your bid submission and fee agreement. Keep this email for your records.</p>\n      <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n    </div>\n  </div>\n</body>\n</html>";
const EXPECTED_TEXT = "Hi Jane,\n\nYour bid for Job #12345678 has been successfully submitted.\n\n--- BID SUMMARY ---\nTrade: Roofing\nBid Amount: $5,000\nPlatform Fee (10%): $500\n\n--- PLATFORM FEE AGREEMENT ---\nBy submitting this bid, you agreed to pay Otter Quotes a platform fee of 10% ($500) upon contract execution. If the homeowner accepts your bid and executes the contract, this fee will be charged to your card on file. This email serves as confirmation of your fee agreement.\n\nQuestions? Reply to this email or contact support@otterquote.com.\n\n— The Otter Quotes Team\n\n--- YOUR BID IS LIVE ---\nNot comfortable with these terms? Rescind your bid now. Your offer is currently live and could be accepted by the homeowner at any time.\n\nRescind My Bid: https://otterquote.com/contractor-bid-form.html?action=rescind&claim_id=claim-abc-123\nReview My Bid: https://otterquote.com/contractor-bid-form.html?claim_id=claim-abc-123\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

Deno.test("gh-1824 send-bid-confirmation: rendered HTML is pinned exactly (golden, catches wording drift)", () => {
  assertEquals(buildEmailHtml(...ARGS), EXPECTED_HTML);
});

Deno.test("gh-1824 send-bid-confirmation: rendered text is pinned exactly (golden, catches wording drift)", () => {
  assertEquals(buildEmailText(...ARGS), EXPECTED_TEXT);
});
