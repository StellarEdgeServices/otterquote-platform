// deno test --allow-read=. supabase/functions/create-lead-measurement-order/handler.test.ts
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { checkLeadPaymentIntent, handleRequest, validateBody, type Deps } from "./handler.ts";

const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GOOD_TOKEN = "a".repeat(32);
const PI_ID = "pi_abcdef123456";

function req(body: unknown): Request {
  return new Request("https://x/functions/v1/create-lead-measurement-order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    resolveLead: (token) => Promise.resolve(token === GOOD_TOKEN ? { leadId: LEAD_ID } : null),
    readPriceCents: () => Promise.resolve({ row: { value: 1500 }, error: null }),
    findExistingOrder: () => Promise.resolve(null),
    fetchPaymentIntent: () =>
      Promise.resolve({
        status: "succeeded",
        currency: "usd",
        amount: 1500,
        latest_charge: "ch_123",
        metadata: { lead_id: LEAD_ID, type: "lead_measurement_order" },
      }),
    insertOrder: () => Promise.resolve({ id: "order_1", status: "awaiting_fulfillment" }),
    checkRateLimit: () => Promise.resolve({ allowed: true }),
    notifyOrderCreated: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("validateBody requires a well-formed payment_intent_id", () => {
  assertEquals(validateBody({ lead_token: GOOD_TOKEN, payment_intent_id: "not-a-pi" }).ok, false);
  assertEquals(validateBody({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }).ok, true);
});

Deno.test("checkLeadPaymentIntent rejects a PI whose lead_id metadata does not match", () => {
  const res = checkLeadPaymentIntent(
    { status: "succeeded", currency: "usd", amount: 1500, metadata: { lead_id: "someone-else", type: "lead_measurement_order" } },
    { expectedAmount: 1500, leadId: LEAD_ID },
  );
  assertEquals(res.ok, false);
});

Deno.test("checkLeadPaymentIntent rejects a non-usd currency even at the right amount", () => {
  const res = checkLeadPaymentIntent(
    { status: "succeeded", currency: "jpy", amount: 1500, metadata: { lead_id: LEAD_ID, type: "lead_measurement_order" } },
    { expectedAmount: 1500, leadId: LEAD_ID },
  );
  assertEquals(res.ok, false);
});

Deno.test("checkLeadPaymentIntent rejects an amount mismatch", () => {
  const res = checkLeadPaymentIntent(
    { status: "succeeded", currency: "usd", amount: 100, metadata: { lead_id: LEAD_ID, type: "lead_measurement_order" } },
    { expectedAmount: 1500, leadId: LEAD_ID },
  );
  assertEquals(res.ok, false);
});

Deno.test("happy path: records the order for a valid token + succeeded PaymentIntent", async () => {
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), baseDeps());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.order_id, "order_1");
});

Deno.test("idempotent retry returns the existing order without re-inserting", async () => {
  let insertCalled = false;
  const deps = baseDeps({
    findExistingOrder: () => Promise.resolve({ id: "order_existing", status: "awaiting_fulfillment" }),
    insertOrder: () => {
      insertCalled = true;
      return Promise.resolve({ id: "order_new", status: "awaiting_fulfillment" });
    },
  });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  const body = await res.json();
  assertEquals(body.order_id, "order_existing");
  assertEquals(body.idempotent, true);
  assertEquals(insertCalled, false);
});

Deno.test("NEGATIVE CONTROL: a bad/expired token is rejected with 401 and no order is ever inserted", async () => {
  let insertCalled = false;
  let fetchPiCalled = false;
  const deps = baseDeps({
    resolveLead: () => Promise.resolve(null),
    fetchPaymentIntent: () => {
      fetchPiCalled = true;
      return Promise.resolve({ status: "succeeded", currency: "usd", amount: 1500, metadata: {} });
    },
    insertOrder: () => {
      insertCalled = true;
      return Promise.resolve({ id: "order_should_never_exist", status: "awaiting_fulfillment" });
    },
  });
  const res = await handleRequest(req({ lead_token: "b".repeat(32), payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 401);
  assertEquals(insertCalled, false);
  // The lead is resolved BEFORE Stripe is ever consulted for this order write -- an invalid
  // token means the PaymentIntent is never even fetched.
  assertEquals(fetchPiCalled, false);
});

Deno.test("NEGATIVE CONTROL: a PaymentIntent that has not succeeded records nothing", async () => {
  let insertCalled = false;
  const deps = baseDeps({
    fetchPaymentIntent: () =>
      Promise.resolve({ status: "requires_payment_method", currency: "usd", amount: 1500, metadata: { lead_id: LEAD_ID, type: "lead_measurement_order" } }),
    insertOrder: () => {
      insertCalled = true;
      return Promise.resolve({ id: "order_should_never_exist", status: "awaiting_fulfillment" });
    },
  });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 402);
  assertEquals(insertCalled, false);
});

Deno.test("NEGATIVE CONTROL: Stripe lookup failure (fetchPaymentIntent -> null) records nothing", async () => {
  let insertCalled = false;
  const deps = baseDeps({
    fetchPaymentIntent: () => Promise.resolve(null),
    insertOrder: () => {
      insertCalled = true;
      return Promise.resolve({ id: "order_should_never_exist", status: "awaiting_fulfillment" });
    },
  });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 402);
  assertEquals(insertCalled, false);
});

Deno.test("NEGATIVE CONTROL: rate-limited caller is refused before the lead is resolved or Stripe is called", async () => {
  let resolveCalled = false;
  let fetchPiCalled = false;
  const deps = baseDeps({
    checkRateLimit: () => Promise.resolve({ allowed: false, reason: "too_many" }),
    resolveLead: () => {
      resolveCalled = true;
      return Promise.resolve({ leadId: LEAD_ID });
    },
    fetchPaymentIntent: () => {
      fetchPiCalled = true;
      return Promise.resolve(null);
    },
  });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 429);
  assertEquals(resolveCalled, false);
  assertEquals(fetchPiCalled, false);
});

Deno.test("a failed insert after a real charge returns payment_captured:true, never a silent 200", async () => {
  const deps = baseDeps({ insertOrder: () => Promise.resolve({ error: "db down" }) });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.payment_captured, true);
});
