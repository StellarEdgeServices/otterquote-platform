// Deno unit test for gh-1824 footer-batch-3: counter-sig-reminders'
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/counter-sig-reminders/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildReminderEmail } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 counter-sig-reminders: buildReminderEmail text includes the D-237 postal address", () => {
  const { text } = buildReminderEmail({
    contractorName: "Jane",
    propertyAddress: "123 Main St",
    jobNumber: "J-1001",
    hoursSinceSigned: 4,
  });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 counter-sig-reminders: buildReminderEmail html includes the D-237 postal address", () => {
  const { html } = buildReminderEmail({
    contractorName: "Jane",
    propertyAddress: "123 Main St",
    jobNumber: "J-1001",
    hoursSinceSigned: 4,
  });
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});
