// Deno unit test for gh-1824 footer-batch-3: mark-job-complete's rendered
// homeowner-notification email must carry the D-237 postal address.
// Run: deno test supabase/functions/mark-job-complete/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { jobCompleteEmailText, jobCompleteEmailHtml } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 mark-job-complete: jobCompleteEmailText includes the D-237 postal address", () => {
  assertEquals(
    jobCompleteEmailText("Jane", "Acme Roofing", "123 Main St", "Monday, January 1, 2026").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 mark-job-complete: jobCompleteEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    jobCompleteEmailHtml("Jane", "Acme Roofing", "123 Main St", "Monday, January 1, 2026").includes(POSTAL_ADDRESS),
    true,
  );
});
