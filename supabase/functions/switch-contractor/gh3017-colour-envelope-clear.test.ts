// gh-3017 -- wiring test: the claim-reset write in switch-contractor clears an
// unsigned color_confirmation_envelope_id in the SAME update. Reads index.ts as
// text (the EF calls serve() and cannot be imported), like the sibling
// gh2105-zero-row-wiring.test.ts.
// FAIL-FIRST: on main's index.ts the reset update has no color_confirmation_envelope_id.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("claim reset clears an unsigned colour envelope id in the same write", () => {
  const start = src.indexOf("// ── 7. Reset the claim");
  const end = src.indexOf("// ── 7b. Persist D-171 survey payload");
  assert(start !== -1 && end > start, "anchors moved; update this test");
  const block = src.slice(start, end);
  assertStringIncludes(block, "color_confirmation_envelope_id: null");
  assertStringIncludes(block, "!claim.color_confirmed_at");
  assertStringIncludes(block, 'status: "bidding"');
  // single claims update: the clear is inside the status reset, not a second write
  assert(block.split('.from("claims")').length === 2, "expected exactly one claims update in step 7");
});
