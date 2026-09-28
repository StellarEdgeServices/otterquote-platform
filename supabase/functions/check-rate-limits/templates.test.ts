// Deno unit test for gh-1824 footer-batch-3: check-rate-limits' rendered
// alert email must carry the D-237 postal address.
// Run: deno test supabase/functions/check-rate-limits/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { rateLimitAlertText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 check-rate-limits: rateLimitAlertText includes the D-237 postal address", () => {
  assertEquals(rateLimitAlertText("send-sms", 720, 1000, 72).includes(POSTAL_ADDRESS), true);
});
