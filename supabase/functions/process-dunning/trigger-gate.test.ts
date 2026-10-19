// gh-2442 N-g/N-i/N-j/N-k (REVIEW 6277377025, 6277504129, 6277733088): TRIGGER mode must ALWAYS set up dunning (after the #1467
// guard); only the Stripe charge loop is gated; a lease/gate-error refusal leaves a SYSTEM retry request for the next CRON tick;
// the quote write is a compare-and-set. Drives the REAL handler with a stateful recording fetch stub.
// CI flags (e2e-tests.yml): deno test --allow-read=... supabase/functions/  -> no --allow-env, no --allow-net: env goes through getEnv.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handler } from "./index.ts";

const KEY = "fixture-runtime-service-key-0123456789";
const BASE = "https://x.supabase.co/functions/v1/process-dunning";
const ENV: Record<string, string | undefined> = {
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY, DUNNING_RETRY_PASS_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_x",
};
type World = {
  lease: "free" | "held" | "unreadable"; marker: "none" | "set" | "error"; leaseHolder: string | null;
  isTest: boolean; quoteStatus: Record<string, string>;
  stripe: number; inflight: number; maxInflight: number; leaseTaken: number; leaseReleased: number;
  inserts: Array<Record<string, unknown>>; alerts: string[]; quotePatches: string[];
};
const world = (o: Partial<World> = {}): World => ({
  lease: "free", marker: "none", leaseHolder: null, isTest: false, quoteStatus: {},
  stripe: 0, inflight: 0, maxInflight: 0, leaseTaken: 0, leaseReleased: 0, inserts: [], alerts: [], quotePatches: [], ...o,
});

async function post(w: World, quotes: string[]) {
  const real = globalThis.fetch;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url); const m = req.method;
    const single = (req.headers.get("accept") ?? "").includes("pgrst.object");
    const empty = () => json(single ? null : [], single ? 406 : 200);
    const body = init?.body ? (() => { try { return JSON.parse(String(init.body)); } catch { return {}; } })() : {};
    if (u.host === "api.stripe.com") {
      if (m === "POST") { w.stripe++; w.inflight++; w.maxInflight = Math.max(w.maxInflight, w.inflight); await new Promise((r) => setTimeout(r, 40)); w.inflight--; }
      return json({ error: { type: "card_error", code: "card_declined", message: "declined" } }, 402);
    }
    if (!u.pathname.startsWith("/rest/v1/")) return json({});
    const tb = u.pathname.split("/").pop()!;
    if (tb === "dunning_retry_pass_lease") {
      if (w.lease === "unreadable") return json({ message: "relation does not exist" }, 404);
      if (body.holder) { // acquire: only when free
        if (w.lease === "held" || w.leaseHolder) return json([]);
        w.leaseHolder = body.holder; w.leaseTaken++; return json([{ id: 1 }]);
      }
      const h = u.searchParams.get("holder"); // release: holder=eq.<token>
      if (h === `eq.${w.leaseHolder}`) { w.leaseHolder = null; w.leaseReleased++; return json([{ id: 1 }]); }
      return json([]);
    }
    if (tb === "platform_alerts_log" && m === "POST") { w.alerts.push(String(init?.body)); return json([]); }
    if (tb === "payment_failures" && m === "GET" && u.search.includes("retry_unknown_at")) {
      if (w.marker === "error") return json({ message: "boom" }, 500);
      return json(w.marker === "set" ? [{ id: "w1" }] : []);
    }
    if (tb === "payment_failures" && m === "POST") { w.inserts.push(body); return json([{ id: "f-" + body.quote_id, quote_id: body.quote_id }]); }
    if (tb === "quotes" && m === "PATCH") {
      const id = (u.searchParams.get("id") ?? "").replace("eq.", ""); w.quotePatches.push(u.search);
      const cur = w.quoteStatus[id] ?? null;
      const or = u.searchParams.get("or") ?? "";
      const guarded = or.includes("payment_status.not.in.(succeeded,pending,processing)");
      if (guarded && cur && ["succeeded", "pending", "processing"].includes(cur)) return json([]);
      w.quoteStatus[id] = body.payment_status; return json([{ id }]);
    }
    if (tb === "claims" && m === "GET") return json({ id: "cl1", is_test: w.isTest, live_charge_authorized_at: null, property_address: "1 Main" });
    if (tb === "contractors" && m === "GET") return json({ id: "c1", stripe_customer_id: "cus_1", company_name: "Co", timezone: "America/New_York", address_state: "IN", email: null, notification_emails: [], notification_phones: [], user_id: null });
    if (tb === "contractor_payment_methods" && m === "GET") return json([{ id: "cpm1", contractor_id: "c1", is_default: true, payment_type: "card", stripe_payment_method_id: "pm_1" }]);
    if (m === "GET") return empty();
    return json([{ id: "x" }]);
  }) as typeof fetch;
  try {
    return await Promise.all(quotes.map(async (q) => {
      const res = await handler(new Request(BASE, {
        method: "POST", headers: { Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ quote_id: q, contractor_id: "c1", claim_id: "cl1", homeowner_id: null, amount_cents: 10000 }),
      }), (n) => ENV[n]);
      await res.text();
      return res;
    }));
  } finally { globalThis.fetch = real; }
}
const ids = (w: World) => w.inserts.map((i) => i.quote_id as string).sort();

