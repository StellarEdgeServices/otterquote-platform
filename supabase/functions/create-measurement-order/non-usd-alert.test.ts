// gh-2107 / D-330 -- Ben's DECIDED (b) on #2078 (5806894411), REVIEW B2 / LEGAL-READ L2 on #2138: "A rejected non-USD payment raises an
// admin alert. It uses the existing admin email path, in the same PR, not only a server log. Refunds stay manual (Tier C)."
// A buyer whose PaymentIntent is in another currency has PAID and got no report (create-measurement-order returns 402). Somebody has to
// know, so the operator is emailed (through notify-measurement-order's Mailgun path) and a platform_alerts_log row is written. Neither
// may ever break or change the 402, neither carries an email address or raw Stripe text, and a client retry does not re-alert.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  NON_USD_ALERT_TYPE,
  buildNonUsdAlertRow,
  raiseNonUsdPaymentAlert,
  type NonUsdAlertDeps,
} from "./non-usd-alert.ts";
import { checkMeasurementPaymentIntent, checkUpgradePaymentIntent, type NonUsdRejection } from "./payment-intent-checks.ts";

const CLAIM = "11111111-2222-4333-8444-555555555555";
const NOW = () => new Date("2026-09-24T12:00:00.000Z");
const N: NonUsdRejection = { paymentIntentId: "pi_3Abc123", currency: "jpy", amountCents: 1500 };

function deps(over: Partial<NonUsdAlertDeps> = {}) {
  const rows: Record<string, unknown>[] = [];
  const emails: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const d: NonUsdAlertDeps = {
    alreadyAlerted: async () => false,
    insertAlert: async (row) => { rows.push(row as unknown as Record<string, unknown>); return { error: null }; },
    sendAdminEmail: async (body) => { emails.push(body as unknown as Record<string, unknown>); },
    log: (m) => logs.push(m),
    ...over,
  };
  return { d, rows, emails, logs };
}

// -- the checks report WHAT to alert about, without changing what the client sees --------------------------
Deno.test("checks: a non-usd rejection carries nonUsd (PaymentIntent id, currency, amount) for BOTH the report and the upgrade flow", () => {
  const pi = { id: "pi_3Abc123", status: "succeeded", currency: "jpy", amount: 1500, metadata: { claim_id: CLAIM, type: "measurement_order" } };
  const r = checkMeasurementPaymentIntent(pi, { expectedAmount: 1500, claimId: CLAIM, log: () => {} });
  assert(!r.ok && r.status === 402);
  if (!r.ok) assertEquals(r.nonUsd, N);
  const u = checkUpgradePaymentIntent({ ...pi, amount: 2500, metadata: { claim_id: CLAIM, type: "measurement_upgrade" } }, { claimId: CLAIM, log: () => {} });
  assert(!u.ok);
  if (!u.ok) assertEquals(u.nonUsd, { paymentIntentId: "pi_3Abc123", currency: "jpy", amountCents: 2500 });
});

Deno.test("checks: NEGATIVE CONTROL -- a usd PaymentIntent has no nonUsd and an unrelated rejection (wrong amount) carries none", () => {
  const good = { id: "pi_1", status: "succeeded", currency: "usd", amount: 1500, metadata: { claim_id: CLAIM, type: "measurement_order" } };
  const r = checkMeasurementPaymentIntent(good, { expectedAmount: 1500, claimId: CLAIM, log: () => {} });
  assert(r.ok);
  const wrongAmount = checkMeasurementPaymentIntent({ ...good, amount: 1400 }, { expectedAmount: 1500, claimId: CLAIM, log: () => {} });
  assert(!wrongAmount.ok && !("nonUsd" in wrongAmount && wrongAmount.nonUsd), "a wrong amount is not a currency alert");
  const notSucceeded = checkMeasurementPaymentIntent({ ...good, currency: "jpy", status: "requires_payment_method" }, { expectedAmount: 1500, claimId: CLAIM, log: () => {} });
  assert(!notSucceeded.ok && !("nonUsd" in notSucceeded && notSucceeded.nonUsd), "an unpaid PaymentIntent is not a paid-in-another-currency case");
});

