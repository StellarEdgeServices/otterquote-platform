// Deno unit test for gh-1824's duplicated D-237 POSTAL_ADDRESS constant in
// this function.
// Run: deno test supabase/functions/send-partner-status-email/email-footer.test.ts
//
// email-footer.ts documents why this constant is duplicated rather than
// imported (the EF deploy bundler doesn't resolve cross-directory imports).
// This test is the guard against drift: it DOES cross-import, because
// `deno test` resolves relative module specifiers against the real
// filesystem regardless of what the deploy bundler can follow -- so this
// import is safe here even though no production file may take it.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { POSTAL_ADDRESS as OWN_POSTAL_ADDRESS, footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";
import { POSTAL_ADDRESS as HOMEOWNER_NEXT_STEPS_POSTAL_ADDRESS } from "../send-homeowner-next-steps/email-footer.ts";

Deno.test("gh-1824 send-partner-status-email POSTAL_ADDRESS is byte-identical to send-homeowner-next-steps' D-237 constant", () => {
  assertEquals(OWN_POSTAL_ADDRESS, HOMEOWNER_NEXT_STEPS_POSTAL_ADDRESS);
});

Deno.test("POSTAL_ADDRESS is the resolved D-237 answer, not empty and not a bracket placeholder", () => {
  assertEquals(OWN_POSTAL_ADDRESS.length > 0, true);
  assertEquals(OWN_POSTAL_ADDRESS.includes("["), false);
  assertEquals(
    OWN_POSTAL_ADDRESS,
    "Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224",
  );
});

Deno.test("footerPostalAddressText/Html render the address (negative control: fails if POSTAL_ADDRESS is ever emptied)", () => {
  assertEquals(footerPostalAddressText(), OWN_POSTAL_ADDRESS);
  assertEquals(footerPostalAddressHtml().includes(OWN_POSTAL_ADDRESS), true);
});
