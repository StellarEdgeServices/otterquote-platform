// Deno unit test for gh-1824 footer-batch-3: approve-payout's rendered
// email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/approve-payout/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { approvalEmailText, approvalEmailHtml, formatPayoutType } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 approve-payout: approvalEmailText includes the D-237 postal address", () => {
  assertEquals(approvalEmailText("Jane", formatPayoutType("commission_referral")).includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 approve-payout: approvalEmailHtml includes the D-237 postal address", () => {
  assertEquals(approvalEmailHtml("Jane", formatPayoutType("commission_recruit")).includes(POSTAL_ADDRESS), true);
});
