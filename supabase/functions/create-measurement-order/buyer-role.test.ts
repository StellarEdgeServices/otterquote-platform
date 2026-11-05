// gh-3447 -- a PAID order with a missing/unknown buyer_role is recorded and alerted, not answered with a 400.
// Before: index.ts returned 400 "buyer_role must be 'homeowner' or 'contractor'." before the Stripe lookup, so the buyer had paid and had no order.
// Run: deno test supabase/functions/create-measurement-order/buyer-role.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BUYER_ROLE_ALERT_TYPE,
  buildBuyerRoleAlertRow,
  raiseBuyerRoleAlert,
  resolveBuyerRole,
  UNSPECIFIED_ROLE,
} from "./buyer-role.ts";

const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const ORDER = "11111111-2222-4333-8444-555555555555";
const CLAIM = "66666666-7777-4888-8999-000000000000";

Deno.test("resolveBuyerRole: only the two real roles pass; missing, null, empty, wrong case and junk are unresolved", () => {
  assertEquals(resolveBuyerRole("homeowner"), { role: "homeowner", unresolved: false });
  assertEquals(resolveBuyerRole("contractor"), { role: "contractor", unresolved: false });
  for (const v of [undefined, null, "", "Homeowner", "admin", 7, {}, ["homeowner"]]) {
    assertEquals(resolveBuyerRole(v), { role: UNSPECIFIED_ROLE, unresolved: true }, String(v));
  }
});

Deno.test("the unresolved role is never 'homeowner' (the $5 accrual trigger fires only for 'homeowner')", () => {
  assertEquals(["homeowner", "contractor"].includes(UNSPECIFIED_ROLE as string), false);
  assertEquals(resolveBuyerRole(undefined).role === "homeowner", false);
});

Deno.test("alert row: validated shapes only, names the order, payment and claim, says no fee accrues", () => {
  const r = buildBuyerRoleAlertRow({ orderId: ORDER, paymentIntentId: "pi_3Abc123", claimId: CLAIM, productCode: "roof_basic" }, () => new Date("2026-11-05T12:00:00Z"));
  assertEquals(r.alert_type, BUYER_ROLE_ALERT_TYPE);
  assertEquals(r.function_name, "create-measurement-order");
  assertEquals(r.sent_at, "2026-11-05T12:00:00.000Z");
  for (const s of [ORDER, "pi_3Abc123", CLAIM, "roof_basic", "unspecified", "no $5 partner fee"]) assertStringIncludes(r.message, s);
});

Deno.test("alert row: NEGATIVE CONTROL -- hostile text in any field is replaced, never echoed", () => {
  const r = buildBuyerRoleAlertRow({ orderId: "x\n<script>", paymentIntentId: "pi_x<b>", claimId: "'; DROP", productCode: "A B" });
  assert(!r.message.includes("<") && !r.message.includes("DROP") && !r.message.includes("\n"));
  assertStringIncludes(r.message, "order none");
});

Deno.test("raiseBuyerRoleAlert: writes the row; a failing or throwing insert is logged and never thrown", async () => {
  const rows: unknown[] = []; const logs: string[] = [];
  const row = buildBuyerRoleAlertRow({ orderId: ORDER, paymentIntentId: "pi_1", claimId: CLAIM, productCode: "roof_basic" });
  await raiseBuyerRoleAlert(async (r) => { rows.push(r); return { error: null }; }, (m) => logs.push(m), row);
  assertEquals(rows.length, 1); assertEquals(logs.length, 0);
  await raiseBuyerRoleAlert(async () => ({ error: { message: "x" } }), (m) => logs.push(m), row);
  await raiseBuyerRoleAlert(() => { throw new Error("boom"); }, (m) => logs.push(m), row);
  await raiseBuyerRoleAlert(() => { throw new Error("boom"); }, () => { throw new Error("log boom"); }, row);
  assertEquals(logs.length, 2);
});

// -- structure of index.ts (it starts a server on import, so its wiring is asserted from source, as the non-USD alert tests do) --
Deno.test("index.ts: REGRESSION -- no early 400 for a missing or unknown buyer_role (this fails on the code before gh-3447)", () => {
  assert(!index.includes("buyer_role must be 'homeowner' or 'contractor'"), "the pre-payment 400 is gone");
  assert(!/body\.buyer_role\s*!==\s*"homeowner"/.test(index), "no direct role gate on the request body");
  assert(index.includes("resolveBuyerRole(body.buyer_role)"));
});

Deno.test("index.ts: the role is resolved BEFORE Stripe and the paid insert carries it; the alert follows a successful insert and precedes the order email", () => {
  const paidInsert = index.indexOf('status: "awaiting_fulfillment"');
  assert(paidInsert > 0);
  assert(index.slice(paidInsert, paidInsert + 400).includes("requested_by_role: buyerRole"), "the paid insert uses the resolved role (unspecified when unresolved)");
  const verify = index.indexOf("const paid = await verifyPayment(");
  const alertAt = index.indexOf("if (roleUnresolved) {");
  const notify = index.indexOf("await recordOrderCreated(supabase, supabaseUrl, order,");
  assert(verify > 0 && paidInsert > verify, "payment is verified before the insert");
  assert(alertAt > paidInsert && notify > alertAt, "alert after the insert, before the order email");
  assertEquals(index.split("if (roleUnresolved) {").length - 1, 1, "only the paid path alerts");
  assert(index.indexOf("insErr", paidInsert) < alertAt, "a failed insert returns its 500 before the alert runs");
});

Deno.test("index.ts: an unpaid request with an unresolved role is still refused (quote-only SKU needs a contractor; paid SKU needs a succeeded PaymentIntent)", () => {
  assert(index.includes('if (buyerRole !== "contractor") {\n        return json({ error: "That report is not available for purchase." }, 400'));
  assert(index.includes("if (!paid.ok) {"), "the payment checks still gate the insert");
});

Deno.test("index.ts: upgrade -- unresolved role derives contractor only WITH a contractor_id; explicit homeowner or contractor-without-id is still refused", () => {
  assert(index.includes('if (!roleUnresolved && (buyerRole !== "contractor" || !contractorId)) {'));
});

Deno.test("index.ts: upgrade -- a PAID upgrade with no usable role and no contractor_id is recorded as unspecified and alerted, never a 400 (fails on the code before the fix)", () => {
  const guard = index.indexOf('if (!roleUnresolved && (buyerRole !== "contractor" || !contractorId)) {');
  const verify = index.indexOf("const paidUpgrade = await verifyUpgradePayment(");
  const role = index.indexOf('const upgradeRole = roleUnresolved && !contractorId ? UNSPECIFIED_ROLE : "contractor";');
  const insert = index.indexOf(".insert(upgradePayload)");
  const alertAt = index.indexOf("if (upgradeRole === UNSPECIFIED_ROLE) {");
  assert(guard > 0 && verify > guard, "an unresolved role reaches the Stripe verification");
  assert(role > verify && insert > role && alertAt > insert, "verified, then recorded, then alerted");
  assert(index.includes("requested_by_role: UNSPECIFIED_ROLE, requested_by_contractor_id: null"));
  assert(index.indexOf("UPGRADE_PRODUCT_CODE,\n        upgradeRole,") > 0, "the order email and activity_log carry the effective role");
});
