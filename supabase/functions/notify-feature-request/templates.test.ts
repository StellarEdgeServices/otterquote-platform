// Deno unit test for gh-1824 footer-batch-4: notify-feature-request's rendered
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
// Run: deno test supabase/functions/notify-feature-request/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { featureRequestEmailText, featureRequestEmailHtml } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const ARGS: [string, string, string, string] = ["Acme Roofing", "acme@example.com", "Please add dark mode", "2026-09-28 10:00 AM"];

Deno.test("gh-1824 notify-feature-request: featureRequestEmailText matches the pinned golden body", () => {
  assertEquals(featureRequestEmailText(...ARGS), "New feature request submitted on OtterQuote.\n\nContractor : Acme Roofing\nEmail      : acme@example.com\nSubmitted  : 2026-09-28 10:00 AM (CT)\n\n─────────────────────────────────\nPlease add dark mode\n─────────────────────────────────\n\nView all requests in your Supabase dashboard:\nhttps://app.supabase.com → Table Editor → feature_requests\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 notify-feature-request: featureRequestEmailHtml matches the pinned golden body", () => {
  assertEquals(featureRequestEmailHtml(...ARGS), "\n      <div style=\"font-family:sans-serif; max-width:600px; margin:0 auto; color:#0B1929;\">\n        <div style=\"background:#0B1929; padding:20px 24px; border-radius:8px 8px 0 0;\">\n          <h2 style=\"color:#F59E0B; margin:0; font-size:1.1rem;\">🦦 New OtterQuote Feature Request</h2>\n        </div>\n        <div style=\"background:#F8FAFC; padding:24px; border:1px solid #E2E8F0; border-top:none; border-radius:0 0 8px 8px;\">\n          <table style=\"width:100%; border-collapse:collapse; font-size:0.9rem; margin-bottom:20px;\">\n            <tr>\n              <td style=\"padding:6px 0; color:#64748B; width:110px;\">Contractor</td>\n              <td style=\"padding:6px 0; font-weight:600;\">Acme Roofing</td>\n            </tr>\n            <tr>\n              <td style=\"padding:6px 0; color:#64748B;\">Email</td>\n              <td style=\"padding:6px 0;\"><a href=\"mailto:acme@example.com\" style=\"color:#0369A1;\">acme@example.com</a></td>\n            </tr>\n            <tr>\n              <td style=\"padding:6px 0; color:#64748B;\">Submitted</td>\n              <td style=\"padding:6px 0;\">2026-09-28 10:00 AM CT</td>\n            </tr>\n          </table>\n          <div style=\"background:white; border:1px solid #CBD5E1; border-radius:6px; padding:16px; font-size:0.95rem; line-height:1.6; white-space:pre-wrap;\">Please add dark mode</div>\n          <p style=\"margin-top:20px; font-size:0.8rem; color:#94A3B8;\">\n            View all requests in your\n            <a href=\"https://app.supabase.com\" style=\"color:#0369A1;\">Supabase dashboard</a>\n            → Table Editor → feature_requests\n          </p>\n          <div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>\n        </div>\n      </div>\n    ");
});

Deno.test("gh-1824 notify-feature-request: goldens still contain the D-237 postal address (sanity check on the goldens themselves)", () => {
  assertEquals(featureRequestEmailText(...ARGS).includes(POSTAL_ADDRESS), true);
  assertEquals(featureRequestEmailHtml(...ARGS).includes(POSTAL_ADDRESS), true);
});
