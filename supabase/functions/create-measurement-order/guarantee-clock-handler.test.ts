// gh-3471 -- the REAL handler (index.ts), driven end to end with Stripe, Supabase Auth and PostgREST answered by a stub `fetch`.
// Nothing here re-implements index.ts: it imports it. A change to index.ts that breaks the clock, the retry or the alert fails a test below.
// Run: deno test --allow-read=supabase/functions supabase/functions/create-measurement-order/guarantee-clock-handler.test.ts
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const CLAIM = "66666666-7777-4888-8999-000000000000";
const OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PAID_UNIX = 1793000000;
const PAID_ISO = new Date(PAID_UNIX * 1000).toISOString();
const DEADLINE_ISO = new Date(PAID_UNIX * 1000 + 100 * 3_600_000).toISOString();

// index.ts reads its environment through Deno.env; give it test values without needing --allow-env.
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  SUPABASE_ANON_KEY: "anon",
  STRIPE_SECRET_KEY: "sk_test_dummy",
};
// deno-lint-ignore no-explicit-any
(Deno.env as any).get = (k: string) => ENV[k];
// deno-lint-ignore no-explicit-any
(globalThis as any).__OQ_NO_SERVE = true;
const realFetch = globalThis.fetch;

// deno-lint-ignore no-explicit-any
type Json = any;
interface World {
  claim: Json;
  profile: Json;
  pi: Json;
  /** how POSTs to hover_orders that CARRY the clock columns are answered */
  clockInsert: "ok" | "PGRST204" | "42703";
  hoverPosts: Json[];
  alerts: Json[];
}

function pi(over: Json = {}): Json {
  return {
    id: "pi_3Abc123", status: "succeeded", currency: "usd", amount: 2263, livemode: true, created: PAID_UNIX - 90,
    metadata: { type: "hover_measurement", claim_id: CLAIM },
    latest_charge: { id: "ch_3Abc123", object: "charge", status: "succeeded", paid: true, created: PAID_UNIX },
    ...over,
  };
}
function world(over: Partial<World> = {}): World {
  return { claim: { is_test: false, user_id: OWNER }, profile: { is_test: false, email: "homeowner@example.com" }, pi: pi(), clockInsert: "ok", hoverPosts: [], alerts: [], ...over };
}

