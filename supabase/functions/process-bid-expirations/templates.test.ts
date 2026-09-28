// Deno unit test for gh-1824 footer-batch-4: process-bid-expirations's rendered
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
// Run: deno test supabase/functions/process-bid-expirations/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildBidExpiredEmail,
  buildAutoRenewedEmail,
  buildRenewalCapEmail,
  buildBidWindowExpiredHomeownerEmail,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 process-bid-expirations: buildBidExpiredEmail matches the pinned golden body", () => {
  const { subject, text, html } = buildBidExpiredEmail({
    contractorName: "Jane",
    homeownerAddress: "123 Main St",
    tradeLabel: "roofing",
    quoteId: "quote-1",
    mailgunDomain: "mg.example.com",
  });
  assertEquals(subject, "Your roofing bid has expired — renew in one click");
  assertEquals(text, "Hi Jane,\n\nYour roofing bid for the property at 123 Main St has expired (14-day window).\n\nThe homeowner can still see your bid but cannot select you until it's renewed.\n\nRenew your bid: https://otterquote.com/contractor-bid-form.html?renew=quote-1\n\nIf you're no longer interested in this project, no action is needed.\n\n— The Otter Quotes Team\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
  assertEquals(html, "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body style=\"font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;\">\n  <div style=\"max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;\">\n    <img src=\"https://otterquote.com/img/otter-logo.svg\" alt=\"Otter Quotes\" width=\"40\" style=\"margin-bottom:16px;\" />\n    <h2 style=\"color:#0A1E2C;margin:0 0 8px;\">Your bid has expired</h2>\n    <p style=\"color:#555;margin:0 0 16px;\">Hi Jane,</p>\n    <p style=\"color:#555;margin:0 0 16px;\">\n      Your <strong>roofing</strong> bid for <strong>123 Main St</strong>\n      has expired (14-day window). The homeowner can still see your bid,\n      but cannot select you until it's renewed.\n    </p>\n    <a href=\"https://otterquote.com/contractor-bid-form.html?renew=quote-1\"\n       style=\"display:inline-block;background:#14B8A6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-bottom:16px;\">\n      Renew My Bid\n    </a>\n    <p style=\"color:#888;font-size:12px;\">\n      If you're no longer interested in this project, no action is needed.\n    </p>\n    <hr style=\"border:none;border-top:1px solid #eee;margin:24px 0;\" />\n    <p style=\"color:#aaa;font-size:11px;\">\n      Otter Quotes &bull; notifications@mg.example.com\n    </p>\n    <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n  </div>\n</body>\n</html>");
});

