// Deno unit test for gh-1824 footer-batch-4: process-auto-bids' rendered
// email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/process-auto-bids/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmailText, buildEmailHtml } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 process-auto-bids: buildEmailText includes the D-237 postal address", () => {
  assertEquals(buildEmailText("Jane", 10000, 500, 5).includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-auto-bids: buildEmailHtml includes the D-237 postal address", () => {
  assertEquals(buildEmailHtml("Jane", 10000, 500, 5).includes(POSTAL_ADDRESS), true);
});
