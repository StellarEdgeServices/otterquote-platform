// gh-3857 (Refs #3857, residual of #3356): the homeowner's measurement charge is two requests (card confirmed, then the browser writes the
// hover_orders row). This drives the REAL stripe-webhook handler with a signed payment_intent.succeeded for a measurement PaymentIntent
// where the second request FAILED (no hover_orders row exists) and asserts the paid PaymentIntent still ends with an alert that names it.
// Negative control: the same file run against main's index.ts (without the reconcile call) fails the "alert names the PaymentIntent" test.
//
// No network and no real secrets: same harness as gh3510-refund-failed-http.test.ts (Deno.serve captured, Deno.env.get patched,
// globalThis.fetch replaced by an in-memory PostgREST fake that also records the one outbound email call).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const TEST_SECRET = "whsec_test_gh3857_throwaway_not_a_real_secret";
const SB_URL = "https://fake-gh3857.supabase.test";
const TEST_ENV: Record<string, string> = {
  STRIPE_WEBHOOK_SIGNING_SECRET: TEST_SECRET,
  SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key-gh3857",
};
const PI = "pi_3Gh3857Reconcile";
const CLAIM = "11111111-2222-3333-4444-555555555555";

// deno-lint-ignore no-explicit-any
const denoAny = Deno as any;
const realServe = denoAny.serve;
let handler: ((req: Request) => Promise<Response>) | undefined;
denoAny.serve = (...args: unknown[]) => {
  handler = args.find((a) => typeof a === "function") as typeof handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {}, addr: {} };
};
// deno-lint-ignore no-explicit-any
(Deno.env as any).get = (k: string) => (k in TEST_ENV ? TEST_ENV[k] : undefined);
try {
  await import(new URL("./index.ts", import.meta.url).href); // non-literal on purpose, as in gh3510 (index.ts has pre-existing type errors)
} finally {
  denoAny.serve = realServe;
}
assert(handler, "index.ts did not register a Deno.serve handler");
const handle = handler!;

