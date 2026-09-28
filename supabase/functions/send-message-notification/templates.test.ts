// Deno unit test for gh-1824 footer-batch-2: send-message-notification's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/send-message-notification/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmail, messageNotificationHtml, messageNotificationText, MESSAGE_NOTIFICATION_SUBJECT } from "./templates.ts";
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
// --- Must-fix per REVIEW: FAIL 5871310735 --------------------------------
// send-message-notification's HTML body was still inline in index.ts (the
// contractor branch ~L266 and the homeowner branch ~L334), passed into
// buildEmail(bodyHtml), so the golden test above for buildEmail only pinned
// the wrapper -- a word change inside either inline body went undetected
// (reviewer's negative control: "You have a new message from" ->
// "You have a new XYZZY from" in index.ts, 7 passed | 0 failed). Both
// inline bodies were byte-identical to each other and to main, so they are
// now one shared templates.ts function, messageNotificationHtml(), called
// from both index.ts branches with no wording change. These two tests pin
// its output for each branch's arguments (contractor and homeowner).
// Negative control performed by hand for this fix: changed "You have a new
// message from" to "You have a new XYZZY from" in
// messageNotificationHtml()'s template literal in templates.ts and reran
// this file -- 9 passed | 2 failed (both golden-HTML tests below failed;
// every includes()-only test above still passed). Reverted before commit.

const EXPECTED_CONTRACTOR_HTML = "<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <style>\n    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #333; }\n    .container { max-width: 600px; margin: 0 auto; background: #fff; }\n    .header { background: #001D3D; color: #fff; padding: 24px 32px; }\n    .content { padding: 32px; }\n    .footer { background: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 20px 32px; text-align: center; font-size: 13px; color: #64748B; }\n    a { color: #0EA5E9; text-decoration: none; }\n    .button { display: inline-block; background: #14B8A6; color: #fff; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <div class=\"header\">\n      <h2 style=\"margin: 0;\">Otter Quotes</h2>\n    </div>\n    <div class=\"content\">\n      \n        <p>Hi Jane,</p>\n        <p>You have a new message from <strong>Acme Roofing</strong> regarding your project.</p>\n        <p><strong>Message preview:</strong></p>\n        <blockquote style=\"border-left: 4px solid #14B8A6; padding-left: 16px; margin: 16px 0; color: #666;\">\n          Hey, following up on the estimate\n        </blockquote>\n        <p>\n          <a href=\"https://otterquote.com/dashboard\" class=\"button\">View Message</a>\n        </p>\n        <p>Log in to Otter Quotes to read and reply to the full message.</p>\n      \n    </div>\n    <div class=\"footer\">\n      <p style=\"margin: 0 0 12px 0;\">Need help? Contact <a href=\"mailto:support@otterquote.com\">support@otterquote.com</a> or call (844) 875-3412</p>\n      <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n    </div>\n  </div>\n</body>\n</html>";
const EXPECTED_HOMEOWNER_HTML = "<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <style>\n    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #333; }\n    .container { max-width: 600px; margin: 0 auto; background: #fff; }\n    .header { background: #001D3D; color: #fff; padding: 24px 32px; }\n    .content { padding: 32px; }\n    .footer { background: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 20px 32px; text-align: center; font-size: 13px; color: #64748B; }\n    a { color: #0EA5E9; text-decoration: none; }\n    .button { display: inline-block; background: #14B8A6; color: #fff; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <div class=\"header\">\n      <h2 style=\"margin: 0;\">Otter Quotes</h2>\n    </div>\n    <div class=\"content\">\n      \n        <p>Hi Bob Homeowner,</p>\n        <p>You have a new message from <strong>Acme Roofing</strong> regarding your project.</p>\n        <p><strong>Message preview:</strong></p>\n        <blockquote style=\"border-left: 4px solid #14B8A6; padding-left: 16px; margin: 16px 0; color: #666;\">\n          Sure, that works for me. See you then....\n        </blockquote>\n        <p>\n          <a href=\"https://otterquote.com/contractor-dashboard.html\" class=\"button\">View Message</a>\n        </p>\n        <p>Log in to Otter Quotes to read and reply to the full message.</p>\n      \n    </div>\n    <div class=\"footer\">\n      <p style=\"margin: 0 0 12px 0;\">Need help? Contact <a href=\"mailto:support@otterquote.com\">support@otterquote.com</a> or call (844) 875-3412</p>\n      <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n    </div>\n  </div>\n</body>\n</html>";

Deno.test("gh-1824 send-message-notification: messageNotificationHtml (contractor branch) is pinned exactly (golden, catches wording drift)", () => {
  const html = messageNotificationHtml(
    "Jane",
    "Acme Roofing",
    "Hey, following up on the estimate",
    false,
    "https://otterquote.com/dashboard",
  );
  assertEquals(html, EXPECTED_CONTRACTOR_HTML);
});

Deno.test("gh-1824 send-message-notification: messageNotificationHtml (homeowner branch) is pinned exactly (golden, catches wording drift)", () => {
  const html = messageNotificationHtml(
    "Bob Homeowner",
    "Acme Roofing",
    "Sure, that works for me. See you then.",
    true,
    "https://otterquote.com/contractor-dashboard.html",
  );
  assertEquals(html, EXPECTED_HOMEOWNER_HTML);
});

// Nit from REVIEW: FAIL 5870472283 / 5871310735: pin the subject too, since
// it is cheap (both index.ts branches use the same literal).
Deno.test("gh-1824 send-message-notification: MESSAGE_NOTIFICATION_SUBJECT is pinned exactly", () => {
  assertEquals(MESSAGE_NOTIFICATION_SUBJECT, "You have a new message on your Otter Quotes project");
});
