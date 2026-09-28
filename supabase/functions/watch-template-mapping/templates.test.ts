// Deno unit test for gh-1824 footer-batch-5: watch-template-mapping's
// (flag-gated) stale-template digest must carry the D-237 postal address.
// Run: deno test supabase/functions/watch-template-mapping/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildDigest } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";
import type { StaleTemplate } from "./select-stale.ts";

const ROW: StaleTemplate = {
  template_id: "tmpl-1",
  contractor_id: "c-1",
  company_name: "Acme Roofing",
  is_test: false,
  trade: "roofing",
  funding_type: "insurance",
  status: "manual_mapping_pending",
  age_hours: 30,
  since: "2026-09-01T00:00:00Z",
};

Deno.test("gh-1824 watch-template-mapping: buildDigest includes the D-237 postal address", () => {
  assertEquals(buildDigest([ROW], 24, "watch-template-mapping").text.includes(POSTAL_ADDRESS), true);
});

// ---------------------------------------------------------------------------
// gh-1824 REVIEW FAIL 5870472283 on #2292 / HOLD 5870481359 on #2286: pin the
// full rendered text (and subject), not just an .includes() check -- see
// process-payout-reminders/templates.test.ts for the fuller explanation of
// how this golden was captured.
// ---------------------------------------------------------------------------

const GOLDEN_SUBJECT = `OtterQuote — 1 contract template waiting on mapping/review > 24h`;

const GOLDEN_TEXT = `1 contractor template has sat in a pending state longer than 24 hours and nobody has acted (gh-1313 watcher).

- Acme Roofing — roofing × insurance — manual_mapping_pending for 30h (since 2026-09-01T00:00:00Z) — template tmpl-1

Review: https://otterquote.com/admin-template-review.html

Sent by watch-template-mapping. One email per template per 24h.

Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224`;

Deno.test("gh-1824 watch-template-mapping: buildDigest(...) exact-matches the pinned golden subject and text", () => {
  const { subject, text } = buildDigest([ROW], 24, "watch-template-mapping");
  assertEquals(subject, GOLDEN_SUBJECT);
  assertEquals(text, GOLDEN_TEXT);
});
