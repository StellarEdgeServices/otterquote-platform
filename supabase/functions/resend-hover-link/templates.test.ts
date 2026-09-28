// Deno unit test for gh-1824 footer-batch-5: resend-hover-link's homeowner
// measurement-link reminder must carry the D-237 postal address (both parts).
// Run: deno test supabase/functions/resend-hover-link/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildHtmlBody, buildTextBody } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 resend-hover-link: buildHtmlBody includes the D-237 postal address", () => {
  assertEquals(
    buildHtmlBody("Jane", "123 Main St", "https://hover.example/capture/abc").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 resend-hover-link: buildTextBody includes the D-237 postal address", () => {
  assertEquals(
    buildTextBody("Jane", "123 Main St", "https://hover.example/capture/abc").includes(POSTAL_ADDRESS),
    true,
  );
});