Deno.test("checks: the id, currency and amount are validated shapes, never raw text (a hostile value becomes null)", () => {
  const evil = { id: "pi_x\n<script>", status: "succeeded", currency: "JPY<b>", amount: "1500; DROP", metadata: {} };
  const r = checkMeasurementPaymentIntent(evil, { expectedAmount: 1500, claimId: null, log: () => {} });
  assert(!r.ok);
  if (!r.ok) assertEquals(r.nonUsd, { paymentIntentId: null, currency: null, amountCents: null });
  const missing = checkMeasurementPaymentIntent({ status: "succeeded", metadata: {} }, { expectedAmount: 1500, claimId: null, log: () => {} });
  assert(!missing.ok);
  if (!missing.ok) assertEquals(missing.nonUsd, { paymentIntentId: null, currency: null, amountCents: null });
});

// -- the row ----------------------------------------------------------------------------------------------------
Deno.test("row: platform_alerts_log row names the flow, PaymentIntent, currency and amount, and says the refund is a manual decision", () => {
  const row = buildNonUsdAlertRow(N, "report", NOW);
  assertEquals(row.alert_type, NON_USD_ALERT_TYPE);
  assertEquals(row.alert_type, "non_usd_payment_rejected");
  assertEquals(row.function_name, "create-measurement-order");
  assertEquals(row.sent_at, "2026-09-24T12:00:00.000Z");
  for (const part of ["report", "pi_3Abc123", "jpy", "1500", "manual"]) assert(row.message.includes(part), `message has ${part}: ${row.message}`);
});

Deno.test("row: an unrecognized PaymentIntent / currency / amount is stated as unrecognized, never echoed", () => {
  const row = buildNonUsdAlertRow({ paymentIntentId: null, currency: null, amountCents: null }, "upgrade", NOW);
  assert(row.message.includes("unrecognized") && row.message.includes("upgrade"));
});

Deno.test("row: it carries no email address and no line break (nothing personal, nothing raw)", () => {
  const row = buildNonUsdAlertRow(N, "report", NOW);
  assert(!row.message.includes("@") && !/[\r\n]/.test(row.message));
});

// -- raising it ----------------------------------------------------------------------------------------------------
Deno.test("raise: writes the alert row AND sends the admin email, once each, with the validated fields only", async () => {
  const { d, rows, emails } = deps();
  await raiseNonUsdPaymentAlert(d, N, "report", NOW);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].alert_type, "non_usd_payment_rejected");
  assertEquals(emails, [{ alert: "non_usd_payment_rejected", flow: "report", payment_intent_id: "pi_3Abc123", currency: "jpy", amount_minor: 1500 }]);
});

Deno.test("raise: a repeat for a PaymentIntent already alerted (a client retry) sends nothing and writes nothing", async () => {
  const { d, rows, emails } = deps({ alreadyAlerted: async () => true });
  await raiseNonUsdPaymentAlert(d, N, "report", NOW);
  assertEquals(rows.length, 0);
  assertEquals(emails.length, 0);
});

Deno.test("raise: the dedupe lookup is keyed on the PaymentIntent id", async () => {
  const seen: string[] = [];
  const { d } = deps({ alreadyAlerted: async (pi) => { seen.push(pi); return false; } });
  await raiseNonUsdPaymentAlert(d, N, "report", NOW);
  assertEquals(seen, ["pi_3Abc123"]);
});

Deno.test("raise: a failed dedupe lookup still alerts (fail toward telling the operator)", async () => {
  const { d, rows, emails } = deps({ alreadyAlerted: async () => { throw new Error("db down"); } });
  await raiseNonUsdPaymentAlert(d, N, "report", NOW);
  assertEquals(rows.length, 1);
  assertEquals(emails.length, 1);
});

Deno.test("raise: with no recognizable PaymentIntent id it still alerts, and skips the dedupe lookup", async () => {
  let looked = false;
  const { d, rows, emails } = deps({ alreadyAlerted: async () => { looked = true; return true; } });
  await raiseNonUsdPaymentAlert(d, { paymentIntentId: null, currency: null, amountCents: null }, "report", NOW);
  assertEquals(looked, false);
  assertEquals(rows.length, 1);
  assertEquals(emails.length, 1);
});

Deno.test("raise: it NEVER throws -- the row insert failing (throw or error result) and the email failing are each contained", async () => {
  for (const over of [
    { insertAlert: async () => { throw new Error("SECRET row failure text"); } },
    { insertAlert: async () => ({ error: { message: "SECRET row error text" } }) },
    { sendAdminEmail: async () => { throw new Error("SECRET mail failure text"); } },
  ] as Partial<NonUsdAlertDeps>[]) {
    const { d, logs } = deps(over);
    await raiseNonUsdPaymentAlert(d, N, "report", NOW); // must not throw
    assert(logs.length >= 1, "the failure is logged");
    for (const l of logs) assert(!l.includes("SECRET"), "no raw error text is logged: " + l);
  }
});

