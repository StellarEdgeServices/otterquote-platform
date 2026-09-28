// Deno unit test for gh-1824 footer-batch-2: send-incomplete-onboarding-
// reminders' rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/send-incomplete-onboarding-reminders/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildReminderEmail, buildReminderText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 send-incomplete-onboarding-reminders: buildReminderEmail includes the D-237 postal address", () => {
  const html = buildReminderEmail("Jane Doe");
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 send-incomplete-onboarding-reminders: buildReminderText includes the D-237 postal address", () => {
  const text = buildReminderText("Jane Doe");
  assertEquals(text.includes(POSTAL_ADDRESS), true);
});
