// Deno unit test for gh-1824 footer-batch-3: mark-payout-paid's rendered
// email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/mark-payout-paid/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { paidEmailText, paidEmailHtml, formatCurrency, formatPayoutType } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 mark-payout-paid: paidEmailText includes the D-237 postal address", () => {
  assertEquals(
    paidEmailText("Jane", formatPayoutType("commission_referral"), formatCurrency(500)).includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 mark-payout-paid: paidEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    paidEmailHtml("Jane", formatPayoutType("commission_recruit"), formatCurrency(500)).includes(POSTAL_ADDRESS),
    true,
  );
});
