// gh-3459 -- index.ts must not record a client-sent buyer_role of 'homeowner' without the ownership proof. Source-text assertions only,
// so this file imports nothing new and FAILS BY ASSERTION on the code before gh-3459 (index.ts starts a server on import, same approach as buyer-role.test.ts).
// Run: deno test --allow-read supabase/functions/create-measurement-order/explicit-homeowner-wiring.test.ts
import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const paidPath = index.slice(index.indexOf("const paid = await verifyPayment("));

Deno.test("index.ts: the paid path never copies the client's role straight into the order (REGRESSION, fails before gh-3459)", () => {
  assert(!/let paidRole:\s*string\s*=\s*buyerRole/.test(paidPath), "paidRole must not start as the client's role");
  assert(!/const paidRole:\s*string\s*=\s*buyerRole/.test(paidPath));
});

Deno.test("index.ts: an explicit 'homeowner' goes through decidePaidRole before the insert (REGRESSION, fails before gh-3459)", () => {
  const decide = paidPath.indexOf("await decidePaidRole({");
  const insert = paidPath.indexOf('status: "awaiting_fulfillment"');
  assert(decide > 0, "decidePaidRole is called on the paid path");
  assert(insert > decide, "the role is decided before the order is written");
  const call = paidPath.slice(decide, insert);
  assert(call.includes("requestedRole: buyerRole"), "the client's role is only the REQUEST");
  assert(!/if \(roleUnresolved\)/.test(call), "the proof is not limited to an unresolved role");
});

Deno.test("index.ts: a not-shown homeowner is alerted like any unspecified role, and the order is still recorded (a paid customer never loses the order)", () => {
  assert(index.includes("const roleStillUnspecified = paidRole === UNSPECIFIED_ROLE;"));
  assert(index.includes("if (roleStillUnspecified) {"));
  assert(paidPath.indexOf("if (roleStillUnspecified) {") > paidPath.indexOf(".insert({"), "alert after the insert");
});
