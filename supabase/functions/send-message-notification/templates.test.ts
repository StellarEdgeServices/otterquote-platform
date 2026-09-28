// Deno unit test for gh-1824 footer-batch-2: send-message-notification's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/send-message-notification/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmail, messageNotificationText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 send-message-notification: buildEmail includes the D-237 postal address", () => {
  const html = buildEmail("<p>You have a new message.</p>");
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 send-message-notification: messageNotificationText includes the D-237 postal address", () => {
  const text = messageNotificationText(
    "Jane",
    "Acme Roofing",
    "Hey, following up on the estimate",
    false,
    "https://otterquote.com/dashboard",
  );
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

const EXPECTED_HTML = "<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <style>\n    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #333; }\n    .container { max-width: 600px; margin: 0 auto; background: #fff; }\n    .header { background: #001D3D; color: #fff; padding: 24px 32px; }\n    .content { padding: 32px; }\n    .footer { background: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 20px 32px; text-align: center; font-size: 13px; color: #64748B; }\n    a { color: #0EA5E9; text-decoration: none; }\n    .button { display: inline-block; background: #14B8A6; color: #fff; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <div class=\"header\">\n      <h2 style=\"margin: 0;\">Otter Quotes</h2>\n    </div>\n    <div class=\"content\">\n      <p>You have a new message.</p>\n    </div>\n    <div class=\"footer\">\n      <p style=\"margin: 0 0 12px 0;\">Need help? Contact <a href=\"mailto:support@otterquote.com\">support@otterquote.com</a> or call (844) 875-3412</p>\n      <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n    </div>\n  </div>\n</body>\n</html>";
const EXPECTED_TEXT = "Hi Jane,\n\nYou have a new message from Acme Roofing regarding your project.\n\nMessage preview:\n\"Hey, following up on the estimate\"\n\nView message: https://otterquote.com/dashboard\n\nLog in to Otter Quotes to read and reply to the full message.\n\n---\nNeed help? Contact support@otterquote.com or call (844) 875-3412\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

Deno.test("gh-1824 send-message-notification: rendered HTML is pinned exactly (golden, catches wording drift)", () => {
  assertEquals(buildEmail("<p>You have a new message.</p>"), EXPECTED_HTML);
});

Deno.test("gh-1824 send-message-notification: rendered text is pinned exactly (golden, catches wording drift)", () => {
  assertEquals(messageNotificationText(
    "Jane",
    "Acme Roofing",
    "Hey, following up on the estimate",
    false,
    "https://otterquote.com/dashboard",
  ), EXPECTED_TEXT);
});
