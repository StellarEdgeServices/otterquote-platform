// gh-1944 — unit tests for this template's postal-address constant.
//
// Run: deno test supabase/functions/send-homeowner-next-steps/email-footer.test.ts
//
// The address is the SAME D-237 mailbox address already ruled on for #1824
// (comment 5583808162, 2026-09-08T10:35:53Z) — this is a new commercial-email
// surface reusing an answered legal string, not a fresh legal decision.

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

const EXPECTED =
  "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224";

Deno.test("gh-1944: the D-237 mailbox address is the resolved constant, not a placeholder", () => {
  assertEquals(POSTAL_ADDRESS, EXPECTED);
  assertEquals(isPostalAddressResolved(), true);
});

Deno.test("gh-1944: both renderers emit whatever the single constant holds — no second source", () => {
  assertEquals(footerPostalAddressText(), POSTAL_ADDRESS);
});

Deno.test("gh-1944: the placeholder token never reaches the render path", () => {
  const text: string = footerPostalAddressText();
  const html: string = footerPostalAddressHtml();
  assertEquals(text.includes("{{"), false);
  assertEquals(html.includes("{{"), false);
});

Deno.test("gh-1944: the resolved state emits the address line, not an empty render", () => {
  assertEquals(footerPostalAddressText().length > 0, true);
  assertEquals(footerPostalAddressHtml().length > 0, true);
});

Deno.test("gh-1944: the D-237 mailbox address line is present in both renderers", () => {
  assertEquals(footerPostalAddressText(), EXPECTED);
  assertStringIncludes(footerPostalAddressHtml(), EXPECTED);
});

Deno.test("gh-1944: the retired literal-token constant is still greppable, for the historical record", () => {
  assertStringIncludes(POSTAL_ADDRESS_PLACEHOLDER, "{{");
  assertStringIncludes(POSTAL_ADDRESS_PLACEHOLDER, "POSTAL_ADDRESS");
});
