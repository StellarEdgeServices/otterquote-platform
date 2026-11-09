// gh-3471 (#3427 D6) -- the covered-state check, driven through the REAL handler (index.ts) with Stripe, Supabase Auth and PostgREST answered by a stub `fetch`.
// This file deliberately imports ONLY index.ts (never guarantee-coverage.ts) and uses literal strings, so on main (no coverage code) it runs and FAILS on
// its assertions instead of failing to load.
// Pinned: covered state -> true; excluded state -> false; [] -> true; missing/blank/non-code state -> unknown (no column written) + alert; list not configured
// -> unknown, logged, NO alert; list read error / malformed list -> unknown + alert, order and clock kept; is_test / livemode=false / contractor -> no clock,
// no coverage and the list is never read (negative control); guarantee_covered column missing -> retry keeps the clock, drops only coverage, alerts.
// Run: deno test --allow-read=supabase/functions supabase/functions/create-measurement-order/guarantee-coverage-handler.test.ts
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const CLAIM = "66666666-7777-4888-8999-000000000000";
const OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PAID_UNIX = 1793000000;
const PAID_ISO = new Date(PAID_UNIX * 1000).toISOString();
const KEY = "guarantee_excluded_states";
const COVERAGE_ALERT = "guarantee_coverage_unknown";
const CLOCK_ALERT = "guarantee_clock_not_stored";

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
  /** the platform_settings guarantee_excluded_states row: a JSON value, "missing" (no row), or "fail" (the read returns an error) */
  excluded: Json;
  /** hover_orders POSTs carrying these columns are rejected as missing (PGRST204) */
  missingColumns: string[];
  claimFail?: boolean;
  hoverPosts: Json[];
  alerts: Json[];
  settingReads: string[];
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
  return {
    claim: { is_test: false, user_id: OWNER, property_state: "IN" },
    profile: { is_test: false, email: "homeowner@example.com" },
    pi: pi(),
    excluded: ["NY", "CA"],
    missingColumns: [],
    hoverPosts: [],
    alerts: [],
    settingReads: [],
    ...over,
  };
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
    const dbErr = () => new Response(JSON.stringify({ code: "XX000", message: "boom" }), { status: 500, headers: json });
    if (url.hostname === "api.stripe.com") return new Response(JSON.stringify(w.pi), { status: 200, headers: json });
    if (url.pathname === "/auth/v1/user") return new Response(JSON.stringify({ id: OWNER, aud: "authenticated" }), { status: 200, headers: json });
    if (url.pathname.startsWith("/functions/v1/")) return new Response("{}", { status: 200, headers: json });
    if (url.pathname.startsWith("/rest/v1/rpc/")) return new Response("false", { status: 200, headers: json });
    const table = url.pathname.replace("/rest/v1/", "");
    if (req.method === "GET") {
      if (table === "platform_settings") {
        const key = url.searchParams.get("key");
        w.settingReads.push(key ?? "");
        if (key === "eq.measurement_products") {
          return reply([{ value: { roof_basic: { homeowner_price_cents: 2263, active: true, rebate_on_close: false } } }], accept);
        }
        if (key === `eq.${KEY}`) {
          if (w.excluded === "fail") return dbErr();
          return reply(w.excluded === "missing" ? [] : [{ value: w.excluded }], accept);
        }
        return reply([], accept);
      }
      if (table === "claims") return w.claimFail ? dbErr() : reply([w.claim], accept);
      if (table === "profiles") return reply([w.profile], accept);
      return reply([], accept);
    }
    const body = await req.json().catch(() => null);
    if (table === "hover_orders") {
      w.hoverPosts.push(body);
      const missing = w.missingColumns.find((c) => body && c in body);
      if (missing) {
        return new Response(JSON.stringify({ code: "PGRST204", message: `Could not find the '${missing}' column of 'hover_orders' in the schema cache` }), { status: 400, headers: json });
      }
      return new Response(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", status: "awaiting_fulfillment" }), { status: 201, headers: json });
    }
    if (table === "platform_alerts_log") { w.alerts.push(body); return new Response(null, { status: 201 }); }
    return new Response(null, { status: 201 });
  }) as typeof fetch;
}

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
const coverageAlerts = (w: World) => w.alerts.filter((a) => a.alert_type === COVERAGE_ALERT);
const clockAlerts = (w: World) => w.alerts.filter((a) => a.alert_type === CLOCK_ALERT);
const listReads = (w: World) => w.settingReads.filter((k) => k === `eq.${KEY}`).length;

