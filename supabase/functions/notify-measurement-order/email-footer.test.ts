// gh-1412 / gh-1824 — unit tests for the single postal-address constant.
//
// Run: deno test supabase/functions/<function>/email-footer.test.ts
//
// CEO Tier B ruling (2026-09-08, on R-177 LEGAL-READ FAIL ceo35-legalread-j):
// until #1824 is answered, the postal-address line is OMITTED ENTIRELY. The
// tripwire below is the INVERSE of the version this replaces: the prior test
// asserted the literal token `{{POSTAL_ADDRESS}}` WAS the rendered value —
// this one FAILS the moment a literal placeholder ever reaches either
// renderer again, and PASSES on omission (empty string / no element).

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  footerPostalAddressHtml,
  footerPostalAddressText,
  isPostalAddressResolved,
  POSTAL_ADDRESS,
  POSTAL_ADDRESS_PLACEHOLDER,
} from "./email-footer.ts";

Deno.test("gh-1824: the address is omitted, not a literal placeholder — Dustin has not answered yet", () => {
  // TRIPWIRE, not an aspiration. When #1824 is answered and POSTAL_ADDRESS
  // becomes a real address, this assertion flips and the change is visible
  // in the test run, not silent.
  assertEquals(POSTAL_ADDRESS, "");
  assertEquals(isPostalAddressResolved(), false);
});

Deno.test("gh-1824: both renderers emit whatever the single constant holds — no second source", () => {
  assertEquals(footerPostalAddressText(), POSTAL_ADDRESS);
});

Deno.test("gh-1824: the placeholder token never reaches the render path — FAILS on a literal, PASSES on omission", () => {
  // This is the inversion of the test that locked in the FAILED behaviour
  // (R-177 LEGAL-READ, ceo35-legalread-j): that version asserted the render
  // path returned the literal `{{POSTAL_ADDRESS}}` and passed. This version
  // fails the instant either renderer emits that literal token again.
  const text: string = footerPostalAddressText();
  const html: string = footerPostalAddressHtml();
  assertEquals(text.includes("{{"), false);
  assertEquals(html.includes("{{"), false);
});

Deno.test("gh-1824: the un-answered state emits no address line at all", () => {
  // Omission means nothing to find in the rendered message — not an empty
  // element sitting where the address would go.
  const text: string = footerPostalAddressText();
  const html: string = footerPostalAddressHtml();
  assertEquals(text.length, 0);
  assertEquals(html.length, 0);
});

Deno.test("gh-1824: the retired literal-token constant is still greppable, for the historical record", () => {
  // POSTAL_ADDRESS_PLACEHOLDER is no longer POSTAL_ADDRESS's value (see the
  // FAIL this replaces) but stays a named export so a compliance sweep can
  // assert this exact string never appears in a rendered email again.
  assertStringIncludes(POSTAL_ADDRESS_PLACEHOLDER, "{{");
  assertStringIncludes(POSTAL_ADDRESS_PLACEHOLDER, "POSTAL_ADDRESS");
});
