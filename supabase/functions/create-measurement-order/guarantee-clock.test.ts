// gh-3471 -- the 100-hour clock: stored on a real (non-test) measurement payment, never on a test order.
// Before: create-measurement-order stored no payment time and no deadline anywhere (this file's first test fails on main's index.ts).
// Run: deno test --allow-read=supabase/functions supabase/functions/create-measurement-order/guarantee-clock.test.ts
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildClockAlertRow,
  buildGuaranteeClock,
  chargeIdOf,
  type ClockDeps,
  isMissingColumnError,
  decideGuaranteeClock,
  GUARANTEE_CLOCK_ALERT_TYPE,
  GUARANTEE_HOURS,
  isInternalEmail,
  paymentSucceededAt,
  raiseClockAlert,
} from "./guarantee-clock.ts";
import { checkMeasurementPaymentIntent } from "./payment-intent-checks.ts";

const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const webhook = await Deno.readTextFile(new URL("../stripe-webhook/index.ts", import.meta.url));

const CLAIM = "66666666-7777-4888-8999-000000000000";
const OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PAID_UNIX = 1793900000; // the charge's created time = when the payment succeeded
const PAID_ISO = new Date(PAID_UNIX * 1000).toISOString();
const NOW = new Date((PAID_UNIX + 60) * 1000); // the function runs a minute AFTER the payment: start must still be the payment time

/** A succeeded hover_measurement PaymentIntent as Stripe returns it with expand[]=latest_charge. */
// deno-lint-ignore no-explicit-any
function hoverMeasurementPi(over: Record<string, any> = {}): any {
  return {
    id: "pi_3Abc123",
    status: "succeeded",
    currency: "usd",
    amount: 2263,
    livemode: true,
    created: PAID_UNIX - 90, // the PaymentIntent was created before the payment succeeded; it is NOT the start
    metadata: { type: "hover_measurement", claim_id: CLAIM },
    latest_charge: { id: "ch_3Abc123", object: "charge", status: "succeeded", paid: true, created: PAID_UNIX },
    ...over,
  };
}

function deps(over: Partial<ClockDeps> = {}): ClockDeps {
  return {
    livemode: true,
    paidAt: paymentSucceededAt(hoverMeasurementPi(), NOW),
    buyerId: OWNER,
    lookupClaim: async () => ({ is_test: false, user_id: OWNER }),
    lookupProfile: async () => ({ is_test: false, email: "homeowner@example.com" }),
    log: () => {},
    ...over,
  };
}

Deno.test("a NON-TEST hover_measurement payment: guarantee_started_at = the payment time, guarantee_deadline_at = exactly 100 hours later (and index.ts writes both on the order row)", async () => {
  const pi = hoverMeasurementPi();
  // the real post-fetch checks still pass, and still hand back the charge ID STRING for stripe_payment_id
  const forChecks = { ...pi, latest_charge: chargeIdOf(pi.latest_charge) };
  const checked = checkMeasurementPaymentIntent(forChecks, { expectedAmount: 2263, claimId: CLAIM, log: () => {} });
  assertEquals(checked, { ok: true, amount: 2263, stripeChargeId: "ch_3Abc123" });

  const decision = await decideGuaranteeClock(deps());
  assert(decision.stored, "a real payment gets a clock");
  assertEquals(decision.fields.guarantee_started_at, PAID_ISO, "start = the payment-succeeded time (the charge's created), not now, not the PI's created");
  assertEquals(decision.fields.guarantee_deadline_at, new Date(Date.parse(PAID_ISO) + 100 * 3_600_000).toISOString());
  assertEquals(Date.parse(decision.fields.guarantee_deadline_at) - Date.parse(decision.fields.guarantee_started_at), 360_000_000, "exactly 100 hours in ms");
  assertEquals(GUARANTEE_HOURS, 100);

  // wiring: the real function reads the charge time, expands it, and writes both fields in the order INSERT (fails on main's index.ts)
  assertStringIncludes(index, "expand%5B%5D=latest_charge");
  assertStringIncludes(index, "paymentSucceededAt(pi)");
  assertStringIncludes(index, "decideGuaranteeClock({");
  assertStringIncludes(index, "...(paidRole === \"contractor\" ? {} : clock.fields)");
  assertStringIncludes(index, ".insert(orderPayload)");
});

