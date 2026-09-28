// Deno unit test for gh-1824 footer-batch-3: approve-warranty-drift's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/approve-warranty-drift/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { deprecatedWarrantyEmailText, deprecatedWarrantyEmailHtml } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 approve-warranty-drift: deprecatedWarrantyEmailText includes the D-237 postal address", () => {
  assertEquals(
    deprecatedWarrantyEmailText("Acme Roofing", "GAF", "Golden Pledge").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 approve-warranty-drift: deprecatedWarrantyEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    deprecatedWarrantyEmailHtml("Acme Roofing", "GAF", "Golden Pledge").includes(POSTAL_ADDRESS),
    true,
  );
});
