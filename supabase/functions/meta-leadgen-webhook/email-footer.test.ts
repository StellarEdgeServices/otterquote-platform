// gh-2154 P-5r — duplicated D-237 POSTAL_ADDRESS constant drift guard.
// Run: deno test --allow-read=supabase/functions supabase/functions/meta-leadgen-webhook/email-footer.test.ts
//
// This DOES cross-import (deno test resolves relative specifiers against
// the real filesystem regardless of what the EF deploy bundler can
// follow) — see email-footer.ts's own header.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { POSTAL_ADDRESS as META_LEADGEN_POSTAL_ADDRESS } from "./email-footer.ts";
import { POSTAL_ADDRESS as PARTNER_ONBOARDING_POSTAL_ADDRESS } from "../send-partner-onboarding/email-footer.ts";

Deno.test("meta-leadgen-webhook's POSTAL_ADDRESS is byte-identical to send-partner-onboarding's D-237 constant", () => {
  assertEquals(META_LEADGEN_POSTAL_ADDRESS, PARTNER_ONBOARDING_POSTAL_ADDRESS);
});

Deno.test("POSTAL_ADDRESS is the resolved D-237 answer, not empty and not a bracket placeholder", () => {
  assertEquals(META_LEADGEN_POSTAL_ADDRESS.length > 0, true);
  assertEquals(META_LEADGEN_POSTAL_ADDRESS.includes("["), false);
});