Deno.test("NEGATIVE CONTROL: the same payment on an is_test order gets neither field (claim flag, owner flag, buyer flag, staff e-mail, Stripe test mode)", async () => {
  const none = async (d: ClockDeps) => {
    const r = await decideGuaranteeClock(d);
    assertFalse(r.stored);
    assertEquals(Object.keys(r.fields), [], "no guarantee_started_at and no guarantee_deadline_at");
    assertEquals((r as { reason: string }).reason, "is_test");
  };
  await none(deps({ lookupClaim: async () => ({ is_test: true, user_id: OWNER }) }));
  await none(deps({ lookupProfile: async (id) => (id === OWNER ? { is_test: true, email: "x@example.com" } : null) }));
  await none(deps({ buyerId: "buyer-2", lookupClaim: async () => ({ is_test: false, user_id: "someone-else" }), lookupProfile: async (id) => (id === "buyer-2" ? { is_test: true } : { is_test: false }) }));
  await none(deps({ lookupProfile: async () => ({ is_test: false, email: "Dustin@StellarEdgeServices.com" }) }));
  await none(deps({ lookupProfile: async () => ({ is_test: false, email: "dustinstohler1+t3@gmail.com" }) }));
  await none(deps({ lookupProfile: async () => ({ is_test: false, email: "staff@example.com" }), dbSaysInternal: async (e) => e === "staff@example.com" }));
  await none(deps({ livemode: false }));
  // the paired positive: everything else identical, none of the flags -> a clock
  assert((await decideGuaranteeClock(deps())).stored);
});

Deno.test("a failed lookup is treated as REAL: a customer never loses a clock because a read failed", async () => {
  const logs: string[] = [];
  const r = await decideGuaranteeClock(deps({
    lookupClaim: () => { throw new Error("db down"); },
    lookupProfile: () => { throw new Error("db down"); },
    dbSaysInternal: () => { throw new Error("rpc missing"); },
    log: (m) => logs.push(m),
  }));
  assert(r.stored);
  assert(logs.length >= 1);
  assertEquals((await decideGuaranteeClock(deps({ lookupClaim: async () => null, lookupProfile: async () => null }))).stored, true);
});

Deno.test("payment time: only a succeeded, paid charge's created time counts; anything else yields no clock (never invented)", async () => {
  assertEquals(paymentSucceededAt(hoverMeasurementPi(), NOW)?.toISOString(), PAID_ISO);
  const bad = [
    hoverMeasurementPi({ latest_charge: "ch_3Abc123" }), // not expanded
    hoverMeasurementPi({ latest_charge: null }),
    hoverMeasurementPi({ latest_charge: { id: "ch_1", status: "pending", paid: false, created: PAID_UNIX } }),
    hoverMeasurementPi({ latest_charge: { id: "ch_1", status: "succeeded", paid: true } }), // no created
    hoverMeasurementPi({ latest_charge: { id: "ch_1", status: "succeeded", paid: true, created: 0 } }),
    hoverMeasurementPi({ latest_charge: { id: "ch_1", status: "succeeded", paid: true, created: "1793900000" } }),
    hoverMeasurementPi({ latest_charge: { id: "ch_1", status: "succeeded", paid: true, created: PAID_UNIX + 86400 } }), // a day in the future
    hoverMeasurementPi({ status: "requires_payment_method" }),
  ];
  for (const pi of bad) assertEquals(paymentSucceededAt(pi, NOW), null);
  const none = await decideGuaranteeClock(deps({ paidAt: null }));
  assertFalse(none.stored);
  assertEquals(Object.keys(none.fields), []);
  assertEquals((none as { reason: string }).reason, "no_payment_time");
});

Deno.test("the deadline is +100 elapsed hours across a daylight-saving change, not +4 calendar days", () => {
  const fall = buildGuaranteeClock(new Date("2026-11-01T04:30:00.000Z")); // the night US clocks fall back
  assertEquals(fall.guarantee_started_at, "2026-11-01T04:30:00.000Z");
  assertEquals(fall.guarantee_deadline_at, "2026-11-05T08:30:00.000Z");
  const spring = buildGuaranteeClock(new Date("2027-03-13T12:00:00.000Z"));
  assertEquals(spring.guarantee_deadline_at, "2027-03-17T16:00:00.000Z");
});

