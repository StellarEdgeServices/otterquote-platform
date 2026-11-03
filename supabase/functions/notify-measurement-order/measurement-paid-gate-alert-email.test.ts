// gh-3356: notify-measurement-order's second alert mode (the paid-claim gate's two alerts). The body arrives over HTTP, so every field is re-validated.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildPaidGateAlertEmail, PAID_GATE_ALERT_TOKEN } from "./measurement-paid-gate-alert-email.ts";
import { buildNonUsdAlertEmail } from "./non-usd-alert-email.ts";

const body = (over: Record<string, unknown> = {}) => ({
  alert: "measurement_paid_gate", kind: "paid_without_order", claim_id: "c0ffee00-0000-4000-8000-000000000001",
  payment_intent_id: "pi_3Abc123", stage: "before create", ...over,
});

Deno.test("paid-gate email: the token is measurement_paid_gate", () => assertEquals(PAID_GATE_ALERT_TOKEN, "measurement_paid_gate"));

Deno.test("paid-gate email: paid_without_order names the claim and PaymentIntent, links Stripe, says no order is queued and that refunds are manual", () => {
  const e = buildPaidGateAlertEmail(body())!;
  assert(e && /ACTION NEEDED/.test(e.subject) && /no order is queued/.test(e.subject));
  for (const part of ["c0ffee00-0000-4000-8000-000000000001", "pi_3Abc123", "before create", "https://dashboard.stripe.com/payments/pi_3Abc123"]) {
    assert(e.text.includes(part), "text has " + part);
  }
  assert(e.html.includes('href="https://dashboard.stripe.com/payments/pi_3Abc123"'));
  assert(/refund is a manual decision|manual decision/.test(e.text));
});

Deno.test("paid-gate email: check_unavailable says nothing was charged and names the likely cause, with no PaymentIntent needed", () => {
  const e = buildPaidGateAlertEmail(body({ kind: "check_unavailable", payment_intent_id: null }))!;
  assert(/unavailable/i.test(e.subject));
  assert(/Nothing was charged/.test(e.text) && /search endpoint/.test(e.text) && /one of these emails is sent per claim per hour/.test(e.text));
  assert(!e.text.includes("dashboard.stripe.com"));
});

Deno.test("paid-gate email: a body that is not this alert, or has an unknown kind, builds nothing; and the non-USD builder ignores this body", () => {
  for (const b of [null, undefined, {}, "x", 5, body({ alert: "other" }), body({ kind: "refund" }), body({ kind: undefined })]) assertEquals(buildPaidGateAlertEmail(b), null);
  assertEquals(buildNonUsdAlertEmail(body()), null);
  assertEquals(buildPaidGateAlertEmail({ alert: "non_usd_payment_rejected", flow: "report" }), null);
});

Deno.test("paid-gate email: hostile field values print as 'unrecognized' and never reach the email verbatim", () => {
  const evil = "<script>alert(1)</script>\nBcc: x@y.z";
  const e = buildPaidGateAlertEmail(body({ claim_id: evil, payment_intent_id: evil, stage: evil }))!;
  assert(e.text.includes("unrecognized") && !e.text.includes("<script>") && !e.html.includes("<script>") && !e.text.includes("Bcc:") && !e.html.includes("Bcc:"));
  assert(!e.text.includes("dashboard.stripe.com"));
});

Deno.test("paid-gate email: wired into notify-measurement-order's alert mode, after the service-role check and before the order_id requirement", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const iBearer = src.indexOf("bearerToken !== serviceRoleKey");
  const iAlert = src.indexOf("buildNonUsdAlertEmail(body) ?? buildPaidGateAlertEmail(body)");
  const iOrder = src.indexOf("const orderId = body?.order_id");
  assert(iBearer > -1 && iAlert > iBearer && iOrder > iAlert);
});
