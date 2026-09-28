// Deno unit test for gh-1824 footer-batch-5: refresh-warranty-manifest's
// quarterly admin email must carry the D-237 postal address.
// Run: deno test supabase/functions/refresh-warranty-manifest/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { warrantyDriftEmailText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 refresh-warranty-manifest: warrantyDriftEmailText includes the D-237 postal address", () => {
  assertEquals(
    warrantyDriftEmailText(2, [{ manufacturer: "GAF" }, { manufacturer: "Tamko" }], true).includes(POSTAL_ADDRESS),
    true,
  );
});
