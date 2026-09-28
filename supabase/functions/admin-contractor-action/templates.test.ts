// Deno unit test for gh-1824 footer-batch-3: admin-contractor-action's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/admin-contractor-action/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  approvalEmailText,
  approvalEmailHtml,
  rejectionEmailText,
  rejectionEmailHtml,
  coiEmailText,
  coiEmailHtml,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 admin-contractor-action: approvalEmailText includes the D-237 postal address", () => {
  assertEquals(approvalEmailText("Jane").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 admin-contractor-action: approvalEmailHtml includes the D-237 postal address", () => {
  assertEquals(approvalEmailHtml("Jane").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 admin-contractor-action: rejectionEmailText includes the D-237 postal address", () => {
  assertEquals(rejectionEmailText("Jane", "Missing license").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 admin-contractor-action: rejectionEmailHtml includes the D-237 postal address", () => {
  assertEquals(rejectionEmailHtml("Jane", "Missing license").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 admin-contractor-action: coiEmailText includes the D-237 postal address", () => {
  assertEquals(coiEmailText("Acme Roofing").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 admin-contractor-action: coiEmailHtml includes the D-237 postal address", () => {
  assertEquals(coiEmailHtml("Acme Roofing").includes(POSTAL_ADDRESS), true);
});