Deno.test("gh-1824 process-bid-expirations: buildAutoRenewedEmail matches the pinned golden body", () => {
  const { subject, text, html } = buildAutoRenewedEmail({
    contractorName: "Jane",
    homeownerAddress: "123 Main St",
    tradeLabel: "roofing",
    newQuoteId: "quote-2",
    newExpiresAt: "2026-10-15",
    stopUrl: "https://example.com/stop",
    mailgunDomain: "mg.example.com",
  });
  assertEquals(subject, "Your roofing bid was auto-renewed — valid for 14 more days");
  assertEquals(text, "Hi Jane,\n\nYour roofing bid for 123 Main St was auto-renewed. It's now valid until 2026-10-15.\n\nTo stop auto-renewing this bid: https://example.com/stop\n\n— The Otter Quotes Team\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
  assertEquals(html, "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body style=\"font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;\">\n  <div style=\"max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;\">\n    <img src=\"https://otterquote.com/img/otter-logo.svg\" alt=\"Otter Quotes\" width=\"40\" style=\"margin-bottom:16px;\" />\n    <h2 style=\"color:#0A1E2C;margin:0 0 8px;\">Your bid was auto-renewed ✓</h2>\n    <p style=\"color:#555;margin:0 0 16px;\">Hi Jane,</p>\n    <p style=\"color:#555;margin:0 0 16px;\">\n      Your <strong>roofing</strong> bid for <strong>123 Main St</strong>\n      was automatically renewed and is valid until <strong>2026-10-15</strong>.\n    </p>\n    <p style=\"color:#555;margin:0 0 16px;\">\n      <a href=\"https://example.com/stop\" style=\"color:#14B8A6;\">Stop auto-renewing this bid</a>\n    </p>\n    <hr style=\"border:none;border-top:1px solid #eee;margin:24px 0;\" />\n    <p style=\"color:#aaa;font-size:11px;\">\n      Otter Quotes &bull; notifications@mg.example.com\n    </p>\n    <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n  </div>\n</body>\n</html>");
});

Deno.test("gh-1824 process-bid-expirations: buildRenewalCapEmail matches the pinned golden body", () => {
  const { subject, text, html } = buildRenewalCapEmail({
    contractorName: "Jane",
    homeownerAddress: "123 Main St",
    tradeLabel: "roofing",
    mailgunDomain: "mg.example.com",
  });
  assertEquals(subject, "Your roofing bid renewal limit reached — review your pricing");
  assertEquals(text, "Hi Jane,\n\nYour roofing bid for 123 Main St has reached the maximum of 3 auto-renewals (42 days total). No further auto-renewals will occur.\n\nThe homeowner can still see your original bid for comparison, but it is marked expired.\n\nIf you'd like to stay competitive, log in to submit a fresh bid: https://otterquote.com/contractor-opportunities.html\n\n— The Otter Quotes Team\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
  assertEquals(html, "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body style=\"font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;\">\n  <div style=\"max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;\">\n    <img src=\"https://otterquote.com/img/otter-logo.svg\" alt=\"Otter Quotes\" width=\"40\" style=\"margin-bottom:16px;\" />\n    <h2 style=\"color:#0A1E2C;margin:0 0 8px;\">Auto-renewal limit reached</h2>\n    <p style=\"color:#555;margin:0 0 16px;\">Hi Jane,</p>\n    <p style=\"color:#555;margin:0 0 16px;\">\n      Your <strong>roofing</strong> bid for <strong>123 Main St</strong>\n      has reached the maximum of <strong>3 auto-renewals</strong> (42 days total).\n      No further auto-renewals will occur.\n    </p>\n    <p style=\"color:#555;margin:0 0 16px;\">\n      If you'd like to stay competitive, consider submitting a fresh bid with updated pricing.\n    </p>\n    <a href=\"https://otterquote.com/contractor-opportunities.html\"\n       style=\"display:inline-block;background:#14B8A6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-bottom:16px;\">\n      View Open Opportunities\n    </a>\n    <hr style=\"border:none;border-top:1px solid #eee;margin:24px 0;\" />\n    <p style=\"color:#aaa;font-size:11px;\">\n      Otter Quotes &bull; notifications@mg.example.com\n    </p>\n    <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n  </div>\n</body>\n</html>");
});

Deno.test("gh-1824 process-bid-expirations: buildBidWindowExpiredHomeownerEmail matches the pinned golden body", () => {
  const { subject, text, html } = buildBidWindowExpiredHomeownerEmail({
    homeownerName: "Jane",
    propertyAddress: "123 Main St",
    bidsUrl: "https://example.com/bids",
    mailgunDomain: "mg.example.com",
  });
  assertEquals(subject, "All contractor bids for your project have expired");
  assertEquals(text, "Hi Jane,\n\nAll contractor bids for your project at 123 Main St have expired.\n\nThis can happen when the bidding window closes before a contractor is selected. To move forward, log in to your dashboard — you may request fresh bids or contact us for help.\n\nView your project: https://example.com/bids\n\nIf you have any questions, reply to this email or call us at (844) 875-3412.\n\n— The Otter Quotes Team\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
  assertEquals(html, "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body style=\"font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;\">\n  <div style=\"max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;\">\n    <img src=\"https://otterquote.com/img/otter-logo.svg\" alt=\"Otter Quotes\" width=\"40\" style=\"margin-bottom:16px;\" />\n    <h2 style=\"color:#0A1E2C;margin:0 0 8px;\">Your bids have expired</h2>\n    <p style=\"color:#555;margin:0 0 16px;\">Hi Jane,</p>\n    <p style=\"color:#555;margin:0 0 16px;\">\n      All contractor bids for your project at <strong>123 Main St</strong>\n      have expired. This can happen when the bidding window closes before a contractor is selected.\n    </p>\n    <p style=\"color:#555;margin:0 0 16px;\">\n      To move forward, visit your dashboard — you may request fresh bids from the contractors\n      you were considering, or contact us and we'll help you find new options.\n    </p>\n    <a href=\"https://example.com/bids\"\n       style=\"display:inline-block;background:#14B8A6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-bottom:16px;\">\n      View My Project\n    </a>\n    <p style=\"color:#888;font-size:13px;\">\n      Questions? Reply to this email or call us at (844) 875-3412.\n    </p>\n    <hr style=\"border:none;border-top:1px solid #eee;margin:24px 0;\" />\n    <p style=\"color:#aaa;font-size:11px;\">\n      Otter Quotes &bull; notifications@mg.example.com\n    </p>\n    <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n  </div>\n</body>\n</html>");
});

Deno.test("gh-1824 process-bid-expirations: every golden body still contains the D-237 postal address (sanity check on the goldens themselves)", () => {
  assertEquals(buildBidExpiredEmail({ contractorName: "Jane", homeownerAddress: "123 Main St", tradeLabel: "roofing", quoteId: "quote-1", mailgunDomain: "mg.example.com" }).text.includes(POSTAL_ADDRESS), true);
  assertEquals(buildAutoRenewedEmail({ contractorName: "Jane", homeownerAddress: "123 Main St", tradeLabel: "roofing", newQuoteId: "quote-2", newExpiresAt: "2026-10-15", stopUrl: "https://example.com/stop", mailgunDomain: "mg.example.com" }).text.includes(POSTAL_ADDRESS), true);
  assertEquals(buildRenewalCapEmail({ contractorName: "Jane", homeownerAddress: "123 Main St", tradeLabel: "roofing", mailgunDomain: "mg.example.com" }).text.includes(POSTAL_ADDRESS), true);
  assertEquals(buildBidWindowExpiredHomeownerEmail({ homeownerName: "Jane", propertyAddress: "123 Main St", bidsUrl: "https://example.com/bids", mailgunDomain: "mg.example.com" }).text.includes(POSTAL_ADDRESS), true);
});
