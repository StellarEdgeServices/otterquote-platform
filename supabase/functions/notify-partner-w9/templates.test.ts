// Deno unit test for gh-1824 footer-batch-4: notify-partner-w9's rendered
// email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/notify-partner-w9/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { w9RequestEmailHtml, w9RequestEmailText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 notify-partner-w9: w9RequestEmailHtml includes the D-237 postal address", () => {
  assertEquals(w9RequestEmailHtml("Jane").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-partner-w9: w9RequestEmailText includes the D-237 postal address", () => {
  assertEquals(w9RequestEmailText("Jane").includes(POSTAL_ADDRESS), true);
});
