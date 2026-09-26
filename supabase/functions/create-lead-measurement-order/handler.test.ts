// deno test --allow-read=. supabase/functions/create-lead-measurement-order/handler.test.ts
//
// The order is recorded through the REAL shared recordLeadOrder() against an
// in-memory table that enforces the migration's UNIQUE (stripe_payment_intent_id),
// so the duplicate/race tests exercise the actual idempotency logic.
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { handleRequest, validateBody, type Deps } from "./handler.ts";
import { type OrderRef, recordLeadOrder } from "../_shared/lead-measurement-order.ts";

const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_LEAD = "bbbbbbbb-0000-4000-8000-000000000002";
const GOOD_TOKEN = "a".repeat(32);
const PI_ID = "pi_abcdef123456";

function req(body: unknown): Request {
  return new Request("https://x/functions/v1/create-lead-measurement-order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function livePi(over: Record<string, unknown> = {}) {
  return {
    id: PI_ID,
    livemode: true,
    status: "succeeded",
    currency: "usd",
    amount: 1500,
    latest_charge: "ch_123",
    metadata: { lead_id: LEAD_ID, type: "lead_measurement_order", is_synthetic: "0" },
    ...over,
  };
}

/** In-memory lead_measurement_orders with the migration's unique key. */
function fakeTable() {
  const rows: Array<Record<string, unknown> & { id: string }> = [];
  const alerts: string[] = [];
  let failInsertWith: { code?: string; message?: string } | null = null;
  return {
    rows,
    alerts,
    failNextInsert(err: { code?: string; message?: string }) {
      failInsertWith = err;
    },
    record: (input: Parameters<typeof recordLeadOrder>[0]) =>
      recordLeadOrder(input, {
        insertIgnoringDuplicate: (row) => {
          if (failInsertWith) {
            const e = failInsertWith;
            failInsertWith = null;
            return Promise.resolve({ row: null, error: e });
          }
          if (rows.some((r) => r.stripe_payment_intent_id === row.stripe_payment_intent_id)) {
            return Promise.resolve({ row: null, error: null }); // ON CONFLICT DO NOTHING
          }
          const r: Record<string, unknown> & { id: string } = { ...row, id: `order_${rows.length + 1}` };
          rows.push(r);
          return Promise.resolve({ row: { id: r.id, status: String(r.status) }, error: null });
        },
        findByPaymentIntent: (pi) => {
          const r = rows.find((x) => x.stripe_payment_intent_id === pi);
          return Promise.resolve(r ? ({ id: r.id, status: String(r.status), lead_id: String(r.lead_id) } as OrderRef) : null);
        },
        alert: (_t, m) => {
          alerts.push(m);
          return Promise.resolve();
        },
      }),
  };
}

function baseDeps(table = fakeTable(), overrides: Partial<Deps> = {}): Deps & { _notified: string[] } {
  const notified: string[] = [];
  const deps: Deps = {
    stripeMode: "live",
    resolveLead: (token) => Promise.resolve(token === GOOD_TOKEN ? { leadId: LEAD_ID, isSynthetic: false } : null),
    readPriceCents: () => Promise.resolve({ row: { value: 1500 }, error: null }),
    findExistingOrder: (pi) => {
      const r = table.rows.find((x) => x.stripe_payment_intent_id === pi);
      return Promise.resolve(r ? { id: r.id, status: String(r.status), lead_id: String(r.lead_id) } : null);
    },
    fetchPaymentIntent: () => Promise.resolve(livePi()),
    recordOrder: table.record,
    checkRateLimit: () => Promise.resolve({ allowed: true }),
    notifyOrderCreated: ({ id }) => {
      notified.push(id);
      return Promise.resolve();
    },
    ...overrides,
  };
  return Object.assign(deps, { _notified: notified });
}

Deno.test("validateBody requires a well-formed payment_intent_id", () => {
  assertEquals(validateBody({ lead_token: GOOD_TOKEN, payment_intent_id: "not-a-pi" }).ok, false);
  assertEquals(validateBody({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }).ok, true);
});

Deno.test("happy path: a verified live PI records exactly one order (rebate_due false, is_test from the lead) and notifies once", async () => {
  const table = fakeTable();
  const deps = baseDeps(table);
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 200);
  assertEquals(table.rows.length, 1);
  assertEquals(table.rows[0].rebate_due, false);
  assertEquals(table.rows[0].is_test, false);
  assertEquals(table.rows[0].recorded_by, "browser");
  assertEquals(deps._notified.length, 1);
});

