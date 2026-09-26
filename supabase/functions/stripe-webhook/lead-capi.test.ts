// deno test --allow-read=. supabase/functions/stripe-webhook/lead-capi.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  decideLeadCapiPerson,
  handleLeadMeasurementPurchase,
  isLeadMeasurementPurchase,
  type LeadPurchaseEnv,
  recordLeadOrderFromWebhook,
  resolveLeadForCapi,
} from "./lead-capi.ts";

const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";

Deno.test("isLeadMeasurementPurchase only matches the lead_measurement_order type", () => {
  assertEquals(isLeadMeasurementPurchase({ metadata: { type: "lead_measurement_order" } }), true);
  assertEquals(isLeadMeasurementPurchase({ metadata: { type: "hover_measurement" } }), false);
  assertEquals(isLeadMeasurementPurchase({ metadata: { type: "measurement_order" } }), false);
  assertEquals(isLeadMeasurementPurchase({ metadata: {} }), false);
  assertEquals(isLeadMeasurementPurchase({}), false);
  assertEquals(isLeadMeasurementPurchase(null), false);
});

Deno.test("decideLeadCapiPerson fails closed on a lookup failure, a missing id, and a lead that does not exist", () => {
  assertEquals(decideLeadCapiPerson({ leadId: "lead-1", leadLookupFailed: true }), { skip: true, reason: "lead_lookup_failed" });
  assertEquals(decideLeadCapiPerson({ leadId: null, leadLookupFailed: false }), { skip: true, reason: "no_lead_id" });
  assertEquals(decideLeadCapiPerson({ leadId: "lead-1", leadLookupFailed: false, leadFound: false }), { skip: true, reason: "lead_not_found" });
  assertEquals(decideLeadCapiPerson({ leadId: "lead-1", leadLookupFailed: false, leadFound: true }), { skip: false, reason: null });
});

Deno.test("resolveLeadForCapi: empty email is no email; is_synthetic surfaces; null lead is safe", () => {
  assertEquals(resolveLeadForCapi({ id: "lead-1", email: "", is_synthetic: false }).email, null);
  assertEquals(resolveLeadForCapi({ id: "lead-1", email: "a@b.com", is_synthetic: true }).isSynthetic, true);
  assertEquals(resolveLeadForCapi(null), { email: null, isSynthetic: false });
});

// ── An in-memory Supabase stand-in (only the calls lead-capi.ts makes) ───────────
type Row = Record<string, unknown>;
function fakeSupabase(seed: { leads?: Row[]; price?: unknown; failTable?: string } = {}) {
  const tables: Record<string, Row[]> = {
    leads: seed.leads ?? [{ id: LEAD_ID, email: "jane@example.com", is_synthetic: false }],
    platform_settings: seed.price === undefined ? [{ key: "hover_measurement_price", value: 1500 }] : (seed.price === null ? [] : [{ key: "hover_measurement_price", value: seed.price }]),
    lead_measurement_orders: [],
    platform_alerts_log: [],
    stripe_webhook_events: [],
    ad_sharing_suppressions: [],
  };
  let seq = 0;
  const from = (t: string) => {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "upsert" | "insert" | "delete" = "select";
    let payload: Row | null = null;
    let conflictKey = "";
    const matching = () => tables[t].filter((r) => filters.every(([k, v]) => r[k] === v));
    const run = (): { data: unknown; error: unknown } => {
      if (seed.failTable === t) return { data: null, error: { code: "XX000", message: "db down" } };
      if (op === "upsert") {
        if (tables[t].some((r) => r[conflictKey] === payload![conflictKey])) return { data: [], error: null };
        const row: Row = { id: `row_${++seq}`, ...payload! };
        tables[t].push(row);
        return { data: [{ id: row.id, status: row.status }], error: null };
      }
      if (op === "insert") {
        if (t === "stripe_webhook_events" && tables[t].some((r) => r.event_id === payload!.event_id)) {
          return { data: null, error: { code: "23505" } };
        }
        tables[t].push({ ...payload! });
        return { data: null, error: null };
      }
      if (op === "delete") {
        tables[t] = tables[t].filter((r) => !filters.every(([k, v]) => r[k] === v));
        return { data: null, error: null };
      }
      return { data: matching(), error: null };
    };
    const b = {
      select: (_c?: string) => b,
      eq: (k: string, v: unknown) => { filters.push([k, v]); return b; },
      maybeSingle: () => {
        const r = run();
        if (r.error) return Promise.resolve(r);
        const arr = r.data as Row[];
        return Promise.resolve({ data: arr[0] ?? null, error: null });
      },
      upsert: (row: Row, opts: { onConflict: string }) => { op = "upsert"; payload = row; conflictKey = opts.onConflict; return b; },
      insert: (row: Row) => { op = "insert"; payload = row; return Promise.resolve(run()); },
      delete: () => { op = "delete"; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { from, tables };
}

function env(over: Record<string, string> = {}): LeadPurchaseEnv & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: (k) => ({ SUPABASE_URL: "https://sb", SUPABASE_SERVICE_ROLE_KEY: "srk", ...over } as Record<string, string>)[k],
    fetch: (input) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    },
  };
}

