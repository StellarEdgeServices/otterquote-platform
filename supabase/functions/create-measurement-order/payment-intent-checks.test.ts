// gh-2107 / D-330 -- the USD guard on create-measurement-order (Ben's step 2 on #2078, 5806312169): "create-measurement-order
// rejects any PaymentIntent whose currency !== 'usd'. Include a failing-first test and a negative control. This is the R-177 path."
//
// WHY. REVIEW 5805884795 (N1) on #2107: create-payment-intent does not pin `currency` for hover_measurement (it only checks that it
// is a string and passes it to Stripe), and create-measurement-order checks the AMOUNT of a succeeded PaymentIntent but not its
// CURRENCY. A hand-crafted request can create amount=1500, currency=jpy (about 1500 yen, roughly $10) and it would be accepted as a
// paid $15 report, and reported to Meta as 15 USD. Pre-existing money-path gap, not introduced by any recent PR.
//
// The post-fetch checks of verifyPayment / verifyUpgradePayment moved verbatim into a pure module so they can be tested with
// PaymentIntent objects; the differential test at the bottom compares the module with a literal copy of main's checks, so nothing
// else about payment verification changed.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  checkMeasurementPaymentIntent,
  checkUpgradePaymentIntent,
  CURRENCY_REJECTION_MESSAGE,
  type PaymentCheckResult,
} from "./payment-intent-checks.ts";

const CLAIM = "c0ffee00-0000-4000-8000-000000000001";
// deno-lint-ignore no-explicit-any
function pi(over: Record<string, any> = {}): any {
  return { id: "pi_123", status: "succeeded", amount: 1500, currency: "usd", latest_charge: "ch_1", metadata: { claim_id: CLAIM, type: "hover_measurement" }, ...over };
}
const ok = (r: { ok: boolean }) => r.ok === true;

// -- the guard, failing-first -----------------------------------------------------------------------
Deno.test("USD guard: a succeeded PaymentIntent in ANY other currency is rejected (402), for the report purchase", () => {
  for (const currency of ["jpy", "eur", "gbp", "cad", "mxn", "inr", "USD", "usd ", "", "usdt"]) {
    const r = checkMeasurementPaymentIntent(pi({ currency }), { expectedAmount: 1500, claimId: CLAIM });
    assertEquals(ok(r), false, `currency ${JSON.stringify(currency)} must be rejected`);
    if (!r.ok) {
      assertEquals(r.status, 402);
      assertEquals(r.error, CURRENCY_REJECTION_MESSAGE);
    }
  }
});

Deno.test("USD guard: a missing or non-string currency is rejected too (fail closed)", () => {
  for (const currency of [undefined, null, 840, {}, ["usd"]]) {
    const r = checkMeasurementPaymentIntent(pi({ currency }), { expectedAmount: 1500, claimId: CLAIM });
    assertEquals(ok(r), false, JSON.stringify(currency));
  }
  const noField = pi();
  delete noField.currency;
  assertEquals(ok(checkMeasurementPaymentIntent(noField, { expectedAmount: 1500, claimId: CLAIM })), false);
});

Deno.test("USD guard: the upgrade purchase (contractor detailed measurement) is guarded the same way", () => {
  const up = (over = {}) => pi({ amount: 2500, metadata: { claim_id: CLAIM, type: "measurement_upgrade" }, ...over });
  assertEquals(ok(checkUpgradePaymentIntent(up(), { claimId: CLAIM })), true, "CONTROL: usd passes");
  for (const currency of ["jpy", "eur", "USD", undefined]) {
    const r = checkUpgradePaymentIntent(up({ currency }), { claimId: CLAIM });
    assertEquals(ok(r), false, String(currency));
    if (!r.ok) { assertEquals(r.status, 402); assertEquals(r.error, CURRENCY_REJECTION_MESSAGE); }
  }
});

Deno.test("USD guard: it fires before the amount check, so a same-numbered foreign-currency payment cannot pass as the right price", () => {
  // 1500 yen is about $10; amount === expectedAmount === 1500, so ONLY the currency check can stop it.
  const r = checkMeasurementPaymentIntent(pi({ currency: "jpy", amount: 1500 }), { expectedAmount: 1500, claimId: CLAIM });
  assertEquals(ok(r), false);
  if (!r.ok) assertEquals(r.error, CURRENCY_REJECTION_MESSAGE);
});

Deno.test("NEGATIVE CONTROL: the same PaymentIntent in usd is ACCEPTED, so the rejection above is the currency and nothing else", () => {
  const good = checkMeasurementPaymentIntent(pi(), { expectedAmount: 1500, claimId: CLAIM });
  assertEquals(ok(good), true);
  if (good.ok) { assertEquals(good.amount, 1500); assertEquals(good.stripeChargeId, "ch_1"); }
  const bad = checkMeasurementPaymentIntent(pi({ currency: "jpy" }), { expectedAmount: 1500, claimId: CLAIM });
  assertEquals(ok(bad), false);
});

Deno.test("USD guard: the rejection message names no amount, currency or PaymentIntent (nothing echoed to the client)", () => {
  assert(!/jpy|eur|usd|pi_|\d/.test(CURRENCY_REJECTION_MESSAGE), CURRENCY_REJECTION_MESSAGE);
});