interface Db {
  ledger: { event_id: string; event_type: string }[];
  alerts: Record<string, unknown>[];
  orders: { id: string; homeowner_stripe_payment_intent_id: string }[];
  emails: Record<string, unknown>[];
  emailStatus: number;
  alertInsertFails: boolean;
  otherWrites: string[];
}
const newDb = (): Db => ({ ledger: [], alerts: [], orders: [], emails: [], emailStatus: 200, alertInsertFails: false, otherWrites: [] });
function json(body: unknown, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function installFakeFetch(db: Db) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    assert(url.origin === SB_URL, `unexpected outbound call to ${url.origin}`);
    return (async () => {
      if (url.pathname === "/functions/v1/notify-measurement-order") {
        db.emails.push(await req.json());
        return json({ ok: true }, db.emailStatus);
      }
      const table = url.pathname.replace("/rest/v1/", "");
      if (req.method === "POST") {
        const row = await req.json();
        if (table === "stripe_webhook_events") {
          if (db.ledger.some((r) => r.event_id === row.event_id)) return json({ code: "23505", message: "duplicate", details: "", hint: "" }, 409);
          db.ledger.push(row);
          return json(null, 201);
        }
        if (table === "platform_alerts_log") {
          if (db.alertInsertFails) return json({ code: "XX000", message: "boom", details: "", hint: "" }, 500);
          db.alerts.push(row);
          return json(null, 201);
        }
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
        if (table === "hover_orders") {
          const pi = (url.searchParams.get("homeowner_stripe_payment_intent_id") ?? "").replace(/^eq\./, "");
          return json(db.orders.filter((o) => o.homeowner_stripe_payment_intent_id === pi).map((o) => ({ id: o.id })));
        }
        if (table === "platform_alerts_log") {
          const type = (url.searchParams.get("alert_type") ?? "").replace(/^eq\./, "");
          const needle = (url.searchParams.get("message") ?? "").replace(/^i?like\./, "").replaceAll("%", "");
          return json(db.alerts.filter((a) => a.alert_type === type && String(a.message).includes(needle)).map(() => ({ id: "a" })));
        }
        return json([]); // claims, profiles, quotes etc: nothing found, so the CAPI and platform-fee handlers no-op
      }
      db.otherWrites.push(`${req.method} ${table}`);
      return json(null, 204);
    })();
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

async function sign(body: string, ts = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TEST_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`)));
  return `t=${ts},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function piEvent(eventId: string, type = "hover_measurement", id = PI) {
  return JSON.stringify({
    id: eventId, object: "event", type: "payment_intent.succeeded", livemode: false,
    data: { object: { id, object: "payment_intent", status: "succeeded", amount: 2263, amount_received: 2263, currency: "usd", livemode: false, metadata: { type, claim_id: CLAIM } } },
  });
}
async function run(db: Db, body: string) {
  const restore = installFakeFetch(db);
  const log = console.log, err = console.error, warn = console.warn;
  console.log = console.error = console.warn = () => {};
  // The reconcile pauses 2.5-3.5 s between reads; make exactly those pauses instant (other timers, e.g. fetch abort guards, run normally).
  const realSet = globalThis.setTimeout;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = (fn: () => void, ms?: number) => (ms !== undefined && ms >= 2500 && ms <= 3500 ? realSet(fn, 0) : realSet(fn, ms));
  try {
    return await handle(new Request(`${SB_URL}/functions/v1/stripe-webhook`, { method: "POST", body, headers: { "stripe-signature": await sign(body), "content-type": "application/json" } }));
  } finally {
    globalThis.setTimeout = realSet; console.log = log; console.error = err; console.warn = warn; restore();
  }
}

Deno.test("gh-3857: the order request failed (no hover_orders row): the paid PaymentIntent still ends with an alert that names it, and an admin email", async () => {
  const db = newDb();
  const res = await run(db, piEvent("evt_3857_a"));
  assertEquals(res.status, 200);
  const alerts = db.alerts.filter((a) => a.alert_type === "measurement_paid_without_order");
  assertEquals(alerts.length, 1, "a charge with no order row must raise exactly one alert");
  const m = String(alerts[0].message);
  assert(m.includes(PI) && m.includes(CLAIM) && m.includes("NO hover_orders row"));
  assertEquals(alerts[0].function_name, "stripe-webhook");
  assertEquals(db.emails, [{ alert: "measurement_paid_gate", kind: "paid_without_order", claim_id: CLAIM, payment_intent_id: PI, stage: "stripe webhook reconcile" }]);
  assertEquals(db.orders, []); // it writes no order itself
  assertEquals(db.otherWrites, []);
});

Deno.test("gh-3857: a normal success (the order row exists) raises no alert, sends no email and writes nothing: no second row", async () => {
  const db = newDb();
  db.orders.push({ id: "o1", homeowner_stripe_payment_intent_id: PI });
  const res = await run(db, piEvent("evt_3857_b"));
  assertEquals(res.status, 200);
  assertEquals(db.alerts, []);
  assertEquals(db.emails, []);
  assertEquals(db.orders.length, 1);
  assertEquals(db.otherWrites, []);
});

Deno.test("gh-3857: the same PaymentIntent delivered again as a new event inside 24 h raises no second alert", async () => {
  const db = newDb();
  assertEquals((await run(db, piEvent("evt_3857_c1"))).status, 200);
  assertEquals((await run(db, piEvent("evt_3857_c2"))).status, 200);
  assertEquals(db.alerts.length, 1);
  assertEquals(db.emails.length, 1);
});

Deno.test("gh-3857: a payment_intent.succeeded that is not a measurement purchase is left alone", async () => {
  const db = newDb();
  const res = await run(db, piEvent("evt_3857_d", "platform_fee", "pi_3Gh3857Other"));
  assertEquals(res.status, 200);
  assertEquals(db.alerts, []);
  assertEquals(db.emails, []);
});

Deno.test("gh-3857: the alert email failing still leaves the named alert row and answers 200", async () => {
  const db = newDb();
  db.emailStatus = 500;
  const res = await run(db, piEvent("evt_3857_e"));
  assertEquals(res.status, 200);
  assertEquals(db.alerts.length, 1);
});

Deno.test("gh-3857: neither alert channel took it: 500 and the ledger row is freed so the redelivery re-runs the check", async () => {
  const db = newDb();
  db.emailStatus = 500;
  db.alertInsertFails = true;
  const res = await run(db, piEvent("evt_3857_f"));
  assertEquals(res.status, 500);
  assertEquals(db.ledger, []);
  assertEquals(db.alerts, []);
});
