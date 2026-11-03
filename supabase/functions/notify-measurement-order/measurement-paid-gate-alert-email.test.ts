// gh-3356: notify-measurement-order's second alert mode (the paid-claim gate's two alerts). The body arrives over HTTP, so every field is re-validated.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildPaidGateAlertEmail, PAID_GATE_ALERT_TOKEN } from "./measurement-paid-gate-alert-email.ts";
import { buildNonUsdAlertEmail } from "./non-usd-alert-email.ts";

const body = (over: Record<string, unknown> = {}) => ({
  alert: "measurement_paid_gate", kind: "paid_without_order", claim_id: "c0ffee00-0000-4000-8000-000000000001",
  payment_intent_id: "pi_3Abc123", stage: "before create", ...over,
});

Deno.test("paid-gate email: the token is measurement_paid_gate", () => assertEquals(PAID_GATE_ALERT_TOKEN, "measurement_paid_gate"));

Deno.test("paid-gate email: paid_without_order names the claim and PaymentIntent, links Stripe, says no order row was found and that refunds are manual", () => {
  const e = buildPaidGateAlertEmail(body())!;
  assert(e && /ACTION NEEDED/.test(e.subject) && /no order row was found/.test(e.subject));
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
  const iAlert = src.indexOf("nonUsdEmail ?? buildPaidGateAlertEmail(body)");
  const iOrder = src.indexOf("const orderId = body?.order_id");
  assert(iBearer > -1 && iAlert > iBearer && iOrder > iAlert);
});

// ── F5: a failed paid-claim alert email must not be logged as a non-USD problem ──────────────────────────────────────────────────
Deno.test("paid-gate email: the send-failure text for the paid-claim alerts names the paid-claim alert, never the non-USD row; the non-USD text is unchanged", async () => {
  const { alertSendFailureText } = await import("./measurement-paid-gate-alert-email.ts");
  const paid = alertSendFailureText(true);
  for (const t of [paid.log, paid.rowMessage, paid.rowWriteFailedLog]) assert(!/non-?usd/i.test(t), `no non-USD wording: ${t}`);
  assert(/measurement_paid_without_order/.test(paid.rowMessage) && /measurement_paid_check_unavailable/.test(paid.rowMessage));
  const nonUsd = alertSendFailureText(false);
  assertEquals(nonUsd.log, "non-usd alert email send failed");
  assertEquals(nonUsd.rowMessage, "non-USD payment alert email could not be sent; see the non_usd_payment_rejected alert row");
});

Deno.test("notify-measurement-order index.ts: the alert-send failure path takes its text from alertSendFailureText for the matched alert (no hard-coded non-USD string left)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url).pathname);
  assert(src.includes("const nonUsdEmail = buildNonUsdAlertEmail(body);") && src.includes("alertSendFailureText(!nonUsdEmail)"));
  const failurePath = src.slice(src.indexOf("} catch (_alertSendErr) {"), src.indexOf("return json({ success: true, alert: true }"));
  assert(failurePath.length > 100);
  assert(!/non-?usd/i.test(failurePath.replace(/_alertSendErr/g, "")), "the failure path has no non-USD literal");
  assert(failurePath.includes("failureText.log") && failurePath.includes("failureText.rowMessage") && failurePath.includes("failureText.rowWriteFailedLog"));
});

Deno.test("paid-gate email: paid_without_order reads a recent charge as 'order may still be in progress; check the order row' and does not declare the order missing", () => {
  const e = buildPaidGateAlertEmail(body({ kind: "paid_without_order" }))!;
  assert(/order may still be in progress/.test(e.text) && /check the order row/.test(e.text));
  assert(/If the order row is still missing after a few minutes/.test(e.text));
});

Deno.test("paid-gate email: refunded_replay names the fully refunded PaymentIntent, only this claim, pay again once Stripe removes the key; no Stripe-search pointer, no 24-hour claim", () => {
  const e = buildPaidGateAlertEmail(body({ kind: "refunded_replay" }))!;
  assert(/fully refunded/.test(e.subject) && /cannot start a report payment/.test(e.subject));
  assert(/Only this claim is affected/.test(e.text) && /pay again once Stripe removes the key/.test(e.text) && /fully refunded/.test(e.text));
  assert(e.text.includes("dashboard.stripe.com/payments/pi_"), "links the refunded PaymentIntent");
  assert(!/24[- ]?h/i.test(e.text) && !/24[- ]?h/i.test(e.subject), "no 24-hour claim");
  assert(!/search the (stripe|dashboard)|stripe search for/i.test(e.text.replace("not a problem with Stripe search", "")), "does not point at Stripe search");
  assert(/At most one of these emails is sent per claim per hour/.test(e.text));
});

Deno.test("paid-gate email: cancelled_replay names a stuck homeowner, asks a person to reach out, claims no 24-hour limit and no charge by that request", () => {
  const e = buildPaidGateAlertEmail(body({ kind: "cancelled_replay" }))!;
  assert(/cannot start a report payment/.test(e.subject));
  assert(/stays stuck until Stripe removes the key/.test(e.text) && /reach out to the homeowner/.test(e.text));
  assert(!/24[- ]?h/i.test(e.text) && !/24[- ]?h/i.test(e.subject), "no 24-hour claim");
  assert(e.text.includes("dashboard.stripe.com/payments/pi_"), "links the cancelled PaymentIntent");
  assert(/At most one of these emails is sent per claim per hour/.test(e.text));
});