Deno.test("coverage: a COVERED state (IN, list NY/CA) records guarantee_covered = true beside the clock; no alert", quiet(async () => {
  const w = world();
  const r = await purchase(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts.length, 1);
  assertEquals(w.hoverPosts[0].guarantee_started_at, PAID_ISO, "the clock is still written");
  assertEquals(w.hoverPosts[0].guarantee_covered, true);
  assertEquals(listReads(w), 1, "the list is read once");
  assertEquals(w.alerts.length, 0);
}));

Deno.test("coverage: an EXCLUDED state records guarantee_covered = false (claim state normalised: ' ny ' and 'ca' match NY/CA); the order and clock stand", quiet(async () => {
  for (const s of [" ny ", "ca", "NY"]) {
    const w = world({ claim: { is_test: false, user_id: OWNER, property_state: s } });
    const r = await purchase(w);
    assertEquals(r.status, 200, s);
    assertEquals(w.hoverPosts.length, 1, s);
    assertEquals(w.hoverPosts[0].guarantee_covered, false, s);
    assertEquals(w.hoverPosts[0].guarantee_started_at, PAID_ISO, `${s}: an excluded state changes nothing about the payment or the clock`);
    assertEquals(w.alerts.length, 0, s);
  }
}));

Deno.test("coverage: an explicit EMPTY list [] means nothing is excluded -> true; list entries are space-trimmed and case-folded (' ny ' excludes NY)", quiet(async () => {
  const empty = world({ excluded: [] });
  await purchase(empty);
  assertEquals(empty.hoverPosts[0].guarantee_covered, true);
  const padded = world({ excluded: [" ny "], claim: { is_test: false, user_id: OWNER, property_state: "NY" } });
  await purchase(padded);
  assertEquals(padded.hoverPosts[0].guarantee_covered, false);
}));

Deno.test("coverage: a MISSING / blank / non-code property_state is UNKNOWN: no guarantee_covered written (NULL), the clock is kept, one coverage alert", quiet(async () => {
  for (const s of [null, "", "   ", "Indiana", "I"]) {
    const w = world({ claim: { is_test: false, user_id: OWNER, property_state: s } });
    const r = await purchase(w);
    assertEquals(r.status, 200, String(s));
    assertEquals(w.hoverPosts.length, 1, String(s));
    assertFalse("guarantee_covered" in w.hoverPosts[0], `${s}: unknown is never guessed`);
    assertEquals(w.hoverPosts[0].guarantee_started_at, PAID_ISO, `${s}: clock kept`);
    assertEquals(coverageAlerts(w).length, 1, `${s}: one coverage alert`);
    assertStringIncludes(coverageAlerts(w)[0].message, "no usable two-letter property_state");
    assertEquals(clockAlerts(w).length, 0, String(s));
  }
}));

Deno.test("coverage: the list NOT CONFIGURED yet (no platform_settings row; how this PR ships) -> unknown, logged, NO alert, clock kept", quiet(async () => {
  const w = world({ excluded: "missing" });
  const r = await purchase(w);
  assertEquals(r.status, 200);
  assertFalse("guarantee_covered" in w.hoverPosts[0]);
  assertEquals(w.hoverPosts[0].guarantee_started_at, PAID_ISO);
  assertEquals(listReads(w), 1);
  assertEquals(w.alerts.length, 0, "an unset list would alert on every order; it is logged instead");
  assert(logs.some((l) => l.includes("not configured yet")), `logged (${logs.join(" | ")})`);
}));

Deno.test("coverage FAIL-SAFE: the list read RETURNS AN ERROR -> HTTP 200, order recorded once with its clock, coverage unknown (NULL), one alert, logged", quiet(async () => {
  const w = world({ excluded: "fail" });
  const r = await purchase(w);
  assertEquals(r.status, 200, "a config read failure never blocks or fails a paid order");
  assertEquals(r.body.order_id, "11111111-2222-4333-8444-555555555555");
  assertEquals(w.hoverPosts.length, 1);
  assertFalse("guarantee_covered" in w.hoverPosts[0]);
  assertEquals(w.hoverPosts[0].guarantee_started_at, PAID_ISO);
  assertEquals(w.hoverPosts[0].homeowner_charge_amount, 2263, "the payment fields are untouched");
  assertEquals(coverageAlerts(w).length, 1);
  assertStringIncludes(coverageAlerts(w)[0].message, "could not be read");
  assert(logs.some((l) => l.includes("excluded-state list read failed")), `logged (${logs.join(" | ")})`);
}));

