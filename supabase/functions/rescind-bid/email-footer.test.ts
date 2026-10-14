// gh-2564: rescind-bid now sends one homeowner email, so it carries the D-237 postal-address footer like its
// siblings. Guard against drift from the canonical constant (this test may cross-import; production files may not).
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { POSTAL_ADDRESS, footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";
import { POSTAL_ADDRESS as HOMEOWNER_NEXT_STEPS_POSTAL_ADDRESS } from "../send-homeowner-next-steps/email-footer.ts";

Deno.test("gh-2564 rescind-bid POSTAL_ADDRESS is byte-identical to send-homeowner-next-steps' D-237 constant", () => {
  assertEquals(POSTAL_ADDRESS, HOMEOWNER_NEXT_STEPS_POSTAL_ADDRESS);
});

Deno.test("footer helpers render the address", () => {
  assertEquals(footerPostalAddressText(), POSTAL_ADDRESS);
  assertEquals(footerPostalAddressHtml().includes(POSTAL_ADDRESS), true);
});