Deno.test("D11: a synthetic lead's order row carries is_test=true", async () => {
  const table = fakeTable();
  const deps = baseDeps(table, { resolveLead: () => Promise.resolve({ leadId: LEAD_ID, isSynthetic: true }) });
  await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(table.rows[0].is_test, true);
});

Deno.test("N8: the response echoes is_test so the page can suppress the GA4 purchase event for a synthetic lead", async () => {
  const table = fakeTable();
  const syntheticDeps = baseDeps(table, { resolveLead: () => Promise.resolve({ leadId: LEAD_ID, isSynthetic: true }) });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), syntheticDeps);
  assertEquals((await res.json()).is_test, true);

  const table2 = fakeTable();
  const realDeps = baseDeps(table2, { resolveLead: () => Promise.resolve({ leadId: LEAD_ID, isSynthetic: false }) });
  const res2 = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), realDeps);
  assertEquals((await res2.json()).is_test, false);
});

Deno.test("N8: the idempotent (already-recorded) response also echoes is_test", async () => {
  const table = fakeTable();
  await table.record({ leadId: LEAD_ID, paymentIntentId: PI_ID, amountCents: 1500, stripeChargeId: "ch_123", isTest: true, recordedBy: "webhook" });
  const deps = baseDeps(table, { resolveLead: () => Promise.resolve({ leadId: LEAD_ID, isSynthetic: true }) });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  const body = await res.json();
  assertEquals(body.idempotent, true);
  assertEquals(body.is_test, true);
});

Deno.test("negative control: a bad/expired token is rejected with 401, the PI is never fetched, nothing is recorded", async () => {
  let fetched = false;
  const table = fakeTable();
  const deps = baseDeps(table, { fetchPaymentIntent: () => { fetched = true; return Promise.resolve(livePi()); } });
  const res = await handleRequest(req({ lead_token: "b".repeat(32), payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 401);
  assertEquals(fetched, false);
  assertEquals(table.rows.length, 0);
});

Deno.test("negative control: rate-limited callers are refused before the lead is resolved", async () => {
  let resolved = false;
  const deps = baseDeps(fakeTable(), {
    checkRateLimit: () => Promise.resolve({ allowed: false, reason: "rate_limit_check_failed" }),
    resolveLead: () => { resolved = true; return Promise.resolve({ leadId: LEAD_ID, isSynthetic: false }); },
  });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 429);
  assertEquals(resolved, false);
});

// ── D7: the Origin/livemode forgery ─────────────────────────────────────────────
Deno.test("D7: in live mode a TEST-mode PaymentIntent (card 4242) is refused and nothing is recorded -- whatever the Origin", async () => {
  const table = fakeTable();
  const deps = baseDeps(table, { fetchPaymentIntent: () => Promise.resolve(livePi({ livemode: false })) });
  const forged = new Request("https://x/functions/v1/create-lead-measurement-order", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://jade-alpaca-b82b5e.netlify.app" },
    body: JSON.stringify({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }),
  });
  const res = await handleRequest(forged, deps);
  assertEquals(res.status, 402);
  assertEquals((await res.json()).reason, "livemode_mismatch");
  assertEquals(table.rows.length, 0);
});

Deno.test("D7: a PI with livemode missing (undefined) is refused in live mode (strict ===)", async () => {
  const table = fakeTable();
  const pi = livePi();
  delete (pi as Record<string, unknown>).livemode;
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), baseDeps(table, { fetchPaymentIntent: () => Promise.resolve(pi) }));
  assertEquals(res.status, 402);
  assertEquals(table.rows.length, 0);
});

