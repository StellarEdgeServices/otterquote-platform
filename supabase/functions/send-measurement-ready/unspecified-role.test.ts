// gh-3447 (#3447 comment 6668223064): the "ready" email must not claim "you ordered" for an order whose buyer role is 'unspecified'.
// The handler starts a server on import, so its wiring is asserted from source (as the other tests in this repo do).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("an 'unspecified' order is suppressed and alerted BEFORE the homeowner profile lookup and any send", () => {
  const guard = src.indexOf('if (order.requested_by_role === "unspecified") {');
  const profile = src.indexOf('.from("profiles")');
  assert(guard > 0, "guard exists");
  assert(guard < profile, "before the homeowner profile lookup");
  assert(src.includes('reason: "role_unspecified"'));
  assert(src.includes('alert_type: "ready_email_suppressed_unspecified_role"'));
  assert(src.includes("#3460"));
});

Deno.test("NEGATIVE CONTROL: only the exact value 'unspecified' is suppressed; the contractor skip is unchanged", () => {
  assertEquals(src.split('requested_by_role === "unspecified"').length - 1, 1);
  assert(src.includes('(order.requested_by_role || "homeowner") === "contractor"'));
});
