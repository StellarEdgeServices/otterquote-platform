// Deno unit test for gh-1824 footer-batch-5: process-payout-reminders' Day-2
// digest email must carry the D-237 postal address.
// Run: deno test supabase/functions/process-payout-reminders/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmail, reminderDigestBodyHtml, reminderDigestBodyText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const ROW = { partner_name: "Acme Roofing", amount: 125.5, payout_type: "commission_referral", created_at: "2026-09-01T00:00:00Z" };

Deno.test("gh-1824 process-payout-reminders: reminderDigestBodyText includes the D-237 postal address", () => {
  assertEquals(reminderDigestBodyText([ROW], 125.5, "https://otterquote.com/admin-payouts.html").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-payout-reminders: buildEmail(reminderDigestBodyHtml(...)) includes the D-237 postal address in the rendered HTML shell", () => {
  const html = buildEmail(reminderDigestBodyHtml([ROW], 125.5, "https://otterquote.com/admin-payouts.html"));
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});
