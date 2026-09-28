// Deno unit test for gh-1824 footer-batch-4: notify-feature-request's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/notify-feature-request/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { featureRequestEmailText, featureRequestEmailHtml } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 notify-feature-request: featureRequestEmailText includes the D-237 postal address", () => {
  assertEquals(
    featureRequestEmailText("Acme Roofing", "acme@example.com", "Please add dark mode", "2026-09-28 10:00 AM").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 notify-feature-request: featureRequestEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    featureRequestEmailHtml("Acme Roofing", "acme@example.com", "Please add dark mode", "2026-09-28 10:00 AM").includes(POSTAL_ADDRESS),
    true,
  );
});
