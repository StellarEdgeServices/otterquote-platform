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
