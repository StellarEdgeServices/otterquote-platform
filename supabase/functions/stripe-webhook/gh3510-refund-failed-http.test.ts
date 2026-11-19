// gh-3510 (Refs #3510): a Stripe refund-failure event sent through the stripe-webhook REQUEST HANDLER.
// gh3510-refund-failed.test.ts calls handleSwitchRefundFailed directly; this file closes the remaining gap by driving
// the real handler registered by index.ts: signature verification -> event ledger insert -> dispatch -> alert row.
//
// No network and no real secrets. index.ts calls Deno.serve() at import time and does not export its handler, so the
// test (1) replaces Deno.serve for the duration of the import to capture the handler, (2) replaces Deno.env.get so the
// signing secret is a throwaway value (the CI step runs `deno test` without --allow-env), and (3) replaces
// globalThis.fetch with an in-memory PostgREST fake, which is what the real supabase-js client talks to. Nothing in
// index.ts is changed.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const TEST_SECRET = "whsec_test_gh3510_throwaway_not_a_real_secret";
const SB_URL = "https://fake-gh3510.supabase.test";
const TEST_ENV: Record<string, string> = {
  STRIPE_WEBHOOK_SIGNING_SECRET: TEST_SECRET,
  SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key-gh3510",
};

// ---- capture the handler index.ts registers with Deno.serve ----------------------------------------------------
// deno-lint-ignore no-explicit-any
const denoAny = Deno as any;
const realServe = denoAny.serve;
let handler: ((req: Request) => Promise<Response>) | undefined;
denoAny.serve = (...args: unknown[]) => {
  const h = args.find((a) => typeof a === "function");
  handler = h as typeof handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {}, addr: {} };
};
// deno-lint-ignore no-explicit-any
(Deno.env as any).get = (k: string) => (k in TEST_ENV ? TEST_ENV[k] : undefined);
try {
  // Non-literal specifier on purpose: index.ts has pre-existing supabase-js type errors (`deno check` reports 26), and a
  // literal import would make `deno test` type-check it and fail before any test runs. Supabase does not type-check at deploy.
  await import(new URL("./index.ts", import.meta.url).href);
} finally {
  denoAny.serve = realServe;
}
assert(handler, "index.ts did not register a Deno.serve handler");
const handle = handler!;

// ---- in-memory PostgREST fake (the wire protocol supabase-js speaks) -------------------------------------------
interface Db {
  ledger: { event_id: string; event_type: string }[];
  alerts: Record<string, unknown>[];
  otherWrites: string[];
  fetchCalls: number;
}
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}
function installFakeFetch(db: Db) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    db.fetchCalls++;
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    assert(url.origin === SB_URL, `unexpected outbound call to ${url.origin}`); // nothing but the fake Supabase host
    const table = url.pathname.replace("/rest/v1/", "");
    const wantsObject = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    return (async () => {
      if (req.method === "POST") {
        const row = await req.json();
        if (table === "stripe_webhook_events") {
          if (db.ledger.some((r) => r.event_id === row.event_id)) {
            return json({ code: "23505", message: "duplicate key value violates unique constraint", details: "", hint: "" }, 409);
          }
          db.ledger.push(row);
          return json(null, 201);
        }
        if (table === "platform_alerts_log") { db.alerts.push(row); return json(null, 201); }
        db.otherWrites.push(`POST ${table}`);
        return json(null, 201);
      }
      if (req.method === "DELETE") {
        if (table === "stripe_webhook_events") {
          const id = (url.searchParams.get("event_id") ?? "").replace(/^eq\./, "");
          db.ledger = db.ledger.filter((r) => r.event_id !== id);
          return json(null, 204);
        }
        db.otherWrites.push(`DELETE ${table}`);
        return json(null, 204);
      }
      if (req.method === "GET") {
        if (table === "platform_alerts_log") {
          const type = (url.searchParams.get("alert_type") ?? "").replace(/^eq\./, "");
          const needle = (url.searchParams.get("message") ?? "").replace(/^like\./, "").replaceAll("%", "");
          const rows = db.alerts.filter((a) => a.alert_type === type && String(a.message).includes(needle)).map(() => ({ id: "a" }));
          return json(rows);
        }
        if (table === "quotes") {
          const row = { id: "q-http-1", claim_id: "c-http-1" };
          return wantsObject ? json(row) : json([row]);
        }
        return json([]);
      }
      db.otherWrites.push(`${req.method} ${table}`);
      return json(null, 204);
    })();
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

