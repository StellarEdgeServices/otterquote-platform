// gh-2154 P-4 (Kevin correction Q1) — the duplicated token module must not
// drift, same guard convention as homeowner-email-optout/optout-token.
// parity.test.ts.
// Run: deno test --allow-read=supabase/functions supabase/functions/partner-email-optout/optout-token.parity.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const BEGIN = "// ─── BEGIN PARITY REGION";
const END = "// ─── END PARITY REGION";
const CANONICAL = "supabase/functions/partner-email-optout/optout-token.ts";
const COPY = "supabase/functions/send-partner-onboarding/optout.ts";

function parityRegion(path: string): string {
  const src = Deno.readTextFileSync(path);
  const start = src.indexOf(BEGIN);
  const end = src.indexOf(END);
  assert(start !== -1, `${path}: missing ${BEGIN}`);
  assert(end > start, `${path}: missing ${END} after the begin marker`);
  return src.slice(start, end);
}

Deno.test("the two optout-token.ts copies (partner-email-optout / send-partner-onboarding) are identical inside the parity region", () => {
  const a = parityRegion(CANONICAL);
  const b = parityRegion(COPY);
  assertEquals(b, a);
  // NEGATIVE CONTROL — the comparison is not vacuous.
  assert(a.length > 1500, `parity region suspiciously small: ${a.length} bytes`);
  assert(a.includes("export async function signPartnerOptOutToken"), "parity region must cover the signer");
  assert(a.includes("export async function verifyPartnerOptOutToken"), "parity region must cover the verifier");
  assert(
    Deno.readTextFileSync(CANONICAL) !== Deno.readTextFileSync(COPY),
    "the two files should differ in their headers (canonical vs copy)",
  );
});
