// gh-2107 / D-330 -- Ben's DECIDED (a) on #2078 (5806894411), and REVIEW B1 / LEGAL-READ L1 on #2138: the CAPI Purchase is sent to Meta as
// 15 USD, so it must be skipped for any measurement PaymentIntent that is not EXACTLY 1500 cents in USD. create-measurement-order now
// refuses a non-USD PaymentIntent, but the webhook sees the PaymentIntent first and independently; it must not report a charge in another
// currency (or at another amount) to Meta as a USD Purchase. Protective, fail closed: a missing or malformed currency/amount is skipped.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MEASUREMENT_PURCHASE_AMOUNT_CENTS, shouldSkipForNonUsdMeasurement } from "./meta-capi.ts";

const pi = (over: Record<string, unknown> = {}) => ({ currency: "usd", amount: 1500, amount_received: 1500, ...over });

// -- the decision -----------------------------------------------------------------------------
Deno.test("usd: the price constant is 1500 cents", () => {
  assertEquals(MEASUREMENT_PURCHASE_AMOUNT_CENTS, 1500);
});

Deno.test("usd: NEGATIVE CONTROL -- usd / 1500 / 1500 is sent (not skipped)", () => {
  assertEquals(shouldSkipForNonUsdMeasurement(pi()), { skip: false, reason: null });
});

Deno.test("usd: amount_received absent falls back to amount 1500 in usd and is sent", () => {
  assertEquals(shouldSkipForNonUsdMeasurement(pi({ amount_received: undefined })), { skip: false, reason: null });
});

Deno.test("usd: a non-USD currency at 1500 is skipped (the reported jpy case)", () => {
  for (const currency of ["jpy", "eur", "cad", "gbp", "USD", "usd ", "", null, undefined, 1500]) {
    assertEquals(
      shouldSkipForNonUsdMeasurement(pi({ currency })),
      { skip: true, reason: "not_usd_1500" },
      `currency ${JSON.stringify(currency)} must be skipped`,
    );
  }
});

Deno.test("usd: a USD charge at any other amount is skipped", () => {
  for (const amount of [1499, 1501, 100, 15, 0, 2500, -1500, 1500.5, NaN, "1500", null, undefined]) {
    assertEquals(
      shouldSkipForNonUsdMeasurement(pi({ amount, amount_received: amount })),
      { skip: true, reason: "not_usd_1500" },
      `amount ${JSON.stringify(amount)} must be skipped`,
    );
  }
});

Deno.test("usd: amount_received wins over amount when present (what was actually charged)", () => {
  assertEquals(shouldSkipForNonUsdMeasurement(pi({ amount: 1500, amount_received: 1000 })), { skip: true, reason: "not_usd_1500" });
  assertEquals(shouldSkipForNonUsdMeasurement(pi({ amount: 1000, amount_received: 1500 })), { skip: false, reason: null });
});

Deno.test("usd: a missing / non-object PaymentIntent is skipped (fail closed)", () => {
  for (const v of [null, undefined, {}, "usd", 1500]) {
    assertEquals(shouldSkipForNonUsdMeasurement(v as never), { skip: true, reason: "not_usd_1500" });
  }
});

// -- structure: wired into the handler before the payload is built ------------------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const start = index.indexOf("async function handleMeasurementOrderCapiPurchase(");
const end = index.indexOf("// Entry point", start);
const handler = index.slice(start, end);

Deno.test("index.ts: the handler calls shouldSkipForNonUsdMeasurement exactly once, with the PaymentIntent, and returns when it skips", () => {
  assert(start > 0 && end > start);
  assertEquals(handler.split("shouldSkipForNonUsdMeasurement(").length - 1, 1);
  const callAt = handler.indexOf("shouldSkipForNonUsdMeasurement(");
  const call = handler.slice(callAt, handler.indexOf(");", callAt) + 2);
  assert(/shouldSkipForNonUsdMeasurement\(paymentIntent\)/.test(call), "passes the PaymentIntent: " + call);
  const branch = handler.slice(callAt, callAt + 500);
  assert(/if \(nonUsd\.skip\)/.test(branch) && branch.slice(0, branch.indexOf("return;") + 7).includes("return;"), "returns when skipping");
});

Deno.test("index.ts: the amount/currency check comes BEFORE anything is resolved, hashed, built or sent", () => {
  const checkAt = handler.indexOf("shouldSkipForNonUsdMeasurement(");
  for (const later of [
    '.from("claims")',
    '.from("profiles")',
    "hashEmailSha256(rawEmail)",
    '.from("ad_sharing_suppressions")',
    "buildCapiPurchasePayload(",
    "graph.facebook.com",
  ]) {
    const at = handler.indexOf(later);
    assert(at > checkAt, `${later} must come after the amount/currency check`);
  }
});

Deno.test("index.ts: the skip log carries the PaymentIntent id and a fixed reason only (no currency value, amount, email or digest)", () => {
  const callAt = handler.indexOf("shouldSkipForNonUsdMeasurement(");
  const block = handler.slice(callAt, handler.indexOf("return;", callAt));
  assert(block.includes("paymentIntent.id") && block.includes("nonUsd.reason"));
  assert(!/paymentIntent\.(currency|amount)/.test(block), "the log does not echo the currency or amount");
});
