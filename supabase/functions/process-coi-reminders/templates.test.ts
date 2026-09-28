// Deno unit test for gh-1824 footer-batch-4: process-coi-reminders' rendered
// email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/process-coi-reminders/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  build30DayEmail,
  build14DayEmail,
  build7DayEmail,
  buildExpiredEmail,
  buildWC30DayEmail,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 process-coi-reminders: build30DayEmail includes the D-237 postal address", () => {
  const { text, html } = build30DayEmail({ contractorName: "Jane", expiryDateDisplay: "October 28, 2026", mailgunDomain: "mg.example.com" });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-coi-reminders: build14DayEmail includes the D-237 postal address", () => {
  const { text, html } = build14DayEmail({ contractorName: "Jane", expiryDateDisplay: "October 12, 2026", mailgunDomain: "mg.example.com" });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-coi-reminders: build7DayEmail includes the D-237 postal address", () => {
  const { text, html } = build7DayEmail({ contractorName: "Jane", expiryDateDisplay: "October 5, 2026", mailgunDomain: "mg.example.com" });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-coi-reminders: buildExpiredEmail includes the D-237 postal address", () => {
  const { text, html } = buildExpiredEmail({ contractorName: "Jane", expiredDateDisplay: "September 20, 2026", mailgunDomain: "mg.example.com" });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-coi-reminders: buildWC30DayEmail includes the D-237 postal address", () => {
  const { text, html } = buildWC30DayEmail({ contractorName: "Jane", expiryDateDisplay: "October 28, 2026", mailgunDomain: "mg.example.com" });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});