function reply(rows: Json[], accept: string): Response {
  if (accept.includes("vnd.pgrst.object+json")) {
    return rows.length === 1
      ? new Response(JSON.stringify(rows[0]), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify({ code: "PGRST116", message: "The result contains 0 rows" }), { status: 406, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
}

function install(w: World) {
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input as Request | string, init);
    const url = new URL(req.url);
    const accept = req.headers.get("accept") ?? "";
    const json = { "Content-Type": "application/json" };
    if (url.hostname === "api.stripe.com") {
      assertStringIncludes(url.search, "expand%5B%5D=latest_charge");
      return new Response(JSON.stringify(w.pi), { status: 200, headers: json });
    }
    if (url.pathname === "/auth/v1/user") return new Response(JSON.stringify({ id: OWNER, aud: "authenticated" }), { status: 200, headers: json });
    if (url.pathname.startsWith("/functions/v1/")) return new Response("{}", { status: 200, headers: json });
    if (url.pathname.startsWith("/rest/v1/rpc/")) return new Response("false", { status: 200, headers: json });
    const table = url.pathname.replace("/rest/v1/", "");
    if (req.method === "GET") {
      if (table === "platform_settings") {
        const key = url.searchParams.get("key");
        return reply(key === "eq.measurement_products" ? [{ value: { roof_basic: { homeowner_price_cents: 2263, active: true, rebate_on_close: false } } }] : [], accept);
      }
      if (table === "claims") return reply([w.claim], accept);
      if (table === "profiles") return reply([w.profile], accept);
      return reply([], accept); // hover_orders idempotency lookup etc.: no existing row
    }
    const body = await req.json().catch(() => null);
    if (table === "hover_orders") {
      w.hoverPosts.push(body);
      if (body && "guarantee_started_at" in body && w.clockInsert !== "ok") {
        const err = w.clockInsert === "PGRST204"
          ? { code: "PGRST204", message: "Could not find the 'guarantee_started_at' column of 'hover_orders' in the schema cache", details: null, hint: null }
          : { code: "42703", message: 'column "guarantee_started_at" of relation "hover_orders" does not exist', details: null, hint: null };
        return new Response(JSON.stringify(err), { status: 400, headers: json });
      }
      return new Response(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", status: "awaiting_fulfillment" }), { status: 201, headers: json });
    }
    if (table === "platform_alerts_log") { w.alerts.push(body); return new Response(null, { status: 201 }); }
    return new Response(null, { status: 201 }); // activity_log and anything else
  }) as typeof fetch;
}

// deno-lint-ignore no-explicit-any
await import("./index.ts");
// deno-lint-ignore no-explicit-any
const handler = (globalThis as any).__oqCreateMeasurementOrderHandler as (r: Request) => Promise<Response>;

async function purchase(w: World): Promise<{ status: number; body: Json }> {
  install(w);
  try {
    const res = await handler(new Request("https://x.supabase.co/functions/v1/create-measurement-order", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json", Origin: "https://otterquote.com" },
      body: JSON.stringify({ claim_id: CLAIM, product_code: "roof_basic", payment_intent_id: "pi_3Abc123", buyer_role: "homeowner" }),
    }));
    return { status: res.status, body: await res.json() };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const quiet = (fn: () => Promise<void>) => async () => {
  const e = console.error, l = console.log; console.error = () => {}; console.log = () => {};
  try { await fn(); } finally { console.error = e; console.log = l; }
};

Deno.test("handler: a NON-TEST hover_measurement payment writes guarantee_started_at = the charge time and a deadline exactly 100 hours later, and keeps stripe_payment_id a string", quiet(async () => {
  const w = world();
  const r = await purchase(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts.length, 1);
  const row = w.hoverPosts[0];
  assertEquals(row.guarantee_started_at, PAID_ISO);
  assertEquals(row.guarantee_deadline_at, DEADLINE_ISO);
  assertEquals(Date.parse(row.guarantee_deadline_at) - Date.parse(row.guarantee_started_at), 360_000_000);
  assertEquals(row.stripe_payment_id, "ch_3Abc123", "latest_charge was expanded to an object; the column must still get the id STRING");
  assertEquals(typeof row.stripe_payment_id, "string");
  assertEquals(w.alerts.length, 0);
}));

Deno.test("handler NEGATIVE CONTROL: the same payment on an is_test order writes neither field", quiet(async () => {
  for (const w of [
    world({ claim: { is_test: true, user_id: OWNER } }),
    world({ profile: { is_test: true, email: "x@example.com" } }),
    world({ pi: pi({ livemode: false }) }),
  ]) {
    const r = await purchase(w);
    assertEquals(r.status, 200);
    assertEquals(w.hoverPosts.length, 1);
    assertFalse("guarantee_started_at" in w.hoverPosts[0]);
    assertFalse("guarantee_deadline_at" in w.hoverPosts[0]);
    assertEquals(w.alerts.length, 0, "a test order is not an alert");
  }
}));

Deno.test("handler: columns not applied yet (PostgREST PGRST204 or Postgres 42703) -> the paid order is STILL recorded without the clock, and the column_missing alert is raised", quiet(async () => {
  for (const code of ["PGRST204", "42703"] as const) {
    const w = world({ clockInsert: code });
    const r = await purchase(w);
    assertEquals(r.status, 200, `${code}: the buyer is not told the order failed`);
    assertEquals(r.body.order_id, "11111111-2222-4333-8444-555555555555");
    assertEquals(w.hoverPosts.length, 2, `${code}: first insert (rejected) then the retry`);
    assert("guarantee_started_at" in w.hoverPosts[0]);
    assertFalse("guarantee_started_at" in w.hoverPosts[1] || "guarantee_deadline_at" in w.hoverPosts[1]);
    assertEquals(w.hoverPosts[1].homeowner_stripe_payment_intent_id, "pi_3Abc123", "the PaymentIntent id is never dropped");
    assertEquals(w.hoverPosts[1].stripe_payment_id, "ch_3Abc123");
    assertEquals(w.alerts.length, 1, `${code}: one alert`);
    assertEquals(w.alerts[0].alert_type, "guarantee_clock_not_stored");
    assertStringIncludes(w.alerts[0].message, "clock columns are not in this database yet");
  }
}));

Deno.test("handler: an unrelated insert error still fails loudly (no silent retry), and the buyer is told not to pay again", quiet(async () => {
  const w = world();
  // an error code that is not a missing column: answer every hover_orders POST with a unique violation
  install(w);
  const stub = globalThis.fetch;
  globalThis.fetch = (async (i: Request | URL | string, init?: RequestInit) => {
    const req = new Request(i as Request | string, init);
    if (new URL(req.url).pathname.endsWith("/hover_orders") && req.method === "POST") {
      w.hoverPosts.push(await req.json());
      return new Response(JSON.stringify({ code: "23505", message: "duplicate" }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    return stub(i, init);
  }) as typeof fetch;
  const res = await handler(new Request("https://x.supabase.co/f", {
    method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json", Origin: "https://otterquote.com" },
    body: JSON.stringify({ claim_id: CLAIM, product_code: "roof_basic", payment_intent_id: "pi_3Abc123", buyer_role: "homeowner" }),
  }));
  globalThis.fetch = realFetch;
  assertEquals(res.status, 500);
  assertEquals(w.hoverPosts.length, 1, "no retry for an unrelated error");
  assertEquals((await res.json()).payment_captured, true);
}));
