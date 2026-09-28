// Deno unit test for gh-1824 footer-batch-3: notify-admin-new-contractor's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/notify-admin-new-contractor/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmailHtml, buildEmailText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 notify-admin-new-contractor: buildEmailText includes the D-237 postal address", () => {
  assertEquals(
    buildEmailText("Acme Roofing", "Jane", "jane@example.com", "1/1/2026, 12:00:00 PM").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 notify-admin-new-contractor: buildEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    buildEmailHtml("Acme Roofing", "Jane", "jane@example.com", "1/1/2026, 12:00:00 PM").includes(POSTAL_ADDRESS),
    true,
  );
});
