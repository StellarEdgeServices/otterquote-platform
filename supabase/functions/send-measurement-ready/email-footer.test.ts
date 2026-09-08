// gh-1412 / gh-1824 — unit tests for the single postal-address constant.
//
// Run: deno test supabase/functions/<function>/email-footer.test.ts
//
// #1824 is ANSWERED (Dustin's ruling, comment 5583808162, 2026-09-08T10:35:53Z):
// POSTAL_ADDRESS is the D-237 mailbox address. The tests below were originally
// written against the un-answered (empty/omitted) state; they are updated
// here to assert the resolved state instead. The placeholder-token tripwire
// is unchanged: it still FAILS the moment either renderer emits the literal
// `{{POSTAL_ADDRESS}}` token, and PASSES as long as the render path only ever
// carries the real constant.

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

Deno.test("gh-1824: the D-237 mailbox address is the resolved constant, not a placeholder", () => {
  // #1824 is answered (comment 5583808162): POSTAL_ADDRESS is the D-237
  // mailbox address, and isPostalAddressResolved() flips to true.
  assertEquals(
    POSTAL_ADDRESS,
    "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224",
  );
  assertEquals(isPostalAddressResolved(), true);
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

Deno.test("gh-1824: the resolved state emits the address line, not an empty render", () => {
  const text: string = footerPostalAddressText();
  const html: string = footerPostalAddressHtml();
  assertEquals(text.length > 0, true);
  assertEquals(html.length > 0, true);
});

Deno.test("gh-1824: the D-237 mailbox address line is present in both renderers (Dustin's ruling, comment 5583808162)", () => {
  const expected =
    "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";
  assertEquals(footerPostalAddressText(), expected);
  assertStringIncludes(footerPostalAddressHtml(), expected);
});

Deno.test("gh-1824: the retired literal-token constant is still greppable, for the historical record", () => {
  // POSTAL_ADDRESS_PLACEHOLDER is no longer POSTAL_ADDRESS's value (see the
  // FAIL this replaces) but stays a named export so a compliance sweep can
  // assert this exact string never appears in a rendered email again.
  assertStringIncludes(POSTAL_ADDRESS_PLACEHOLDER, "{{");
  assertStringIncludes(POSTAL_ADDRESS_PLACEHOLDER, "POSTAL_ADDRESS");
});