Deno.test("raise: it never throws even if the logger itself throws (a 402 must never become a 500)", async () => {
  const { d } = deps({
    insertAlert: async () => { throw new Error("x"); },
    sendAdminEmail: async () => { throw new Error("y"); },
    log: () => { throw new Error("logger down"); },
  });
  await raiseNonUsdPaymentAlert(d, N, "report", NOW); // must not throw
  const { d: d2 } = deps({ alreadyAlerted: async () => { throw new Error("z"); }, log: () => { throw new Error("logger down"); } , insertAlert: () => { throw new Error("sync throw"); } });
  await raiseNonUsdPaymentAlert(d2, N, "upgrade", NOW);
});

Deno.test("raise: one channel failing does not stop the other (the email still goes when the row fails, and the row is written when the email fails)", async () => {
  const a = deps({ insertAlert: async () => { throw new Error("x"); } });
  await raiseNonUsdPaymentAlert(a.d, N, "report", NOW);
  assertEquals(a.emails.length, 1);
  const b = deps({ sendAdminEmail: async () => { throw new Error("y"); } });
  await raiseNonUsdPaymentAlert(b.d, N, "report", NOW);
  assertEquals(b.rows.length, 1);
});

Deno.test("raise: log lines carry no email, no currency and no amount (fixed text and the PaymentIntent id at most)", async () => {
  const { d, logs } = deps({ insertAlert: async () => { throw new Error("x"); }, sendAdminEmail: async () => { throw new Error("y"); } });
  await raiseNonUsdPaymentAlert(d, N, "report", NOW);
  for (const l of logs) assert(!l.includes("@") && !/jpy|1500/.test(l), l);
});

// -- structure: wired at both call sites, awaited, after the verify, before the 402 is returned; the 402 is unchanged ----------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("index.ts: BOTH verifies (report and upgrade) raise the alert, awaited, before returning the 402", () => {
  assertEquals(index.split("raiseNonUsdPaymentAlert(").length - 1, 2);
  for (const [verify, flow] of [["const paidUpgrade = await verifyUpgradePayment(", '"upgrade"'], ["const paid = await verifyPayment(", '"report"']] as const) {
    const at = index.indexOf(verify);
    assert(at > 0, verify);
    const region = index.slice(at, at + 900);
    const alertAt = region.indexOf("await raiseNonUsdPaymentAlert(");
    const returnAt = region.indexOf("return json({ error:");
    assert(alertAt > 0 && returnAt > alertAt, "the alert is awaited BEFORE the 402 is returned: " + verify);
    assert(region.slice(alertAt, alertAt + 260).includes(flow), "flow " + flow);
    assert(/\.nonUsd\b/.test(region.slice(0, returnAt)), "gated on the check's nonUsd");
  }
});

Deno.test("index.ts: the 402 status and message returned to the client are unchanged (the alert never alters the response)", () => {
  assert(index.includes("return json({ error: paid.error }, paid.status, corsHeaders);"));
  assert(index.includes("return json({ error: paidUpgrade.error }, paidUpgrade.status, corsHeaders);"));
});

Deno.test("index.ts: the admin email goes through notify-measurement-order (service-role bearer), the existing admin email path", () => {
  const at = index.indexOf("sendAdminEmail");
  assert(at > 0);
  const region = index.slice(at, at + 900);
  assert(region.includes("/functions/v1/notify-measurement-order") && region.includes("SUPABASE_SERVICE_ROLE_KEY"));
});

Deno.test("index.ts: the alert insert is platform_alerts_log, and the dedupe reads it by alert_type + PaymentIntent id", () => {
  assert(index.includes('.from("platform_alerts_log")'));
  const at = index.indexOf("alreadyAlerted");
  assert(at > 0);
  const region = index.slice(at, at + 700);
  assert(region.includes("NON_USD_ALERT_TYPE") && /ilike|like/.test(region));
});

// -- parity with the receiving function (its own copy of the contract: the EF deploy path does not resolve shared imports) ---------------
const notify = await Deno.readTextFile(new URL("../notify-measurement-order/non-usd-alert-email.ts", import.meta.url));

Deno.test("parity: notify-measurement-order's alert module uses the same alert token and the same body keys", () => {
  assert(notify.includes('"non_usd_payment_rejected"'));
  for (const key of ["flow", "payment_intent_id", "currency", "amount_minor"]) assert(notify.includes(key), key);
});