// -- nothing else changed: differential against a literal copy of main's checks ------------------------
// REFERENCE: main's create-measurement-order verifyPayment / verifyUpgradePayment post-fetch checks, verbatim (7982f54f).
// deno-lint-ignore no-explicit-any
function mainMeasurement(p: any, expectedAmount: number, claimId: string | null): PaymentCheckResult {
  if (p.status !== "succeeded") return { ok: false, status: 402, error: `Payment must complete before we can order your report. Current payment status: ${p.status}.` };
  if (p.amount !== expectedAmount) return { ok: false, status: 402, error: "Payment amount does not match the report price. Please contact support." };
  if (claimId && p.metadata?.claim_id && p.metadata.claim_id !== claimId) return { ok: false, status: 402, error: "Payment does not belong to this project. Please contact support." };
  if (p.metadata?.type && p.metadata.type !== "measurement_order" && p.metadata.type !== "hover_measurement") return { ok: false, status: 402, error: "Payment is not a measurement charge. Please contact support." };
  return { ok: true, amount: p.amount, stripeChargeId: p.latest_charge ?? null };
}
// deno-lint-ignore no-explicit-any
function mainUpgrade(p: any, claimId: string): PaymentCheckResult {
  if (p.status !== "succeeded") return { ok: false, status: 402, error: `Payment must complete before we can order your report. Current payment status: ${p.status}.` };
  if (p.metadata?.claim_id && p.metadata.claim_id !== claimId) return { ok: false, status: 402, error: "Payment does not belong to this project. Please contact support." };
  if (p.metadata?.type !== "measurement_upgrade") return { ok: false, status: 402, error: "Payment is not a measurement-upgrade charge. Please contact support." };
  return { ok: true, amount: p.amount, stripeChargeId: p.latest_charge ?? null };
}

Deno.test("THE DEFECT, demonstrated: main's checks (the reference above) ACCEPT a succeeded 1500 jpy PaymentIntent as the paid $15 report", () => {
  const r = mainMeasurement(pi({ currency: "jpy" }), 1500, CLAIM);
  assertEquals(r.ok, true, "this is the pre-fix behaviour the USD guard closes");
  assertEquals(mainUpgrade(pi({ currency: "jpy", amount: 2500, metadata: { claim_id: CLAIM, type: "measurement_upgrade" } }), CLAIM).ok, true);
  // ...and the module refuses both
  assertEquals(checkMeasurementPaymentIntent(pi({ currency: "jpy" }), { expectedAmount: 1500, claimId: CLAIM }).ok, false);
  assertEquals(checkUpgradePaymentIntent(pi({ currency: "jpy", amount: 2500, metadata: { claim_id: CLAIM, type: "measurement_upgrade" } }), { claimId: CLAIM }).ok, false);
});

Deno.test("differential (report): for a usd PaymentIntent the module returns exactly what main's checks returned, across status, amount, claim and type", () => {
  let n = 0;
  for (const status of ["succeeded", "processing", "requires_payment_method", "canceled"])
    for (const amount of [1500, 1499, 0, 2500])
      for (const mdClaim of [CLAIM, "other", undefined])
        for (const type of ["hover_measurement", "measurement_order", "platform_fee", "measurement_upgrade", undefined])
          for (const claimId of [CLAIM, null]) {
            const p = pi({ status, amount, metadata: { claim_id: mdClaim, type } });
            assertEquals(checkMeasurementPaymentIntent(p, { expectedAmount: 1500, claimId }), mainMeasurement(p, 1500, claimId), JSON.stringify({ status, amount, mdClaim, type, claimId }));
            n++;
          }
  assert(n === 4 * 4 * 3 * 5 * 2, String(n));
});

Deno.test("differential (upgrade): for a usd PaymentIntent the module returns exactly what main's checks returned", () => {
  for (const status of ["succeeded", "processing"])
    for (const mdClaim of [CLAIM, "other", undefined])
      for (const type of ["measurement_upgrade", "hover_measurement", undefined]) {
        const p = pi({ status, amount: 2500, metadata: { claim_id: mdClaim, type } });
        assertEquals(checkUpgradePaymentIntent(p, { claimId: CLAIM }), mainUpgrade(p, CLAIM), JSON.stringify({ status, mdClaim, type }));
      }
});

Deno.test("a non-usd PaymentIntent that is ALSO not succeeded still reports the status first (the buyer is told to finish paying), then the currency once it has", () => {
  const r = checkMeasurementPaymentIntent(pi({ currency: "jpy", status: "processing" }), { expectedAmount: 1500, claimId: CLAIM });
  assertEquals(ok(r), false);
  if (!r.ok) assert(r.error.includes("Current payment status: processing"));
});

// -- index.ts uses the module in BOTH verifiers --------------------------------------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("index.ts: verifyPayment and verifyUpgradePayment both delegate their post-fetch checks to the module (no inline copy left to drift)", () => {
  assert(index.includes('from "./payment-intent-checks.ts"'));
  assertEquals(index.split("checkMeasurementPaymentIntent(").length - 1, 1);
  assertEquals(index.split("checkUpgradePaymentIntent(").length - 1, 1);
  assert(!index.includes("Payment amount does not match the report price"), "the inline amount check is gone from index.ts");
  assert(!index.includes("Payment is not a measurement-upgrade charge"), "the inline upgrade type check is gone from index.ts");
});

Deno.test("index.ts: the PaymentIntent is fetched from Stripe (never trusted from the request) before the checks run", () => {
  const a = index.indexOf("checkMeasurementPaymentIntent(");
  const fetchAt = index.lastIndexOf("/payment_intents/${encodeURIComponent(paymentIntentId)}", a);
  assert(fetchAt > 0 && fetchAt < a);
});
