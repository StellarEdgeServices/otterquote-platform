// gh-3471 -- the REAL handler (index.ts), driven end to end with Stripe, Supabase Auth and PostgREST answered by a stub `fetch`.
// Nothing here re-implements index.ts: it imports it. What these tests pin (each line was checked by deleting or flipping the code it names, results on #3471):
// the stored start/deadline; the is_test / livemode / contractor gates; the missing-column retry and its alerts (PGRST204, 42703); the no_payment_time alert;
// a claim or profile read that returns an error; the idempotent replay; the stripe_payment_id normalisation; the no-flag branch that serves. Not pinned: the optional
// is_internal_test_email rpc result (unit-tested in guarantee-clock.test.ts) and the exact text of the log lines.
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
  existing?: Json;
  claimFail?: boolean;
  profileFail?: boolean;
}
const logs: string[] = [];

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
      const dbErr = () => new Response(JSON.stringify({ code: "XX000", message: "boom" }), { status: 500, headers: json });
      if (table === "claims") return w.claimFail ? dbErr() : reply([w.claim], accept);
      if (table === "profiles") return w.profileFail ? dbErr() : reply([w.profile], accept);
      if (table === "hover_orders" && w.existing) return reply([w.existing], accept); // idempotency lookup finds the order
      return reply([], accept);
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

async function purchase(w: World, over: Json = {}): Promise<{ status: number; body: Json }> {
  install(w);
  try {
    const res = await handler(new Request("https://x.supabase.co/functions/v1/create-measurement-order", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json", Origin: "https://otterquote.com" },
      body: JSON.stringify({ claim_id: CLAIM, product_code: "roof_basic", payment_intent_id: "pi_3Abc123", buyer_role: "homeowner", ...over }),
    }));
    return { status: res.status, body: await res.json() };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const quiet = (fn: () => Promise<void>) => async () => {
  logs.length = 0;
  const e = console.error, l = console.log; console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); }; console.log = () => {};
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

const NO_CLOCK = (row: Json) => assertFalse("guarantee_started_at" in row || "guarantee_deadline_at" in row);
const clockAlerts = (w: World) => w.alerts.filter((a) => a.alert_type === "guarantee_clock_not_stored");

Deno.test("handler: a real order whose payment time is unreadable is RECORDED without a clock and raises exactly one no_payment_time alert; contractor and is_test raise none", quiet(async () => {
  for (const bad of [
    pi({ latest_charge: "ch_3Abc123" }), // not expanded
    pi({ latest_charge: null }),
    pi({ latest_charge: { id: "ch_1", status: "succeeded", paid: false, created: PAID_UNIX } }),
    pi({ latest_charge: { id: "ch_1", status: "succeeded", paid: true, created: Math.floor(Date.now() / 1000) + 3600 } }), // an hour ahead of the real clock
    pi({ latest_charge: { id: "ch_1", status: "succeeded", paid: true, created: 1e13 } }), // beyond Date's range: Invalid Date (F2)
  ]) {
    const w = world({ pi: bad });
    const r = await purchase(w);
    assertEquals(r.status, 200, "the order is recorded");
    assertEquals(w.hoverPosts.length, 1);
    NO_CLOCK(w.hoverPosts[0]);
    assertEquals(clockAlerts(w).length, 1, "one alert");
    assertStringIncludes(clockAlerts(w)[0].message, "Stripe did not show when the payment succeeded");
  }
  const unreadable = pi({ latest_charge: null });
  const contractor = world({ pi: unreadable });
  assertEquals((await purchase(contractor, { buyer_role: "contractor", contractor_id: "cccccccc-0000-4000-8000-000000000001" })).status, 200);
  NO_CLOCK(contractor.hoverPosts[0]);
  assertEquals(contractor.hoverPosts[0].requested_by_role, "contractor");
  assertEquals(contractor.alerts.length, 0, "a contractor order is not an alert");
  const test = world({ pi: unreadable, claim: { is_test: true, user_id: OWNER } });
  assertEquals((await purchase(test)).status, 200);
  assertEquals(test.alerts.length, 0, "a test order is not an alert");
  // a contractor-role order with a READABLE time also gets no clock
  const c2 = world();
  await purchase(c2, { buyer_role: "contractor", contractor_id: "cccccccc-0000-4000-8000-000000000001" });
  NO_CLOCK(c2.hoverPosts[0]);
}));

Deno.test("handler: charge.created beyond the Date range (1e13) -> HTTP 200, exactly one INSERT, exactly one alert (the order is never lost to a bad time)", quiet(async () => {
  const w = world({ pi: pi({ latest_charge: { id: "ch_1", status: "succeeded", paid: true, created: 1e13 } }) });
  const r = await purchase(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts.length, 1);
  assertEquals(w.alerts.length, 1);
  assertEquals(w.hoverPosts[0].stripe_payment_id, "ch_1");
}));

Deno.test("handler: a replay of an already-recorded PaymentIntent returns the existing order with idempotent:true and writes NOTHING", quiet(async () => {
  const w = world({ existing: { id: "99999999-2222-4333-8444-555555555555", status: "awaiting_fulfillment", product_code: "roof_basic" } });
  const r = await purchase(w);
  assertEquals(r.status, 200);
  assertEquals(r.body.idempotent, true);
  assertEquals(r.body.order_id, "99999999-2222-4333-8444-555555555555");
  assertEquals(w.hoverPosts.length, 0, "no second order, no restarted clock");
  assertEquals(w.alerts.length, 0);
}));

Deno.test("handler: a claim read or a profile read that RETURNS AN ERROR still records the order, keeps the clock (treated as real), and logs", quiet(async () => {
  for (const [name, over, line] of [
    ["claim", { claimFail: true }, "claim is_test lookup failed"],
    ["profile", { profileFail: true }, "profile test-flag lookup failed"],
  ] as const) {
    logs.length = 0;
    const w = world(over);
    const r = await purchase(w);
    assertEquals(r.status, 200, name);
    assertEquals(w.hoverPosts.length, 1, name);
    assertEquals(w.hoverPosts[0].guarantee_started_at, PAID_ISO, `${name}: a failed read counts as real`);
    assertEquals(w.alerts.length, 0, name);
    assert(logs.some((l) => l.includes(line)), `${name}: logged (${logs.join(" | ")})`);
  }
}));

Deno.test("module: WITHOUT the test flag, index.ts starts the server (the production branch); WITH it, it only exposes the handler", quiet(async () => {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const realListen = Deno.listen;
  const listens: unknown[] = [];
  // deno-lint-ignore no-explicit-any
  (Deno as any).listen = (opts: unknown) => { listens.push(opts); return { addr: { transport: "tcp", hostname: "0.0.0.0", port: 8000 }, accept: () => new Promise(() => {}), close() {}, [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }; };
  const flag = g.__OQ_NO_SERVE;
  try {
    g.__OQ_NO_SERVE = true;
    await import("./index.ts?withflag");
    assertEquals(listens.length, 0, "flag set: nothing listens");
    delete g.__OQ_NO_SERVE;
    await import("./index.ts?noflag");
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(listens.length, 1, "no flag: the server starts");
  } finally {
    g.__OQ_NO_SERVE = flag;
    // deno-lint-ignore no-explicit-any
    (Deno as any).listen = realListen;
  }
}));
