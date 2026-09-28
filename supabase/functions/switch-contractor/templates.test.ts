// Deno unit test for gh-1824 footer-batch-5: switch-contractor's contractor
// notification and internal support alert must both carry the D-237 postal
// address.
// Run: deno test supabase/functions/switch-contractor/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  contractorSwitchEmailHtml,
  contractorSwitchEmailText,
  switchSupportEmailText,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 switch-contractor: contractorSwitchEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    contractorSwitchEmailHtml("Acme Roofing", "Your platform fee has been refunded in full.").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 switch-contractor: contractorSwitchEmailText includes the D-237 postal address", () => {
  assertEquals(
    contractorSwitchEmailText("Acme Roofing", "Your platform fee has been refunded in full.").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 switch-contractor: switchSupportEmailText (internal, to Dustin) includes the D-237 postal address", () => {
  assertEquals(
    switchSupportEmailText("claim-123", "123 Main St", "Acme Roofing", true, "price", "none").includes(POSTAL_ADDRESS),
    true,
  );
});
