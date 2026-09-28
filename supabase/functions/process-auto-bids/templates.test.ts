// Deno unit test for gh-1824 footer-batch-4: process-auto-bids's rendered
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
// Run: deno test supabase/functions/process-auto-bids/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmailText, buildEmailHtml } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 process-auto-bids: buildEmailText matches the pinned golden body", () => {
  assertEquals(buildEmailText("Jane", 10000, 500, 5), "Hi Jane,\n\nWe automatically submitted a bid on your behalf for a new insurance roofing project.\n\nBid Amount: $10,000.00\nPlatform Fee (5%): $500.00\nProject Type: Insurance full replacement — roofing\n\nView Project: https://otterquote.com/contractor-opportunities.html\n\nTo turn off auto-bidding, visit your auto-bid settings: https://otterquote.com/contractor-auto-bids.html\n\n— The Otter Quotes Team\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-auto-bids: buildEmailHtml matches the pinned golden body", () => {
  assertEquals(buildEmailHtml("Jane", 10000, 500, 5), "<!DOCTYPE html>\n<html>\n<body style=\"font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;\">\n  <h2 style=\"color:#1a3c5e;\">Auto-Bid Submitted ✓</h2>\n  <p>Hi Jane,</p>\n  <p>We automatically submitted a bid on your behalf for a new insurance roofing project.</p>\n  <table style=\"border-collapse:collapse;width:100%;margin:16px 0;\">\n    <tr style=\"background:#f4f6f8;\">\n      <td style=\"padding:8px 12px;font-weight:bold;\">Bid Amount</td>\n      <td style=\"padding:8px 12px;\">$10,000.00</td>\n    </tr>\n    <tr>\n      <td style=\"padding:8px 12px;font-weight:bold;\">Platform Fee (5%)</td>\n      <td style=\"padding:8px 12px;\">$500.00</td>\n    </tr>\n    <tr style=\"background:#f4f6f8;\">\n      <td style=\"padding:8px 12px;font-weight:bold;\">Project Type</td>\n      <td style=\"padding:8px 12px;\">Insurance full replacement — roofing</td>\n    </tr>\n  </table>\n  <p>\n    <a href=\"https://otterquote.com/contractor-opportunities.html\"\n       style=\"display:inline-block;background:#f59e0b;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;\">\n      View Project\n    </a>\n  </p>\n  <p style=\"font-size:13px;color:#666;\">\n    To turn off auto-bidding, visit your\n    <a href=\"https://otterquote.com/contractor-auto-bids.html\">auto-bid settings</a>.\n  </p>\n  <p>— The Otter Quotes Team</p>\n  <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n</body>\n</html>");
});

Deno.test("gh-1824 process-auto-bids: goldens still contain the D-237 postal address (sanity check on the goldens themselves)", () => {
  assertEquals(buildEmailText("Jane", 10000, 500, 5).includes(POSTAL_ADDRESS), true);
  assertEquals(buildEmailHtml("Jane", 10000, 500, 5).includes(POSTAL_ADDRESS), true);
});
