// Deno unit test for gh-1824 footer-batch-5: refresh-warranty-manifest's
// quarterly admin email must carry the D-237 postal address.
// Run: deno test supabase/functions/refresh-warranty-manifest/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { warrantyDriftEmailText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const ROWS = [{ manufacturer: "GAF" }, { manufacturer: "Tamko" }];

Deno.test("gh-1824 refresh-warranty-manifest: warrantyDriftEmailText includes the D-237 postal address", () => {
  assertEquals(warrantyDriftEmailText(2, ROWS, true).includes(POSTAL_ADDRESS), true);
});

// ---------------------------------------------------------------------------
// gh-1824 REVIEW FAIL 5870472283 on #2292 / HOLD 5870481359 on #2286: pin the
// full rendered text, not just an .includes() check -- see process-payout-
// reminders/templates.test.ts for the fuller explanation of how this golden
// was captured (body confirmed byte-identical to pre-extraction main, then
// rendered with fixed inputs and recorded).
// ---------------------------------------------------------------------------

const GOLDEN_TEXT = `Warranty Manifest Quarterly Review

2 item(s) flagged for your review.

Breakdown:
  • GAF: 1 item(s)
  • Tamko: 1 item(s)

GAF: programmatic scrape completed.

Review queue: https://otterquote.com/admin-warranty-drift.html

No changes will be made to the warranty manifest until you approve them.

— Otter Quotes Platform

Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224`;

Deno.test("gh-1824 refresh-warranty-manifest: warrantyDriftEmailText(...) exact-matches the pinned golden text", () => {
  assertEquals(warrantyDriftEmailText(2, ROWS, true), GOLDEN_TEXT);
});
