// Deno unit test for gh-1824 footer-batch-5: send-support-email's forwarded
// support-form message must carry the D-237 postal address.
// Run: deno test supabase/functions/send-support-email/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { supportEmailBody } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 send-support-email: supportEmailBody includes the D-237 postal address", () => {
  assertEquals(
    supportEmailBody("Jane Contractor", "jane@example.com", "Help with billing", "My issue is...").includes(POSTAL_ADDRESS),
    true,
  );
});

// ---------------------------------------------------------------------------
// gh-1824 REVIEW FAIL 5870472283 on #2292 / HOLD 5870481359 on #2286: pin the
// full rendered text, not just an .includes() check -- see process-payout-
// reminders/templates.test.ts for the fuller explanation of how this golden
// was captured.
// ---------------------------------------------------------------------------

const GOLDEN_TEXT = `Otter Quotes Support Request
===========================
From:    Jane Contractor
Email:   jane@example.com
Subject: Help with billing

Message:
My issue is...

---
Sent via Otter Quotes support form.
Reply directly to this email to respond.

Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224`;

Deno.test("gh-1824 send-support-email: supportEmailBody(...) exact-matches the pinned golden text", () => {
  assertEquals(
    supportEmailBody("Jane Contractor", "jane@example.com", "Help with billing", "My issue is..."),
    GOLDEN_TEXT,
  );
});
