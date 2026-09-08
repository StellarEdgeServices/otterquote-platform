// gh-1786 / D-320 — the duplicated token module must not drift.
// Run: deno test --allow-read=supabase/functions supabase/functions/homeowner-email-optout/optout-token.parity.test.ts
//
// This repo's Edge Function deploy path does not resolve cross-directory or
// `_shared/` imports (see send-home-profile-prompt/index.ts line 91), so the
// token module exists twice. Two copies of a signature routine that disagree
// would produce links the endpoint rejects — a silent, total opt-out failure
// that no unit test of either copy alone would catch. This test is the guard.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const BEGIN = "// ─── BEGIN PARITY REGION";
const END = "// ─── END PARITY REGION";
const CANONICAL = "supabase/functions/send-homeowner-next-steps/optout-token.ts";
const COPY = "supabase/functions/homeowner-email-optout/optout-token.ts";

function parityRegion(path: string): string {
  const src = Deno.readTextFileSync(path);
  const start = src.indexOf(BEGIN);
  const end = src.indexOf(END);
  assert(start !== -1, `${path}: missing ${BEGIN}`);
  assert(end > start, `${path}: missing ${END} after the begin marker`);
  return src.slice(start, end);
}

Deno.test("the two optout-token.ts copies are identical inside the parity region", () => {
  const a = parityRegion(CANONICAL);
  const b = parityRegion(COPY);
  assertEquals(b, a);
  // NEGATIVE CONTROL — the comparison is not vacuous: the region is substantial
  // and contains the signing routine, so a real divergence would be caught.
  assert(a.length > 1500, `parity region suspiciously small: ${a.length} bytes`);
  assert(a.includes("export async function signOptOutToken"), "parity region must cover the signer");
  assert(a.includes("export async function verifyOptOutToken"), "parity region must cover the verifier");
  // ...and the headers ABOVE the region deliberately differ, which proves the
  // slice is doing the work rather than the files simply being one file.
  assert(
    Deno.readTextFileSync(CANONICAL) !== Deno.readTextFileSync(COPY),
    "the two files should differ in their headers (canonical vs copy)",
  );
});
