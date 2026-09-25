// Deno unit tests for gh-2121 founder/internal/synthetic exclusion.
// Run: deno test supabase/functions/send-lead-next-step-reminder/founder-filter.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { hasUsableEmail, isFounderOrTestEmail, isSyntheticLead } from "./founder-filter.ts";

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
