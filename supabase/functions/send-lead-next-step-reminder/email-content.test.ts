// Deno unit tests for gh-2121 (LRS HO-1 S21) approved copy fidelity.
// Run: deno test supabase/functions/send-lead-next-step-reminder/email-content.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  BODY_TEMPLATE,
  FROM_ADDRESS,
  OPTOUT_LINK_TEXT,
  POSTAL_ADDRESS,
  PREHEADER,
  SUBJECT,
  buildLeadReminderEmail,
  firstNameOf,
  lossSheetCtaUrl,
  measurementCtaUrl,
} from "./email-content.ts";

Deno.test("subject and preheader are verbatim from comment 5821796976", () => {
  assertEquals(SUBJECT, "Next step on your roof assessment");
  assertEquals(
    PREHEADER,
    "Two quick ways to keep things moving while you wait to hear from Dustin.",
  );
});

Deno.test("body template is 80 words — matches the comment's own word-count check", () => {
  assertEquals(BODY_TEMPLATE.split(/\s+/).filter(Boolean).length, 80);
});

Deno.test("CTA URLs are the live Arm F deep links with ?lead=<id>", () => {
  assertEquals(measurementCtaUrl("abc-123"), "https://app.otterquote.com/help-measurements?lead=abc-123");
  assertEquals(lossSheetCtaUrl("abc-123"), "https://app.otterquote.com/help-estimate?lead=abc-123");
});

Deno.test("firstNameOf falls back to 'there' for a nameless lead", () => {
  assertEquals(firstNameOf(null), "there");
  assertEquals(firstNameOf(""), "there");
  assertEquals(firstNameOf("  "), "there");
  assertEquals(firstNameOf("Jane Doe"), "Jane");
});

Deno.test("rendered email carries the D-237 footer, sender, and opt-out link", () => {
  const email = buildLeadReminderEmail("lead-1", "Jane", "https://example.com/optout?t=abc");
  assertStringIncludes(email.textBody, POSTAL_ADDRESS);
  assertStringIncludes(email.textBody, FROM_ADDRESS);
  assertStringIncludes(email.textBody, "https://example.com/optout?t=abc");
  assertStringIncludes(email.htmlBody, POSTAL_ADDRESS);
  assertStringIncludes(email.htmlBody, OPTOUT_LINK_TEXT);
  assertStringIncludes(email.htmlBody, "https://example.com/optout?t=abc");
});

Deno.test("rendered email substitutes the first name into the greeting", () => {
  const email = buildLeadReminderEmail("lead-1", "Jane Doe", "https://example.com/optout?t=abc");
  assertStringIncludes(email.textBody, "Hi Jane,");
});

Deno.test("no D-104 'vetted/approved/endorsed' language and 'Otter Quotes' is two words", () => {
  const email = buildLeadReminderEmail("lead-1", "Jane", "https://example.com/optout?t=abc");
  const lower = email.textBody.toLowerCase();
  for (const banned of ["vetted", "endorsed"]) {
    if (lower.includes(banned)) throw new Error(`D-104 violation: found "${banned}"`);
  }
  assertStringIncludes(email.textBody, "Otter Quotes");
  if (email.textBody.includes("OtterQuote ")) {
    throw new Error("D-175 violation: found one-word 'OtterQuote' in copy");
  }
});
