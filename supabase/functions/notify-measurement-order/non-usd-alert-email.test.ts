// gh-2107 / D-330 -- the receiving side of Ben's DECIDED (b) on #2078: notify-measurement-order's `alert` mode builds the admin email for a
// rejected non-USD payment. The sender (create-measurement-order) has already validated the fields; this re-validates them, because the
// body arrives over HTTP and an email is built from it.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { NON_USD_ALERT_TYPE, buildNonUsdAlertEmail } from "./non-usd-alert-email.ts";

const body = (over: Record<string, unknown> = {}) => ({
  alert: "non_usd_payment_rejected",
  flow: "report",
  payment_intent_id: "pi_3Abc123",
  currency: "jpy",
  amount_minor: 1500,
  ...over,
});

Deno.test("email: the alert token is non_usd_payment_rejected", () => {
  assertEquals(NON_USD_ALERT_TYPE, "non_usd_payment_rejected");
});

Deno.test("email: a valid alert builds a subject, text and html that name the flow, PaymentIntent, currency and amount", () => {
  const e = buildNonUsdAlertEmail(body());
  assert(e);
  assert(/non-usd/i.test(e.subject) && /refund/i.test(e.subject));
  for (const part of ["pi_3Abc123", "jpy", "1500", "report"]) {
    assert(e.text.includes(part), "text has " + part);
    assert(e.html.includes(part), "html has " + part);
  }
});

Deno.test("email: it links the PaymentIntent in the Stripe dashboard, and says a refund is a manual decision", () => {
  const e = buildNonUsdAlertEmail(body())!;
  assert(e.text.includes("https://dashboard.stripe.com/payments/pi_3Abc123"));
  assert(/manual|Dustin|your call|decision/i.test(e.text));
});

Deno.test("email: the upgrade flow is named as such", () => {
  const e = buildNonUsdAlertEmail(body({ flow: "upgrade", amount_minor: 2500 }))!;
  assert(e.text.includes("upgrade") && e.text.includes("2500"));
});

Deno.test("email: a body that is not this alert, or has an unknown flow, builds nothing", () => {
  for (const b of [null, undefined, {}, "x", 5, body({ alert: "other" }), body({ alert: undefined }), body({ flow: "refund" }), body({ flow: undefined })]) {
    assertEquals(buildNonUsdAlertEmail(b), null);
  }
});

Deno.test("email: hostile field values are re-validated to 'unrecognized' and never reach the email verbatim (no markup, no link, no injection)", () => {
  const evil = "<script>alert(1)</script>\nBcc: x@y.z";
  const e = buildNonUsdAlertEmail(body({ payment_intent_id: evil, currency: evil, amount_minor: evil }))!;
  assert(e);
  for (const out of [e.subject, e.text, e.html]) {
    assert(!out.includes("<script>") && !out.includes("Bcc:") && !out.includes("alert(1)"), out);
  }
  assert(e.text.includes("unrecognized"));
  assert(!e.text.includes("dashboard.stripe.com/payments/"), "no dashboard link without a valid PaymentIntent id");
});

Deno.test("email: an uppercase or 4-letter currency, a negative or fractional amount are unrecognized", () => {
  for (const c of ["JPY", "jpyx", "us", 5, null]) assert(buildNonUsdAlertEmail(body({ currency: c }))!.text.includes("currency: unrecognized"), String(c));
  for (const a of [-1, 1.5, "1500", null, NaN]) assert(buildNonUsdAlertEmail(body({ amount_minor: a }))!.text.includes("amount: unrecognized"), String(a));
});

Deno.test("email: the subject is a single line with no personal data", () => {
  const e = buildNonUsdAlertEmail(body())!;
  assert(!/[\r\n]/.test(e.subject) && !e.subject.includes("@"));
});

Deno.test("email: it carries the postal-address footer like the other emails this function sends", async () => {
  const { POSTAL_ADDRESS } = await import("./email-footer.ts");
  const e = buildNonUsdAlertEmail(body())!;
  assert(e.text.includes(POSTAL_ADDRESS) && e.html.includes(POSTAL_ADDRESS.split(" · ")[0]));
});

// -- structure: the alert mode in index.ts is behind the service-role check and does not touch the order path ---------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("index.ts: the alert mode is dispatched AFTER the service-role bearer check and BEFORE the order_id requirement", () => {
  const authAt = index.indexOf("bearerToken !== serviceRoleKey");
  const modeAt = index.indexOf("buildNonUsdAlertEmail(");
  const orderAt = index.indexOf("Missing required field: order_id");
  assert(authAt > 0 && modeAt > authAt, "after the bearer check");
  assert(orderAt > modeAt, "before the order_id requirement (an alert has no order)");
});

Deno.test("index.ts: the alert branch is live (not disabled), and answers 200 on a sent alert and 502 on a failed one", () => {
  const at = index.indexOf("buildNonUsdAlertEmail(");
  const region = index.slice(at, at + 3200);
  assert(/if \(alertEmail\) \{/.test(region), "the branch is gated on the built email alone");
  assert(region.includes("json({ success: true, alert: true }, 200"), "200 on success");
  assert(region.includes('json({ error: "Failed to send notification" }, 502'), "502 on a failed send");
});

Deno.test("index.ts: the alert mode sends through the same Mailgun call to the same admin address, and a send failure is logged loudly", () => {
  const at = index.indexOf("buildNonUsdAlertEmail(");
  const region = index.slice(at, at + 3200);
  assert(region.includes("api.mailgun.net") && region.includes("ADMIN_EMAIL"));
  assert(region.includes('.from("platform_alerts_log")') && /alert_type:\s*"notification_failed"/.test(region) && /message:\s*"/.test(region), "a failed send leaves an alert row with a type and a fixed message");
  assert(region.includes("return json("), "answers the caller");
});