function pi(over: Record<string, unknown> = {}) {
  return {
    id: "pi_lead_1",
    livemode: true,
    status: "succeeded",
    currency: "usd",
    amount: 1500,
    amount_received: 1500,
    latest_charge: "ch_1",
    metadata: { type: "lead_measurement_order", lead_id: LEAD_ID, is_synthetic: "0" },
    ...over,
  };
}

// ── D5: the webhook records the order ────────────────────────────────────────────
Deno.test("D5: payment_intent.succeeded records the lead order (recorded_by webhook, rebate_due false) and notifies the admin once", async () => {
  const sb = fakeSupabase();
  const e = env();
  assertEquals(await recordLeadOrderFromWebhook(pi(), sb, e), "inserted");
  assertEquals(sb.tables.lead_measurement_orders.length, 1);
  const row = sb.tables.lead_measurement_orders[0];
  assertEquals(row.recorded_by, "webhook");
  assertEquals(row.rebate_due, false);
  assertEquals(row.homeowner_charge_amount, 1500);
  assertEquals(e.calls.filter((c) => c.endsWith("/notify-measurement-order")).length, 1);
});

Deno.test("D5: a redelivered/duplicate event (or the browser having recorded first) writes no second row and sends no second email", async () => {
  const sb = fakeSupabase();
  const e = env();
  await recordLeadOrderFromWebhook(pi(), sb, e);
  assertEquals(await recordLeadOrderFromWebhook(pi(), sb, e), "existing");
  assertEquals(sb.tables.lead_measurement_orders.length, 1);
  assertEquals(e.calls.length, 1);
});

Deno.test("D5/D7: in live mode a test-mode PI is not recorded, and a human is alerted", async () => {
  const sb = fakeSupabase();
  assertEquals(await recordLeadOrderFromWebhook(pi({ livemode: false }), sb, env()), "rejected");
  assertEquals(sb.tables.lead_measurement_orders.length, 0);
  assertEquals(sb.tables.platform_alerts_log.length, 1);
  assertEquals(sb.tables.platform_alerts_log[0].alert_type, "lead_order_payment_rejected");
});

Deno.test("NEGATIVE CONTROL (D7): with STRIPE_MODE=test the same test-mode PI IS recorded", async () => {
  const sb = fakeSupabase();
  assertEquals(await recordLeadOrderFromWebhook(pi({ livemode: false }), sb, env({ STRIPE_MODE: "test" })), "inserted");
});

Deno.test("D5: a DB failure writes platform_alerts_log lead_order_payment_captured_unrecorded (never silent)", async () => {
  const sb = fakeSupabase({ failTable: "lead_measurement_orders" });
  assertEquals(await recordLeadOrderFromWebhook(pi(), sb, env()), "failed");
  const a = sb.tables.platform_alerts_log;
  assertEquals(a.length, 1);
  assertEquals(a[0].alert_type, "lead_order_payment_captured_unrecorded");
  assert(String(a[0].message).includes("pi_lead_1"));
});

Deno.test("D5: an unreadable price or an unknown lead alerts and records nothing", async () => {
  const noPrice = fakeSupabase({ price: null });
  assertEquals(await recordLeadOrderFromWebhook(pi(), noPrice, env()), "failed");
  assertEquals(noPrice.tables.platform_alerts_log.length, 1);
  const noLead = fakeSupabase({ leads: [] });
  assertEquals(await recordLeadOrderFromWebhook(pi(), noLead, env()), "failed");
  assertEquals(noLead.tables.lead_measurement_orders.length, 0);
  assertEquals(noLead.tables.platform_alerts_log.length, 1);
});

Deno.test("D11: a synthetic lead (row flag OR the PI's is_synthetic stamp) records is_test=true", async () => {
  const a = fakeSupabase({ leads: [{ id: LEAD_ID, email: "x@y.z", is_synthetic: true }] });
  await recordLeadOrderFromWebhook(pi(), a, env());
  assertEquals(a.tables.lead_measurement_orders[0].is_test, true);
  const b = fakeSupabase();
  await recordLeadOrderFromWebhook(pi({ metadata: { type: "lead_measurement_order", lead_id: LEAD_ID, is_synthetic: "1" } }), b, env());
  assertEquals(b.tables.lead_measurement_orders[0].is_test, true);
});

