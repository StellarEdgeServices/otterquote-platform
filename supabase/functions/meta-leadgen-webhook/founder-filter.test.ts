// #2123 HO-2 fix round item 7 — founder-filter.ts tests (duplicated from
// send-lead-next-step-reminder/founder-filter.test.ts's own coverage of the
// identical function, see founder-filter.ts's header for why it's a
// duplicate rather than a cross-function import).
import { assert, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isFounderOrTestEmail } from "./founder-filter.ts";

Deno.test("isFounderOrTestEmail: an otterquote.com address is excluded", () => {
  assert(isFounderOrTestEmail("dustin@otterquote.com"));
});

Deno.test("isFounderOrTestEmail: the reserved internal-test suffix is excluded", () => {
  assert(isFounderOrTestEmail("qa-run-42@otterquote-internal.test"));
});

Deno.test("isFounderOrTestEmail: an ordinary homeowner address is NOT excluded", () => {
  assertFalse(isFounderOrTestEmail("pat.homeowner@gmail.com"));
});

Deno.test("isFounderOrTestEmail: a real address that merely contains 'test' is NOT excluded", () => {
  assertFalse(isFounderOrTestEmail("greatestates@gmail.com"));
});

Deno.test("isFounderOrTestEmail: empty/unparseable address fails closed to excluded", () => {
  assert(isFounderOrTestEmail(""));
  assert(isFounderOrTestEmail(undefined));
  assert(isFounderOrTestEmail("not-an-email"));
});