Deno.test("coverage FAIL-SAFE: a MALFORMED list (a typo, a non-array) is unusable as a whole -> unknown + alert; a typo never covers the mistyped state", quiet(async () => {
  for (const bad of [["NY", "Calif"], "NY,CA", { NY: true }, [1], ["NY", null]]) {
    const w = world({ excluded: bad, claim: { is_test: false, user_id: OWNER, property_state: "CA" } });
    const r = await purchase(w);
    assertEquals(r.status, 200, JSON.stringify(bad));
    assertFalse("guarantee_covered" in w.hoverPosts[0], `${JSON.stringify(bad)}: not covered on a typo, not excluded on a guess`);
    assertEquals(coverageAlerts(w).length, 1, JSON.stringify(bad));
    assertStringIncludes(coverageAlerts(w)[0].message, "not a JSON array of two-letter codes");
  }
}));

Deno.test("coverage: the claim read RETURNS AN ERROR -> clock kept (treated as real, as before), coverage unknown + alert", quiet(async () => {
  const w = world({ claimFail: true });
  const r = await purchase(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts[0].guarantee_started_at, PAID_ISO);
  assertFalse("guarantee_covered" in w.hoverPosts[0]);
  assertEquals(coverageAlerts(w).length, 1);
  assertStringIncludes(coverageAlerts(w)[0].message, "claim could not be read");
}));

Deno.test("coverage NEGATIVE CONTROL: is_test (claim, profile) and Stripe test mode get NO clock and NO coverage, and the list is never read", quiet(async () => {
  for (const w of [
    world({ claim: { is_test: true, user_id: OWNER, property_state: "IN" } }),
    world({ profile: { is_test: true, email: "x@example.com" } }),
    world({ pi: pi({ livemode: false }) }),
  ]) {
    const r = await purchase(w);
    assertEquals(r.status, 200);
    assertEquals(w.hoverPosts.length, 1);
    assertFalse("guarantee_started_at" in w.hoverPosts[0]);
    assertFalse("guarantee_covered" in w.hoverPosts[0]);
    assertEquals(listReads(w), 0, "no clock, no coverage check");
    assertEquals(w.alerts.length, 0);
  }
}));

Deno.test("coverage: a contractor-role order (no clock) and a real order whose payment time is unreadable (no clock) get no coverage and no list read", quiet(async () => {
  const c = world();
  await purchase(c, { buyer_role: "contractor", contractor_id: "cccccccc-0000-4000-8000-000000000001" });
  assertFalse("guarantee_covered" in c.hoverPosts[0]);
  assertEquals(listReads(c), 0);
  const u = world({ pi: pi({ latest_charge: null }) });
  await purchase(u);
  assertFalse("guarantee_covered" in u.hoverPosts[0]);
  assertEquals(listReads(u), 0);
  assertEquals(coverageAlerts(u).length, 0, "the clock alert covers that order");
  assertEquals(clockAlerts(u).length, 1);
}));

Deno.test("coverage: guarantee_covered column NOT APPLIED yet (PGRST204) -> retry drops ONLY guarantee_covered and KEEPS the clock; one coverage alert, no clock alert", quiet(async () => {
  const w = world({ missingColumns: ["guarantee_covered"] });
  const r = await purchase(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts.length, 2);
  assertEquals(w.hoverPosts[0].guarantee_covered, true);
  assertFalse("guarantee_covered" in w.hoverPosts[1]);
  assertEquals(w.hoverPosts[1].guarantee_started_at, PAID_ISO, "the clock survives the coverage retry");
  assertEquals(w.hoverPosts[1].homeowner_stripe_payment_intent_id, "pi_3Abc123");
  assertEquals(coverageAlerts(w).length, 1);
  assertStringIncludes(coverageAlerts(w)[0].message, "guarantee_covered was not stored");
  assertEquals(clockAlerts(w).length, 0);
}));

Deno.test("coverage: BOTH migrations missing -> the order is still recorded on the third try with neither clock nor coverage; one clock alert only", quiet(async () => {
  const w = world({ missingColumns: ["guarantee_covered", "guarantee_started_at"] });
  const r = await purchase(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts.length, 3);
  assertFalse("guarantee_covered" in w.hoverPosts[2] || "guarantee_started_at" in w.hoverPosts[2] || "guarantee_deadline_at" in w.hoverPosts[2]);
  assertEquals(clockAlerts(w).length, 1);
  assertEquals(coverageAlerts(w).length, 0);
}));

Deno.test("coverage: while the list is unset, the order payload carries NO new column (safe even if the function deploys before the migration)", quiet(async () => {
  const w = world({ excluded: "missing", missingColumns: ["guarantee_covered"] });
  const r = await purchase(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts.length, 1, "no rejected insert, no retry");
  assertEquals(w.alerts.length, 0);
}));