Deno.test("baseline: lease free, no marker -> charge loop runs, dunning set up, NO system retry request, lease released", async () => {
  const w = world(); await post(w, ["qa"]);
  assertEquals(w.stripe, 1); assertEquals(ids(w), ["qa"]); assertEquals(w.leaseTaken, 1); assertEquals(w.leaseHolder, null);
  assertEquals("retry_requested_at" in w.inserts[0], false);
});
Deno.test("in-doubt marker: dunning set up, NO Stripe charge, NO system request (CRON reconciles), lease released, alert", async () => {
  const w = world({ marker: "set" }); await post(w, ["qb"]);
  assertEquals(w.stripe, 0); assertEquals(ids(w), ["qb"]); assertEquals(w.leaseHolder, null);
  assertEquals("retry_requested_at" in w.inserts[0], false);
  assert(w.alerts.some((a) => a.includes("dunning_trigger_skipped")));
});
Deno.test("lease held: dunning set up, NO charge, a SYSTEM retry request is marked (count untouched)", async () => {
  const w = world({ lease: "held" }); await post(w, ["qc"]);
  assertEquals(w.stripe, 0); assertEquals(ids(w), ["qc"]);
  assert(typeof w.inserts[0].retry_requested_at === "string");
  assertEquals("retry_request_count" in w.inserts[0], false);
});
Deno.test("unreadable lease: dunning set up, no charge, system retry request marked, lease alert raised", async () => {
  const w = world({ lease: "unreadable" }); await post(w, ["qd"]);
  assertEquals(w.stripe, 0); assertEquals(ids(w), ["qd"]); assert(typeof w.inserts[0].retry_requested_at === "string");
  assert(w.alerts.some((a) => a.includes("dunning_retry_lease_unreadable")));
});
Deno.test("marker read fails: dunning set up, no charge, whatever was taken is released, system request marked", async () => {
  const w = world({ marker: "error" }); await post(w, ["qe"]);
  assertEquals(w.stripe, 0); assertEquals(ids(w), ["qe"]); assertEquals(w.leaseTaken, 1); assertEquals(w.leaseHolder, null);
  assert(typeof w.inserts[0].retry_requested_at === "string");
});
Deno.test("N-i: an unauthorised TEST claim never enters dunning, whatever the gate decides", async () => {
  for (const lease of ["free", "held", "unreadable"] as const) {
    const w = world({ isTest: true, lease }); const [res] = await post(w, ["qt"]);
    assertEquals(w.inserts.length, 0, `lease=${lease}`); assertEquals(w.stripe, 0); assertEquals(res.status, 200);
    assertEquals(w.quotePatches.length, 0);
    assert(w.alerts.some((a) => a.includes("platform_fee_refused_unauthorized_test")));
  }
});
Deno.test("N-j: the quote write is a compare-and-set; a paid quote is not flipped back to dunning", async () => {
  const w = world({ lease: "held", quoteStatus: { qp: "succeeded", qn: "failed" } }); await post(w, ["qp", "qn"]);
  assertEquals(w.quoteStatus.qp, "succeeded"); assertEquals(w.quoteStatus.qn, "dunning");
  assertEquals(ids(w), ["qn", "qp"]); // the failure rows are still created; reminders are held by payment-hold for the paid quote
});
Deno.test("N-k: two concurrent TRIGGERs really contend for the lease: charges never overlap, both set up dunning", async () => {
  const w = world(); await post(w, ["q1", "q2"]);
  assertEquals(w.leaseTaken, 2); assertEquals(w.maxInflight, 1); assertEquals(w.stripe, 2); assertEquals(ids(w), ["q1", "q2"]); assertEquals(w.leaseHolder, null);
});
Deno.test("N-k: lease held for the whole attempt window -> both skip the charge, both keep dunning and get a system request", async () => {
  const w = world({ lease: "held" }); await post(w, ["q3", "q4"]);
  assertEquals(w.stripe, 0); assertEquals(ids(w), ["q3", "q4"]); assert(w.inserts.every((i) => typeof i.retry_requested_at === "string"));
});