// ---- helpers ---------------------------------------------------------------------------------------------------
async function sign(body: string, ts = Math.floor(Date.now() / 1000), secret = TEST_SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`)));
  return `t=${ts},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function post(body: string, sig: string) {
  return new Request(`${SB_URL}/functions/v1/stripe-webhook`, { method: "POST", body, headers: { "stripe-signature": sig, "content-type": "application/json" } });
}
function refundEvent(opts: { eventId: string; type?: string; refundId?: string; metadata?: Record<string, string> }) {
  return JSON.stringify({
    id: opts.eventId,
    object: "event",
    type: opts.type ?? "refund.failed",
    livemode: false,
    data: {
      object: {
        id: opts.refundId ?? "re_http_1",
        object: "refund",
        status: "failed",
        amount: 17500,
        payment_intent: "pi_http_1",
        charge: "ch_http_1",
        failure_reason: "expired_or_canceled_card",
        metadata: opts.metadata ?? { reason: "homeowner_switched_contractor" },
      },
    },
  });
}
async function run(db: Db, req: Request) {
  const restore = installFakeFetch(db);
  const log = console.log, err = console.error, warn = console.warn;
  console.log = console.error = console.warn = () => {}; // keep the handler's logs out of test output
  try { return await handle(req); } finally { console.log = log; console.error = err; console.warn = warn; restore(); }
}
const newDb = (): Db => ({ ledger: [], alerts: [], otherWrites: [], fetchCalls: 0 });

// ---- tests -----------------------------------------------------------------------------------------------------
Deno.test("gh-3510 http: correctly signed refund.failed for a switch refund returns 200 and writes exactly one switch_refund_failed alert naming the refund", async () => {
  const db = newDb();
  const body = refundEvent({ eventId: "evt_http_a" });
  const res = await run(db, post(body, await sign(body)));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).received, true);
  assertEquals(db.ledger.map((r) => r.event_id), ["evt_http_a"]);
  const alerts = db.alerts.filter((a) => a.alert_type === "switch_refund_failed");
  assertEquals(alerts.length, 1);
  const m = String(alerts[0].message);
  assert(m.includes("refund re_http_1 ") && m.includes("OPS: refund FAILED") && m.includes("claim c-http-1") && m.includes("quote q-http-1"));
  assertEquals(db.otherWrites, []);
});

Deno.test("gh-3510 http: the same body with a wrong signature returns 400 with no ledger row and no alert row", async () => {
  const db = newDb();
  const body = refundEvent({ eventId: "evt_http_b" });
  const badSecret = await sign(body, undefined, "whsec_some_other_secret");
  const tampered = (await sign(body)).replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  const stale = await sign(body, Math.floor(Date.now() / 1000) - 3600);
  for (const sig of [badSecret, tampered, stale]) {
    const res = await run(db, post(body, sig));
    assertEquals(res.status, 400);
  }
  assertEquals((await run(db, new Request(`${SB_URL}/f`, { method: "POST", body }))).status, 400); // no header at all
  assertEquals(db.ledger, []);
  assertEquals(db.alerts, []);
  assertEquals(db.fetchCalls, 0); // rejected before any database call
});

Deno.test("gh-3510 http: a correctly signed failed refund that is not a switch refund writes no switch_refund_failed alert", async () => {
  const db = newDb();
  const body = refundEvent({ eventId: "evt_http_c", refundId: "re_http_other", metadata: { reason: "requested_by_customer" } });
  const res = await run(db, post(body, await sign(body)));
  assertEquals(res.status, 200);
  assertEquals(db.ledger.length, 1); // the event is still recorded in the ledger
  assertEquals(db.alerts.filter((a) => a.alert_type === "switch_refund_failed"), []);
  assertEquals(db.alerts, []);
});

Deno.test("gh-3510 http: the same signed event delivered twice produces one alert (ledger duplicate is acknowledged, not re-processed)", async () => {
  const db = newDb();
  const body = refundEvent({ eventId: "evt_http_d" });
  const sig = await sign(body);
  const first = await run(db, post(body, sig));
  const second = await run(db, post(body, sig));
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals((await second.json()).duplicate, true);
  assertEquals(db.ledger.length, 1);
  assertEquals(db.alerts.filter((a) => a.alert_type === "switch_refund_failed").length, 1);
});

Deno.test("gh-3510 http: the same failure arriving as a different event (charge.refund.updated, new event id) still produces one alert", async () => {
  const db = newDb();
  const b1 = refundEvent({ eventId: "evt_http_e1" });
  const b2 = refundEvent({ eventId: "evt_http_e2", type: "charge.refund.updated" });
  assertEquals((await run(db, post(b1, await sign(b1)))).status, 200);
  assertEquals((await run(db, post(b2, await sign(b2)))).status, 200);
  assertEquals(db.ledger.length, 2);
  assertEquals(db.alerts.filter((a) => a.alert_type === "switch_refund_failed").length, 1);
});