Deno.test("NEGATIVE CONTROL (D7): only a server configured stripeMode=test accepts a test-mode PI", async () => {
  const table = fakeTable();
  const deps = baseDeps(table, { stripeMode: "test", fetchPaymentIntent: () => Promise.resolve(livePi({ livemode: false })) });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 200);
  assertEquals(table.rows.length, 1);
});

Deno.test("a PI for a DIFFERENT lead, a non-succeeded PI, a non-USD PI, a wrong amount, and a wrong type each record nothing", async () => {
  for (const over of [
    { metadata: { lead_id: OTHER_LEAD, type: "lead_measurement_order" } },
    { status: "requires_payment_method" },
    { currency: "eur" },
    { amount: 1000 },
    { metadata: { lead_id: LEAD_ID, type: "hover_measurement" } },
  ]) {
    const table = fakeTable();
    const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), baseDeps(table, { fetchPaymentIntent: () => Promise.resolve(livePi(over)) }));
    assertEquals(res.status, 402, JSON.stringify(over));
    assertEquals(table.rows.length, 0);
  }
});

Deno.test("a Stripe lookup failure records nothing", async () => {
  const table = fakeTable();
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), baseDeps(table, { fetchPaymentIntent: () => Promise.resolve(null) }));
  assertEquals(res.status, 402);
  assertEquals(table.rows.length, 0);
});

// ── D5: duplicate PI / browser-vs-webhook race ───────────────────────────────────
Deno.test("D5: the webhook recorded the order first -> the browser call returns the existing order idempotently, no second row, no second email", async () => {
  const table = fakeTable();
  await table.record({ leadId: LEAD_ID, paymentIntentId: PI_ID, amountCents: 1500, stripeChargeId: "ch_123", isTest: false, recordedBy: "webhook" });
  const deps = baseDeps(table);
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.idempotent, true);
  assertEquals(body.order_id, "order_1");
  assertEquals(table.rows.length, 1);
  assertEquals(deps._notified.length, 0);
});

Deno.test("D5: the race where the webhook inserts between our existence check and our insert -> conflict resolves to the existing row", async () => {
  const table = fakeTable();
  const deps = baseDeps(table, {
    findExistingOrder: () => Promise.resolve(null), // stale read: the check ran before the webhook's insert
    fetchPaymentIntent: async () => {
      await table.record({ leadId: LEAD_ID, paymentIntentId: PI_ID, amountCents: 1500, stripeChargeId: "ch_123", isTest: false, recordedBy: "webhook" });
      return livePi();
    },
  });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).idempotent, true);
  assertEquals(table.rows.length, 1);
  assertEquals(table.alerts.length, 0);
});

Deno.test("D5: a 23505 on insert (PostgREST unique violation) re-selects and returns the existing order", async () => {
  const table = fakeTable();
  await table.record({ leadId: LEAD_ID, paymentIntentId: PI_ID, amountCents: 1500, stripeChargeId: null, isTest: false, recordedBy: "webhook" });
  table.failNextInsert({ code: "23505", message: "duplicate key" });
  const deps = baseDeps(table, { findExistingOrder: () => Promise.resolve(null) });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).idempotent, true);
  assertEquals(table.alerts.length, 0);
});

Deno.test("D5: any OTHER insert failure after a real charge alerts platform_alerts_log and returns payment_captured (never a silent 200)", async () => {
  const table = fakeTable();
  table.failNextInsert({ code: "42501", message: "permission denied" });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), baseDeps(table));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).payment_captured, true);
  assertEquals(table.alerts.length, 1);
  assert(table.alerts[0].includes(PI_ID));
  assert(table.alerts[0].includes("insert_error_42501"));
});

Deno.test("an existing order for this PI that belongs to ANOTHER lead is not returned to this token", async () => {
  const table = fakeTable();
  await table.record({ leadId: OTHER_LEAD, paymentIntentId: PI_ID, amountCents: 1500, stripeChargeId: null, isTest: false, recordedBy: "webhook" });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN, payment_intent_id: PI_ID }), baseDeps(table));
  assertEquals(res.status, 402);
});
