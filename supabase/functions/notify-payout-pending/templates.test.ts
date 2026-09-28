// Deno unit test for gh-1824 footer-batch-4: notify-payout-pending's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/notify-payout-pending/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { payoutPendingEmailHtml, payoutPendingEmailText, formatCurrency, formatPayoutType } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 notify-payout-pending: payoutPendingEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    payoutPendingEmailHtml("Jane's Roofing", "$500.00", "Referral Commission", "October 1, 2026", "Commission qualifying event", "approval-1").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 notify-payout-pending: payoutPendingEmailText includes the D-237 postal address", () => {
  assertEquals(
    payoutPendingEmailText("Jane's Roofing", "$500.00", "Referral Commission", "October 1, 2026", "Commission qualifying event").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 notify-payout-pending: formatCurrency/formatPayoutType still work after extraction", () => {
  assertEquals(formatCurrency(1234.5), "$1,234.50");
  assertEquals(formatPayoutType("commission_referral"), "Referral Commission");
  assertEquals(formatPayoutType("recruit_bonus"), "Recruit Bonus");
});
