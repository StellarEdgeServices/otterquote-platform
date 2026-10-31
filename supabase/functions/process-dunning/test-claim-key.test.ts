// gh-3293 (REVIEW 6548365782 A, C): process-dunning TRIGGER mode must pick its Stripe key by the claim's is_test,
// read server-side, never by Origin alone. Drives the REAL handler (same stateful fetch stub as trigger-gate.test.ts)
// and records the Authorization header of every api.stripe.com POST.
// NEGATIVE CONTROL: on main the handler picks STRIPE_SECRET_KEY (LIVE) for a request with no Origin whatever the claim
// is, so "is_test claim -> only the TEST key" FAILS against main's logic; the real-claim test below proves the harness
// does see a live-key charge when one is made.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handler } from "./index.ts";

const KEY = "fixture-runtime-service-key-0123456789";
const BASE = "https://x.supabase.co/functions/v1/process-dunning";
const ENV: Record<string, string | undefined> = {
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY, DUNNING_RETRY_PASS_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_live_REALKEY", STRIPE_SECRET_KEY_TEST: "sk_test_TESTKEY",
};
type World = {
  lease: "free" | "held" | "unreadable"; marker: "none" | "set" | "error"; leaseHolder: string | null;
  isTest: boolean; authorized: boolean; stripeAuth: string[]; quoteStatus: Record<string, string>;
  stripe: number; inflight: number; maxInflight: number; leaseTaken: number; leaseReleased: number;
  quoteReadable: boolean; claimReadable: boolean; notified: number; inserts: Array<Record<string, unknown>>; alerts: string[]; quotePatches: string[];
};
const world = (o: Partial<World> = {}): World => ({
  lease: "free", marker: "none", leaseHolder: null, isTest: false, authorized: false, stripeAuth: [], quoteStatus: {},
  quoteReadable: true, claimReadable: true, notified: 0, stripe: 0, inflight: 0, maxInflight: 0, leaseTaken: 0, leaseReleased: 0, inserts: [], alerts: [], quotePatches: [], ...o,
});

async function post(w: World, quotes: string[], env: Record<string, string | undefined> = ENV) {
  const real = globalThis.fetch;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url); const m = req.method;
    const single = (req.headers.get("accept") ?? "").includes("pgrst.object");
    const empty = () => json(single ? null : [], single ? 406 : 200);
    const body = init?.body ? (() => { try { return JSON.parse(String(init.body)); } catch { return {}; } })() : {};
    if (u.host === "api.stripe.com") {
      if (m === "POST") { w.stripeAuth.push(atob((req.headers.get("Authorization") ?? "").replace("Basic ", "")).replace(/:$/, "")); w.stripe++; w.inflight++; w.maxInflight = Math.max(w.maxInflight, w.inflight); await new Promise((r) => setTimeout(r, 40)); w.inflight--; }
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
      const guarded = or.includes("payment_status.not.in.(succeeded,pending,processing,refunded)");
      if (guarded && cur && ["succeeded", "pending", "processing", "refunded"].includes(cur)) return json([]);
      w.quoteStatus[id] = body.payment_status; return json([{ id }]);
    }
    if (tb === "quotes" && m === "GET" && !w.quoteReadable) return json({ message: "boom" }, 500);
    if (tb === "quotes" && m === "GET") { const id = (u.searchParams.get("id") ?? "").replace("eq.", ""); return json(single ? { payment_status: w.quoteStatus[id] ?? null } : [{ id, payment_status: w.quoteStatus[id] ?? null }]); }
    if (tb === "claims" && m === "GET" && !w.claimReadable) return json({ message: "boom" }, 500);
    if (tb === "notifications" && m === "POST") { w.notified++; return json([]); }
    if (tb === "claims" && m === "GET") return json({ id: "cl1", is_test: w.isTest, live_charge_authorized_at: w.authorized ? "2026-10-31T00:00:00Z" : null, property_address: "1 Main" });
    if (tb === "contractors" && m === "GET") return json({ id: "c1", stripe_customer_id: "cus_1", company_name: "Co", timezone: "America/New_York", address_state: "IN", email: null, notification_emails: [], notification_phones: [], user_id: "u1" });
    if (tb === "contractor_payment_methods" && m === "GET") return json([{ id: "cpm1", contractor_id: "c1", is_default: true, payment_type: "card", stripe_payment_method_id: "pm_1" }]);
    if (m === "GET") return empty();
    return json([{ id: "x" }]);
  }) as typeof fetch;
  try {
    return await Promise.all(quotes.map(async (q) => {
      const res = await handler(new Request(BASE, {
        method: "POST", headers: { Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ quote_id: q, contractor_id: "c1", claim_id: "cl1", homeowner_id: null, amount_cents: 10000 }),
      }), (n) => env[n]);
      await res.text();
      return res;
    }));
  } finally { globalThis.fetch = real; }
}

const ids = (w: World) => w.inserts.map((i) => i.quote_id as string).sort();

Deno.test("gh-3293 A: an AUTHORISED is_test claim, no Origin (docusign-webhook / stripe-webhook path) is charged on the TEST key only", async () => {
  const w = world({ isTest: true, authorized: true }); await post(w, ["qk1"]);
  assert(w.stripe >= 1, "the charge loop must still run on the test key");
  assertEquals(w.stripeAuth.every((k) => k === "sk_test_TESTKEY"), true, `keys used: ${w.stripeAuth.join(",")}`);
  assertEquals(w.stripeAuth.includes("sk_live_REALKEY"), false);
});
Deno.test("gh-3293 A: an authorised is_test claim with NO usable TEST key makes no Stripe call at all (fail closed)", async () => {
  for (const test of [undefined, "sk_live_REALKEY", ""]) {
    const w = world({ isTest: true, authorized: true });
    await post(w, ["qk2"], { ...ENV, STRIPE_SECRET_KEY_TEST: test });
    assertEquals(w.stripe, 0, `TEST key=${String(test)}`);
    assertEquals(ids(w), ["qk2"]); // dunning is still set up, as for any charge skipped without a key
  }
});
Deno.test("gh-3293 A: a REAL claim (is_test false) keeps the live key (positive control: the harness sees a live-key charge)", async () => {
  const w = world({ isTest: false }); await post(w, ["qk3"]);
  assert(w.stripe >= 1);
  assertEquals(w.stripeAuth.every((k) => k === "sk_live_REALKEY"), true, `keys used: ${w.stripeAuth.join(",")}`);
});
