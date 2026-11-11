// gh-3459 (CLOSE-REVIEW: FAIL 6740291401, DECIDED Tier A on #3459): a paid detailed-measurement upgrade must be recorded against the
// contractor the VERIFIED PaymentIntent was minted for (`metadata.contractor_id`, which create-payment-intent sets only after checking that
// the caller owns that contractor), falling back to the claim's awarded contractor (`claims.selected_contractor_id`), never against whoever
// happens to call this function. Before this, a second signed-in account holding the PaymentIntent id could record the order with a NULL
// (or its own) contractor id, and create-payment-intent's per-contractor duplicate gate then minted a second charge for the contractor who paid.
//
// This drives the REAL handler (index.ts) with Stripe, Supabase Auth and PostgREST answered by a stub `fetch`, same harness as
// guarantee-clock-handler.test.ts. The caller here is a DIFFERENT account from the contractor who paid.
// Run: deno test --allow-read=supabase/functions supabase/functions/create-measurement-order/upgrade-contractor-from-pi.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const CLAIM = "66666666-7777-4888-8999-000000000000";
/** The contractor who paid: the id create-payment-intent wrote into the PaymentIntent's metadata. */
const PAYING_CONTRACTOR = "cccccccc-1111-4222-8333-444444444444";
/** The claim's awarded contractor, used only when the PaymentIntent names none. */
const AWARDED_CONTRACTOR = "cccccccc-5555-4222-8333-444444444444";
/** A contractor account owned by the second (recording) account. */
const OTHER_CONTRACTOR = "cccccccc-9999-4222-8333-444444444444";
/** The signed-in account that calls create-measurement-order. Not the payer. */
const OTHER_ACCOUNT = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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
  piMetadata: Json;
  claim: Json;
  hoverPosts: Json[];
  alerts: Json[];
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
      return new Response(JSON.stringify({
        id: "pi_3Upg123", status: "succeeded", currency: "usd", amount: 2500, livemode: true,
        metadata: w.piMetadata, latest_charge: "ch_3Upg123",
      }), { status: 200, headers: json });
    }
    if (url.pathname === "/auth/v1/user") return new Response(JSON.stringify({ id: OTHER_ACCOUNT, aud: "authenticated" }), { status: 200, headers: json });
    if (url.pathname.startsWith("/functions/v1/")) return new Response("{}", { status: 200, headers: json });
    if (url.pathname.startsWith("/rest/v1/rpc/")) return new Response("false", { status: 200, headers: json });
    const table = url.pathname.replace("/rest/v1/", "");
    if (req.method === "GET") {
      if (table === "claims") return reply([w.claim], accept);
      return reply([], accept); // no prior hover_orders row: first record of this PaymentIntent, first buyer
    }
    const body = await req.json().catch(() => null);
    if (table === "hover_orders") {
      w.hoverPosts.push(body);
      return new Response(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", status: "awaiting_fulfillment" }), { status: 201, headers: json });
    }
    if (table === "platform_alerts_log") { w.alerts.push(body); return new Response(null, { status: 201 }); }
    return new Response(null, { status: 201 });
  }) as typeof fetch;
}

await import("./index.ts");
// deno-lint-ignore no-explicit-any
const handler = (globalThis as any).__oqCreateMeasurementOrderHandler as (r: Request) => Promise<Response>;

function world(over: Partial<World> = {}): World {
  return {
    piMetadata: { type: "measurement_upgrade", claim_id: CLAIM, contractor_id: PAYING_CONTRACTOR, vendor_credit_expected_cents: "1500" },
    claim: { id: CLAIM, selected_contractor_id: AWARDED_CONTRACTOR },
    hoverPosts: [],
    alerts: [],
    ...over,
  };
}

async function record(w: World, over: Json = {}): Promise<{ status: number; body: Json }> {
  install(w);
  const e = console.error, l = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    const res = await handler(new Request("https://x.supabase.co/functions/v1/create-measurement-order", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json", Origin: "https://otterquote.com" },
      body: JSON.stringify({ claim_id: CLAIM, product_code: "roof_upgrade_detailed", payment_intent_id: "pi_3Upg123", ...over }),
    }));
    return { status: res.status, body: await res.json() };
  } finally {
    globalThis.fetch = realFetch;
    console.error = e;
    console.log = l;
  }
}

Deno.test("gh-3459: a DIFFERENT account records a paid upgrade with no role and no contractor id -- the order carries the PaymentIntent's contractor, not NULL (fails before the fix)", async () => {
  const w = world();
  const r = await record(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts.length, 1);
  assertEquals(w.hoverPosts[0].requested_by_contractor_id, PAYING_CONTRACTOR);
  // The recorder is still who it was; only the contractor key changed.
  assertEquals(w.hoverPosts[0].user_id, OTHER_ACCOUNT);
  // The role decision is unchanged: no client role and no client contractor id is still 'unspecified', with its alert.
  assertEquals(w.hoverPosts[0].requested_by_role, "unspecified");
  assertEquals(w.alerts.length, 1);
});

Deno.test("gh-3459: a DIFFERENT account sends its OWN contractor id -- the order still carries the contractor the PaymentIntent was minted for (fails before the fix)", async () => {
  const w = world();
  const r = await record(w, { buyer_role: "contractor", contractor_id: OTHER_CONTRACTOR });
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts[0].requested_by_contractor_id, PAYING_CONTRACTOR);
  assertEquals(w.hoverPosts[0].requested_by_role, "contractor");
});

Deno.test("gh-3459: fallback -- a PaymentIntent with no contractor_id is recorded against the claim's awarded contractor (fails before the fix)", async () => {
  const w = world({ piMetadata: { type: "measurement_upgrade", claim_id: CLAIM } });
  const r = await record(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts[0].requested_by_contractor_id, AWARDED_CONTRACTOR);
});

Deno.test("gh-3459: a malformed metadata.contractor_id is not trusted -- the awarded contractor is used instead", async () => {
  const w = world({ piMetadata: { type: "measurement_upgrade", claim_id: CLAIM, contractor_id: "x),user_id.neq.0" } });
  const r = await record(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts[0].requested_by_contractor_id, AWARDED_CONTRACTOR);
});

Deno.test("gh-3459: CONTROL -- the ordinary case is unchanged: the paying contractor records its own upgrade", async () => {
  const w = world();
  const r = await record(w, { buyer_role: "contractor", contractor_id: PAYING_CONTRACTOR });
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts[0].requested_by_contractor_id, PAYING_CONTRACTOR);
  assertEquals(w.hoverPosts[0].requested_by_role, "contractor");
  assertEquals(w.alerts.length, 0);
});

Deno.test("gh-3459: CONTROL -- neither the PaymentIntent nor the claim names a contractor: still recorded (never refused after payment), contractor id stays NULL", async () => {
  const w = world({ piMetadata: { type: "measurement_upgrade", claim_id: CLAIM }, claim: { id: CLAIM, selected_contractor_id: null } });
  const r = await record(w);
  assertEquals(r.status, 200);
  assertEquals(w.hoverPosts[0].requested_by_contractor_id, null);
  assertEquals(w.hoverPosts[0].requested_by_role, "unspecified");
  assertEquals(w.alerts.length, 1);
});
