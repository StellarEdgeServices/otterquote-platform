// gh-3047 -- wiring test (sibling of switch-contractor's gh-3017 test): the
// dunning "different contractor" reset to bidding clears an UNSIGNED
// color_confirmation_envelope_id in the SAME claims update, and the homeowner_choice
// fetch selects the two columns the decision needs. Reads index.ts as text (the EF
// calls serve() and cannot be imported).
// FAIL-FIRST: on main's index.ts the reset update has no color_confirmation_envelope_id.
import { assert, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("dunning reset to bidding clears an unsigned colour envelope id in the same write", () => {
  const start = src.indexOf("// Reset claim to bidding");
  const end = src.indexOf("// Restore other quotes to submitted");
  assert(start !== -1 && end > start, "anchors moved; update this test");
  const block = src.slice(start, end);
  assertStringIncludes(block, "color_confirmation_envelope_id: null");
  assertStringIncludes(block, "!claim?.color_confirmed_at");
  assertStringIncludes(block, 'status: "bidding"');
  assert(block.split('.from("claims")').length === 2, "expected exactly one claims update in the reset");
});

Deno.test("homeowner_choice claim join selects the colour-envelope columns the reset reads", () => {
  const i = src.indexOf("claims:claim_id (id, property_address, status");
  assert(i !== -1, "claims join anchor moved");
  const line = src.slice(i, src.indexOf("\n", i));
  assertStringIncludes(line, "color_confirmation_envelope_id");
  assertStringIncludes(line, "color_confirmed_at");
});