Deno.test("chargeIdOf and isInternalEmail", () => {
  assertEquals(chargeIdOf("ch_1"), "ch_1");
  assertEquals(chargeIdOf({ id: "ch_2" }), "ch_2");
  assertEquals(chargeIdOf(null), null);
  assertEquals(chargeIdOf({}), null);
  for (const e of ["a@otterquote.com", "a@stellaredgeservices.com", "a@tryotterquote.com", "a@stohlerroof.com", "a@otterquote-internal.test", "DustinStohler1+x@Gmail.com"]) assert(isInternalEmail(e), e);
  for (const e of ["a@example.com", "a@gmail.com", "otterquote.com@example.com", "a@nototterquote.com", "", null, undefined, "no-at-sign"]) assertFalse(isInternalEmail(e as string), String(e));
});

Deno.test("alert row: validated shapes only; hostile text never echoed; a failing insert never throws", async () => {
  const r = buildClockAlertRow({ reason: "no_payment_time", orderId: "11111111-2222-4333-8444-555555555555", paymentIntentId: "pi_3Abc123", claimId: CLAIM }, () => new Date("2026-11-05T12:00:00Z"));
  assertEquals(r.alert_type, GUARANTEE_CLOCK_ALERT_TYPE);
  assertEquals(r.sent_at, "2026-11-05T12:00:00.000Z");
  for (const s of ["11111111-2222-4333-8444-555555555555", "pi_3Abc123", CLAIM, "Stripe did not show when the payment succeeded"]) assertStringIncludes(r.message, s);
  const hostile = buildClockAlertRow({ reason: "column_missing", orderId: "x\n<script>", paymentIntentId: "pi_x<b>", claimId: "'; DROP" });
  assert(!hostile.message.includes("<") && !hostile.message.includes("DROP") && !hostile.message.includes("\n"));
  assertStringIncludes(hostile.message, "order none");
  const rows: unknown[] = []; const logs: string[] = [];
  await raiseClockAlert(async (x) => { rows.push(x); return { error: null }; }, (m) => logs.push(m), r);
  await raiseClockAlert(async () => ({ error: { message: "x" } }), (m) => logs.push(m), r);
  await raiseClockAlert(() => { throw new Error("boom"); }, () => { throw new Error("log boom"); }, r);
  assertEquals(rows.length, 1); assertEquals(logs.length, 1);
});

Deno.test("scope: stripe-webhook is untouched; the buyer's responses carry no guarantee wording; a missing column cannot lose a paid order", () => {
  assertFalse(/guarantee/i.test(webhook), "stripe-webhook has no clock code");
  // every string the function SENDS (json bodies, error text) is free of guarantee wording
  const sent = index.split("\n").filter((l) => /(error:|json\()/.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  assertFalse(/guarantee|100[- ]hour/i.test(sent), "no customer-visible wording");
  // the retry itself is exercised against the real handler in guarantee-clock-handler.test.ts (PGRST204 and 42703); here only that it uses the shared matcher
  assertStringIncludes(index, "isMissingColumnError(insErr)");
  // only the generic paid path writes the clock: the contractor upgrade branch and quote-only requests do not
  assertEquals(index.split("guarantee_started_at").length - 1, 2, "named only in the paid-path retry check (and its destructure)");
});

Deno.test("isMissingColumnError: matches PostgREST PGRST204 and Postgres 42703 by CODE, not by message; nothing else", () => {
  assert(isMissingColumnError({ code: "PGRST204", message: "anything at all" }));
  assert(isMissingColumnError({ code: "42703", message: "" }));
  assert(isMissingColumnError({ code: "42703" }));
  for (const e of [null, undefined, {}, { code: "23505" }, { code: "PGRST116" }, { code: "42P01" }, { message: "column does not exist" }, "42703"]) assertFalse(isMissingColumnError(e), String(e));
});
