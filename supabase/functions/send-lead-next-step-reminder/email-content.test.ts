// Deno unit tests for gh-2121 (LRS HO-1 S21) approved copy fidelity.
// Run: deno test supabase/functions/send-lead-next-step-reminder/email-content.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  BODY_TEMPLATE,
  BODY_TEMPLATE_NO_PHONE,
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

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

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

// ── Fix round 1 (CEO RUN 68 LEGAL-READ: FAIL, comment 5825694840, must-fix
// 7 / adversarial test A3) — fails against head 0a4988fe: the phrase
// rendered TWICE ("Stop these updates: Stop these updates").

Deno.test("'Stop these updates' appears exactly once in the HTML footer", () => {
  const email = buildLeadReminderEmail("lead-1", "Jane", "https://example.com/optout?t=abc", true);
  assertEquals(countOccurrences(email.htmlBody, "Stop these updates"), 1);
});

Deno.test("'Stop these updates' appears exactly once in the text footer", () => {
  const email = buildLeadReminderEmail("lead-1", "Jane", "https://example.com/optout?t=abc", true);
  assertEquals(countOccurrences(email.textBody, "Stop these updates"), 1);
});

// ── Fix round 1 (must-fix 6, Ben's D-332 ruling / adversarial test A4) ──────
// Fails against head 0a4988fe: buildLeadReminderEmail took no hasPhone
// parameter and always sent the call-promise sentence.

Deno.test("a lead WITH a phone gets the approved copy unchanged, call-promise sentence included", () => {
  const email = buildLeadReminderEmail("lead-1", "Jane", "https://example.com/optout?t=abc", true);
  assertStringIncludes(email.textBody, "Dustin will still call you");
});

Deno.test("a lead with NO phone does NOT get the call-promise sentence (removal only)", () => {
  const email = buildLeadReminderEmail("lead-1", "Jane", "https://example.com/optout?t=abc", false);
  if (email.textBody.includes("Dustin will still call you")) {
    throw new Error("D-332 violation: no-call-promise sentence present for a phone-less lead");
  }
  if (email.htmlBody.includes("Dustin will still call you")) {
    throw new Error("D-332 violation: no-call-promise sentence present in HTML for a phone-less lead");
  }
});

Deno.test("BODY_TEMPLATE_NO_PHONE is BODY_TEMPLATE with ONLY the call-promise sentence removed — no new words", () => {
  const withPhoneWords = new Set(BODY_TEMPLATE.split(/\s+/).filter(Boolean));
  const noPhoneWords = BODY_TEMPLATE_NO_PHONE.split(/\s+/).filter(Boolean);
  for (const word of noPhoneWords) {
    if (!withPhoneWords.has(word)) {
      throw new Error(`D-332 violation: BODY_TEMPLATE_NO_PHONE contains a word not in the approved copy: "${word}"`);
    }
  }
});

// ── Fix round 1 (should-fix, adversarial tests A10 / A11) ───────────────────
// Fails against head 0a4988fe: firstNameOf() had no charset restriction, and
// buildLeadReminderEmail used String.replace's special "$&" handling.

Deno.test("firstNameOf falls back to 'there' for a name containing a URL (adversarial test A10)", () => {
  assertEquals(firstNameOf("http://evil.example/x"), "there");
});

Deno.test("firstNameOf falls back to 'there' for a name containing '@' or unsafe characters", () => {
  assertEquals(firstNameOf("attacker@evil.example"), "there");
  assertEquals(firstNameOf("<script>"), "there");
});

Deno.test("firstNameOf accepts an apostrophe/hyphen name", () => {
  assertEquals(firstNameOf("O'Brien"), "O'Brien");
  assertEquals(firstNameOf("Mary-Jane Smith"), "Mary-Jane");
});

Deno.test("a '$&'-shaped name does not corrupt the greeting (adversarial test A11)", () => {
  const email = buildLeadReminderEmail("lead-1", "$&", "https://example.com/optout?t=abc");
  // firstNameOf("$&") sanitizes to "there" (not a safe-charset name), and
  // that literal value must appear exactly once, never doubled by a
  // replacement-pattern bug.
  assertStringIncludes(email.textBody, "Hi there,");
  assertEquals(countOccurrences(email.textBody, "there"), 1);
});
