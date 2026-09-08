// gh-1412 / gh-1824 — unit tests for the single postal-address constant.
//
// Run: deno test supabase/functions/<function>/email-footer.test.ts

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

Deno.test("gh-1824: the address is still the placeholder — Dustin has not answered yet", () => {
  // This test is a TRIPWIRE, not an aspiration. When #1824 is answered and
  // POSTAL_ADDRESS becomes a real address, this assertion flips and the two
  // below it become the live ones. That is the intended signal: the one-line
  // change is visible in the test run, not silent.
  assertEquals(POSTAL_ADDRESS, POSTAL_ADDRESS_PLACEHOLDER);
  assertEquals(isPostalAddressResolved(), false);
});

Deno.test("gh-1824: both renderers emit whatever the single constant holds — no second source", () => {
  assertEquals(footerPostalAddressText(), POSTAL_ADDRESS);
  assertStringIncludes(footerPostalAddressHtml(), POSTAL_ADDRESS);
});

Deno.test("gh-1824: neither renderer can return empty — a missing footer line must be visible", () => {
  assertEquals(footerPostalAddressText().length > 0, true);
  assertEquals(footerPostalAddressHtml().length > 0, true);
});

Deno.test("gh-1824: the unresolved token is greppable, so a compliance sweep can find it", () => {
  // If the placeholder were something like "" or "TBD", a sweep for an
  // unresolved footer would have nothing to match on.
  assertStringIncludes(POSTAL_ADDRESS_PLACEHOLDER, "{{");
  assertStringIncludes(POSTAL_ADDRESS_PLACEHOLDER, "POSTAL_ADDRESS");
});
