// gh-2442 N-g (REVIEW 6277377025 / 6277504129): TRIGGER mode must ALWAYS set up dunning; only the Stripe charge loop is gated.
// Drives the REAL handler with a recording fetch stub (PostgREST + Stripe + vendors).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handler } from "./index.ts";

const KEY = "fixture-runtime-service-key-0123456789";
const BASE = "https://x.supabase.co/functions/v1/process-dunning";
const ENV: Record<string, string | undefined> = {
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY, DUNNING_RETRY_PASS_ENABLED: "true",
};
type Mode = { lease: "free" | "held" | "unreadable"; marker: "none" | "set" | "error"; leaseHolder?: { n: number } };

async function run(quote: string | string[], mode: Mode, log: { stripe: number; inserts: string[]; leaseTaken: number; leaseReleased: number; alerts: string[] }) {
  const real = globalThis.fetch;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url); const m = req.method;
    const single = (req.headers.get("accept") ?? "").includes("pgrst.object");
    const empty = () => json(single ? null : [], single ? 406 : 200);
    if (u.host === "api.stripe.com") {
      if (m === "POST") log.stripe++;
      return json({ error: { type: "card_error", code: "card_declined", message: "declined" } }, 402);
    }
    if (!u.pathname.startsWith("/rest/v1/")) return json({});
    const tb = u.pathname.split("/").pop()!;
    if (tb === "dunning_retry_pass_lease") {
      if (mode.lease === "unreadable") return json({ message: "relation does not exist" }, 404);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.holder) { if (mode.lease === "held") return json([]); log.leaseTaken++; return json([{ id: 1 }]); }
      log.leaseReleased++; return json([{ id: 1 }]);
    }
    if (tb === "platform_alerts_log" && m === "POST") { log.alerts.push(String(init?.body)); return json([]); }
    if (tb === "payment_failures" && m === "GET" && u.search.includes("retry_unknown_at")) {
      if (mode.marker === "error") return json({ message: "boom" }, 500);
      return json(mode.marker === "set" ? [{ id: "w1" }] : []);
    }
    if (tb === "payment_failures" && m === "POST") { const q = JSON.parse(String(init?.body)).quote_id ?? "?"; log.inserts.push(q); return json([{ id: "f-" + q, quote_id: q }]); }
    if (tb === "claims" && m === "GET") return json({ id: "cl1", is_test: false, live_charge_authorized_at: null, property_address: "1 Main" });
    if (tb === "contractors" && m === "GET") return json({ id: "c1", stripe_customer_id: "cus_1", company_name: "Co", timezone: "America/New_York", address_state: "IN", email: null, notification_emails: [], notification_phones: [], user_id: null });
    if (tb === "contractor_payment_methods" && m === "GET") return json([{ id: "cpm1", contractor_id: "c1", is_default: true, payment_type: "card", stripe_payment_method_id: "pm_1" }]);
    if (m === "GET") return empty();
    return json([{ id: "x" }]);
  }) as typeof fetch;
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_x");
  try {
    const quotes = Array.isArray(quote) ? quote : [quote];
    const results = await Promise.all(quotes.map(async (q) => {
      const res = await handler(new Request(BASE, {
        method: "POST", headers: { Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ quote_id: q, contractor_id: "c1", claim_id: "cl1", homeowner_id: null, amount_cents: 10000 }),
      }), (n) => ENV[n]);
      await res.text();
      return res;
    }));
    return results;
  } finally { globalThis.fetch = real; Deno.env.delete("STRIPE_SECRET_KEY"); }
}
const fresh = () => ({ stripe: 0, inserts: [] as string[], leaseTaken: 0, leaseReleased: 0, alerts: [] as string[] });

Deno.test("baseline: lease free, no marker -> charge loop runs AND dunning is set up; lease released", async () => {
  const log = fresh(); await run("qa", { lease: "free", marker: "none" }, log);
  assertEquals(log.stripe, 1); assertEquals(log.inserts, ["qa"]); assertEquals(log.leaseTaken, 1); assertEquals(log.leaseReleased >= 1, true);
});
Deno.test("in-doubt marker: dunning set up, NO Stripe charge, lease released, alert raised", async () => {
  const log = fresh(); await run("qb", { lease: "free", marker: "set" }, log);
  assertEquals(log.stripe, 0); assertEquals(log.inserts, ["qb"]); assertEquals(log.leaseTaken, log.leaseReleased);
  assert(log.alerts.some((a) => a.includes("dunning_trigger_skipped")));
});
Deno.test("lease held by the retry pass: dunning set up, NO Stripe charge", async () => {
  const log = fresh(); await run("qc", { lease: "held", marker: "none" }, log);
  assertEquals(log.stripe, 0); assertEquals(log.inserts, ["qc"]);
});
Deno.test("unreadable lease: dunning still set up, no charge, lease alert raised", async () => {
  const log = fresh(); await run("qd", { lease: "unreadable", marker: "none" }, log);
  assertEquals(log.stripe, 0); assertEquals(log.inserts, ["qd"]);
  assert(log.alerts.some((a) => a.includes("dunning_retry_lease_unreadable")));
});
Deno.test("marker read fails: dunning set up, no charge, whatever was taken is released", async () => {
  const log = fresh(); await run("qe", { lease: "free", marker: "error" }, log);
  assertEquals(log.stripe, 0); assertEquals(log.inserts, ["qe"]); assertEquals(log.leaseTaken, 1); assertEquals(log.leaseReleased >= 1, true);
});
Deno.test("two concurrent TRIGGERs for different quotes both set up dunning (one may be refused the charge, neither loses dunning)", async () => {
  const log = fresh();
  const res = await run(["q1", "q2"], { lease: "held", marker: "none" }, log);
  assertEquals(res.every((r) => r.status < 500), true); assertEquals([...log.inserts].sort(), ["q1", "q2"]); assertEquals(log.stripe, 0);
  const log2 = fresh();
  const res2 = await run(["q3", "q4"], { lease: "free", marker: "none" }, log2);
  assertEquals(res2.every((r) => r.status < 500), true); assertEquals([...log2.inserts].sort(), ["q3", "q4"]);
});
