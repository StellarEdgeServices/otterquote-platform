// Deno unit tests for gh-2121 founder/internal/synthetic exclusion.
// Run: deno test supabase/functions/send-lead-next-step-reminder/founder-filter.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  hasUsableEmail,
  isFounderOrTestEmail,
  isSingleValidEmail,
  isSyntheticLead,
} from "./founder-filter.ts";

Deno.test("isFounderOrTestEmail: anchored local-part 'test'", () => {
  assertEquals(isFounderOrTestEmail("test@gmail.com"), true);
  assertEquals(isFounderOrTestEmail("test1@gmail.com"), true);
  assertEquals(isFounderOrTestEmail("test+x@gmail.com"), true);
  assertEquals(isFounderOrTestEmail("dustin+test@gmail.com"), true);
});

Deno.test("isFounderOrTestEmail: does not match a real address containing 'test'", () => {
  assertEquals(isFounderOrTestEmail("protest@gmail.com"), false);
  assertEquals(isFounderOrTestEmail("greatestates@gmail.com"), false);
});

Deno.test("isFounderOrTestEmail: internal domains", () => {
  assertEquals(isFounderOrTestEmail("anyone@otterquote.com"), true);
  assertEquals(isFounderOrTestEmail("anyone@tryotterquote.com"), true);
  assertEquals(isFounderOrTestEmail("anyone@stellaredgeservices.com"), true);
  assertEquals(isFounderOrTestEmail("anyone@example.com"), true);
});

Deno.test("isFounderOrTestEmail: stohler substring", () => {
  assertEquals(isFounderOrTestEmail("j.stohler@gmail.com"), true);
});

Deno.test("isFounderOrTestEmail: the leads-specific reserved suffix", () => {
  assertEquals(isFounderOrTestEmail("anything@otterquote-internal.test"), true);
});

Deno.test("isFounderOrTestEmail: a normal homeowner address is not excluded", () => {
  assertEquals(isFounderOrTestEmail("jane.doe@gmail.com"), false);
});

Deno.test("isFounderOrTestEmail: fails closed on an unusable address", () => {
  assertEquals(isFounderOrTestEmail(""), true);
  assertEquals(isFounderOrTestEmail(null), true);
  assertEquals(isFounderOrTestEmail("not-an-email"), true);
});

Deno.test("hasUsableEmail", () => {
  assertEquals(hasUsableEmail("jane@gmail.com"), true);
  assertEquals(hasUsableEmail(""), false);
  assertEquals(hasUsableEmail("   "), false);
  assertEquals(hasUsableEmail(null), false);
  assertEquals(hasUsableEmail(undefined), false);
});

Deno.test("isSyntheticLead: only true excludes", () => {
  assertEquals(isSyntheticLead(true), true);
  assertEquals(isSyntheticLead(false), false);
  assertEquals(isSyntheticLead(null), false);
  assertEquals(isSyntheticLead(undefined), false);
});

// ── Fix round 1 (should-fix): otterquote.com SUBDOMAIN exclusion ───────────
// Fails against head 0a4988fe: only an exact domain match was excluded.

Deno.test("isFounderOrTestEmail: excludes a subdomain of a founder domain", () => {
  assertEquals(isFounderOrTestEmail("anyone@mail.otterquote.com"), true);
  assertEquals(isFounderOrTestEmail("anyone@internal.tryotterquote.com"), true);
  assertEquals(isFounderOrTestEmail("anyone@a.b.stellaredgeservices.com"), true);
});

Deno.test("isFounderOrTestEmail: does NOT exclude a look-alike domain that merely ends the same", () => {
  assertEquals(isFounderOrTestEmail("anyone@nototterquote.com"), false);
});

// ── Fix round 1 (must-fix 5): isSingleValidEmail ────────────────────────────
// Fails against head 0a4988fe: this export does not exist yet.

Deno.test("isSingleValidEmail: accepts a normal single address", () => {
  assertEquals(isSingleValidEmail("jane.doe+home@gmail.com"), true);
  assertEquals(isSingleValidEmail("  jane@gmail.com  "), true); // wrapping whitespace only
});

Deno.test("isSingleValidEmail: rejects a comma-separated list (adversarial test A6)", () => {
  assertEquals(isSingleValidEmail("victim@gmail.com,attacker@evil.example"), false);
});

Deno.test("isSingleValidEmail: rejects a semicolon-separated list", () => {
  assertEquals(isSingleValidEmail("victim@gmail.com;attacker@evil.example"), false);
});

Deno.test("isSingleValidEmail: rejects a display-name form", () => {
  assertEquals(isSingleValidEmail("Jane Doe <jane@gmail.com>"), false);
});

Deno.test("isSingleValidEmail: rejects embedded whitespace", () => {
  assertEquals(isSingleValidEmail("jane doe@gmail.com"), false);
});

Deno.test("isSingleValidEmail: rejects a bare local part / missing domain dot / non-string / blank", () => {
  assertEquals(isSingleValidEmail("jane@localhost"), false);
  assertEquals(isSingleValidEmail("not-an-email"), false);
  assertEquals(isSingleValidEmail(""), false);
  assertEquals(isSingleValidEmail(null), false);
  assertEquals(isSingleValidEmail(undefined), false);
});