Deno.test("handleLeadMeasurementPurchase ignores every other PaymentIntent type (touches nothing)", async () => {
  const sb = fakeSupabase();
  await handleLeadMeasurementPurchase(pi({ metadata: { type: "hover_measurement", claim_id: "c" } }), sb, env());
  assertEquals(sb.tables.lead_measurement_orders.length, 0);
  assertEquals(sb.tables.platform_alerts_log.length, 0);
});

Deno.test("handleLeadMeasurementPurchase records the order even when META_CAPI_ACCESS_TOKEN is unset (CAPI is independent)", async () => {
  const sb = fakeSupabase();
  await handleLeadMeasurementPurchase(pi(), sb, env());
  assertEquals(sb.tables.lead_measurement_orders.length, 1);
});

Deno.test("CAPI: with a token set, a live non-synthetic lead purchase sends ONE Purchase and claims the PI once", async () => {
  const sb = fakeSupabase();
  const e = env({ META_CAPI_ACCESS_TOKEN: "tok" });
  await handleLeadMeasurementPurchase(pi(), sb, e);
  await handleLeadMeasurementPurchase(pi(), sb, e);
  assertEquals(e.calls.filter((c) => c.includes("graph.facebook.com")).length, 1);
});

Deno.test("CAPI: a synthetic lead with no META_CAPI_TEST_EVENT_CODE sends nothing to Meta", async () => {
  const sb = fakeSupabase({ leads: [{ id: LEAD_ID, email: "x@otterquote-internal.test", is_synthetic: true }] });
  const e = env({ META_CAPI_ACCESS_TOKEN: "tok" });
  await handleLeadMeasurementPurchase(pi(), sb, e);
  assertEquals(e.calls.filter((c) => c.includes("graph.facebook.com")).length, 0);
});

// ── Structure: the SAME ordering rules the meta-capi-*.test.ts files pin on the
// claim-keyed handler, pinned here on the lead handler (REVIEW D8: the lead path
// moved out of index.ts so those tests are unchanged, not weakened). ──────────
const src = await Deno.readTextFile(new URL("./lead-capi.ts", import.meta.url));
const hStart = src.indexOf("export async function handleLeadMeasurementCapiPurchase(");
const hEnd = src.indexOf("export async function handleLeadMeasurementPurchase(", hStart);
const handler = src.slice(hStart, hEnd);

Deno.test("structure: the lead CAPI handler sends through sendCapiPurchaseOnce exactly once, and the Meta fetch is only inside it", () => {
  assert(hStart > 0 && hEnd > hStart);
  assertEquals(handler.split("sendCapiPurchaseOnce(").length - 1, 1);
  assertEquals(handler.split("graph.facebook.com").length - 1, 1);
  assert(handler.indexOf("graph.facebook.com") > handler.indexOf("sendCapiPurchaseOnce("));
});

Deno.test("structure: GPC metadata first; USD pin, person decision, test gate, suppression and payload all before the claim", () => {
  const gpc = handler.indexOf("shouldSkipForGpcMetadata(");
  const claimAt = handler.indexOf("sendCapiPurchaseOnce(");
  assert(gpc > 0);
  for (const later of ['.from("leads")', "hashEmailSha256(", "graph.facebook.com"]) {
    assert(handler.indexOf(later) > gpc, `${later} after the GPC check`);
  }
  for (const before of ["shouldSkipForNonUsdMeasurement(", "decideLeadCapiPerson(", "shouldSendCapiEvent(", "shouldSkipForSuppression(", "buildCapiPurchasePayload("]) {
    const at = handler.indexOf(before);
    assert(at > 0 && at < claimAt, `${before} before the claim`);
  }
  assertEquals(handler.split("shouldSkipForSuppression(").length - 1, 1);
  assertEquals(handler.split('.from("ad_sharing_suppressions")').length - 1, 1);
  assert(handler.indexOf('.from("ad_sharing_suppressions")') > handler.indexOf("hashEmailSha256("), "suppression after hashing");
});

Deno.test("structure: the claim is the PI-keyed insert into stripe_webhook_events and a failed send releases exactly that key", () => {
  assert(/\.from\("stripe_webhook_events"\)\s*\.insert\(\{\s*event_id:\s*capiClaimKey\(paymentIntent\.id\),\s*event_type:\s*CAPI_CLAIM_EVENT_TYPE\s*\}\)/.test(handler));
  assert(/\.eq\("event_id",\s*capiClaimKey\(paymentIntent\.id\)\);\s*return !error;/.test(handler));
});

Deno.test("structure: index.ts calls the lead path from ONE line and its claim-keyed handler region contains no lead code", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(index.split("await handleLeadMeasurementPurchase(").length - 1, 1);
  const s = index.indexOf("async function handleMeasurementOrderCapiPurchase(");
  const e = index.indexOf("// Entry point", s);
  const region = index.slice(s, e);
  assert(!region.includes("lead_measurement_order") && !region.includes("handleLead"));
});
