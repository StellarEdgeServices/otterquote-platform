// Deno unit tests for gh-2121 (LRS HO-1 S21) approved copy fidelity.
// Run: deno test supabase/functions/send-lead-next-step-reminder/email-content.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  BODY_TEMPLATE,
  BODY_TEMPLATE_NO_PHONE,
  FROM_ADDRESS,
  HO6_BODY_TEMPLATE,
  HO6_REPLY_TO,
  OPTOUT_LINK_TEXT,
  POSTAL_ADDRESS,
  PREHEADER,
  SUBJECT,
  buildLeadReminderEmail,
  firstNameOf,
  lossSheetCtaUrl,
  measurementCtaUrl,
  replyToForVariant,
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

// ── gh-2378 (CRO51): HO-6 next-step email, Variant A, Reply-To ───────────────
// Copy is Dustin's selection "A, Reply-To you (Recommended)" on #2378
// (comment 5911291213), verbatim from cro50-ho6-next-step-email-DRAFT-20260930.md.

const OPT = "https://example.com/optout?t=abc";

const HO6_EXPECTED_BODY = [
  "Hi Jane,",
  "",
  "Thanks for reaching out to Otter Quotes. Your next step is simple: reply to this email and tell us about your job in a few lines, in your own words. What needs to be done, and anything else you think we should know.",
  "",
  "From there we help you create a scope of work and send it to multiple contractors, so you can compare their bids.",
  "",
  "Contractors compete. Homeowners win.",
  "",
  "The Otter Quotes team",
].join("\n");

Deno.test("ho6: subject, preheader and body are Variant A verbatim (only first_name substituted)", () => {
  const email = buildLeadReminderEmail("lead-1", "Jane Doe", OPT, true, "ho6");
  assertEquals(email.subject, "Your next step with Otter Quotes");
  assertEquals(email.preheader, "Reply with a few lines about your job and we'll take it from there.");
  assertEquals(email.textBody.startsWith(HO6_EXPECTED_BODY + "\n\n"), true);
  assertEquals(HO6_BODY_TEMPLATE.replace("{first_name}", "Jane"), HO6_EXPECTED_BODY);
});

Deno.test("ho6: footer is the existing footer, unchanged, and appears once", () => {
  const ho6 = buildLeadReminderEmail("lead-1", "Jane", OPT, true, "ho6");
  const f = buildLeadReminderEmail("lead-1", "Jane", OPT, true, "f");
  const footerOf = (t: string) => t.slice(t.indexOf(FROM_ADDRESS));
  assertEquals(footerOf(ho6.textBody), footerOf(f.textBody));
  assertStringIncludes(ho6.textBody, POSTAL_ADDRESS);
  assertEquals(countOccurrences(ho6.textBody, "Stop these updates"), 1);
  assertEquals(countOccurrences(ho6.htmlBody, "Stop these updates"), 1);
  assertStringIncludes(ho6.htmlBody, POSTAL_ADDRESS);
  assertStringIncludes(ho6.htmlBody, `<a href="${OPT}"`);
});

Deno.test("ho6: never promises a call, whatever the phone flag; no CTA links, no price", () => {
  for (const hasPhone of [true, false]) {
    const email = buildLeadReminderEmail("lead-1", "Jane", OPT, hasPhone, "ho6");
    for (const part of [email.textBody, email.htmlBody]) {
      const lower = part.toLowerCase();
      for (const banned of ["call you", "dustin", "$15", "help-measurements", "help-estimate", "vetted", "endorsed"]) {
        if (lower.includes(banned)) throw new Error(`ho6 copy contains "${banned}"`);
      }
    }
    // hasPhone must not change ho6 output at all
    assertEquals(email.textBody, buildLeadReminderEmail("lead-1", "Jane", OPT, true, "ho6").textBody);
  }
});

Deno.test("ho6: reply-to is dustinstohler1@gmail.com for ho6 only", () => {
  assertEquals(HO6_REPLY_TO, "dustinstohler1@gmail.com");
  assertEquals(replyToForVariant("ho6"), "dustinstohler1@gmail.com");
  for (const v of ["f", "HO-2", "HO-3", "HO6", null, undefined]) assertEquals(replyToForVariant(v), undefined);
});

Deno.test("existing variants are unchanged: f / HO-2 / no variant render identically to the pre-ho6 call", () => {
  const legacy = buildLeadReminderEmail("lead-1", "Jane", OPT, true);
  for (const v of ["f", "HO-2", "HO-3", null, undefined, "HO6"]) {
    assertEquals(buildLeadReminderEmail("lead-1", "Jane", OPT, true, v), legacy);
  }
  assertStringIncludes(legacy.textBody, "Dustin will still call you");
  assertEquals(legacy.subject, "Next step on your roof assessment");
});
