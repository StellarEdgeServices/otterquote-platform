// deno test --allow-read=. supabase/functions/_shared/lead-measurement-order.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildLeadOrderRow,
  checkLeadPaymentIntent,
  isBlockingOrderStatus,
  recordLeadOrder,
  resolveStripeMode,
  stripeSecretKeyForMode,
} from "./lead-measurement-order.ts";

const LEAD = "aaaaaaaa-0000-4000-8000-000000000001";
const good = { livemode: true, status: "succeeded", currency: "usd", amount: 1500, latest_charge: { id: "ch_9" }, metadata: { type: "lead_measurement_order", lead_id: LEAD } };

Deno.test("D7: STRIPE_MODE is live unless it is exactly 'test' (case/space-insensitive); unset is live", () => {
  assertEquals(resolveStripeMode(undefined), "live");
  assertEquals(resolveStripeMode(""), "live");
  assertEquals(resolveStripeMode("staging"), "live");
  assertEquals(resolveStripeMode(" TEST "), "test");
});

Deno.test("D7: live mode reads ONLY STRIPE_SECRET_KEY; test mode ONLY STRIPE_SECRET_KEY_TEST (no cross-fallback)", () => {
  const env = (k: string) => ({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_SECRET_KEY_TEST: "sk_test_x" } as Record<string, string>)[k];
  assertEquals(stripeSecretKeyForMode("live", env), "sk_live_x");
  assertEquals(stripeSecretKeyForMode("test", env), "sk_test_x");
  assertEquals(stripeSecretKeyForMode("test", (k) => (k === "STRIPE_SECRET_KEY" ? "sk_live_x" : undefined)), undefined);
});

Deno.test("checkLeadPaymentIntent: accepts a matching live PI and extracts the charge id", () => {
  const r = checkLeadPaymentIntent(good, { expectedAmount: 1500, leadId: LEAD, stripeMode: "live" });
  assert(r.ok);
  assertEquals(r.ok && r.stripeChargeId, "ch_9");
});

Deno.test("checkLeadPaymentIntent: each broken property is refused with its own reason", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ livemode: false }, "livemode_mismatch"],
    [{ status: "processing" }, "not_succeeded"],
    [{ currency: "cad" }, "not_usd"],
    [{ amount: 1499 }, "amount_mismatch"],
    [{ metadata: { type: "hover_measurement", lead_id: LEAD } }, "wrong_type"],
    [{ metadata: { type: "lead_measurement_order", lead_id: "not-a-uuid" } }, "no_lead_id"],
    [{ metadata: { type: "lead_measurement_order", lead_id: "bbbbbbbb-0000-4000-8000-000000000002" } }, "lead_mismatch"],
  ];
  for (const [over, reason] of cases) {
    const r = checkLeadPaymentIntent({ ...good, ...over }, { expectedAmount: 1500, leadId: LEAD, stripeMode: "live" });
    assertEquals(r.ok ? "ok" : r.reason, reason);
  }
  const nul = checkLeadPaymentIntent(null, { expectedAmount: 1500, leadId: LEAD, stripeMode: "live" });
  assertEquals(nul.ok, false);
});

Deno.test("D10: only cancelled/refunded orders do not block a new purchase", () => {
  assertEquals(isBlockingOrderStatus("awaiting_fulfillment"), true);
  assertEquals(isBlockingOrderStatus("fulfilled"), true);
  assertEquals(isBlockingOrderStatus("cancelled"), false);
  assertEquals(isBlockingOrderStatus("refunded"), false);
});

Deno.test("L2: the order row never flags a rebate", () => {
  assertEquals(buildLeadOrderRow({ leadId: LEAD, paymentIntentId: "pi_1", amountCents: 1500, stripeChargeId: null, isTest: false, recordedBy: "browser" }).rebate_due, false);
});

Deno.test("recordLeadOrder: a conflict with no row found afterwards is alerted as a failure (never reported as success)", async () => {
  const alerts: string[] = [];
  const out = await recordLeadOrder(
    { leadId: LEAD, paymentIntentId: "pi_x", amountCents: 1500, stripeChargeId: null, isTest: false, recordedBy: "webhook" },
    {
      insertIgnoringDuplicate: () => Promise.resolve({ row: null, error: null }),
      findByPaymentIntent: () => Promise.resolve(null),
      alert: (_t, m) => { alerts.push(m); return Promise.resolve(); },
    },
  );
  assertEquals(out.outcome, "failed");
  assertEquals(alerts.length, 1);
});

Deno.test("recordLeadOrder: a thrown insert is caught and alerted", async () => {
  const alerts: string[] = [];
  const out = await recordLeadOrder(
    { leadId: LEAD, paymentIntentId: "pi_y", amountCents: 1500, stripeChargeId: null, isTest: false, recordedBy: "browser" },
    {
      insertIgnoringDuplicate: () => Promise.reject(new Error("network")),
      findByPaymentIntent: () => Promise.resolve(null),
      alert: (_t, m) => { alerts.push(m); return Promise.resolve(); },
    },
  );
  assertEquals(out.outcome, "failed");
  assertEquals(alerts.length, 1);
});
