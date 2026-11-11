// gh-3323 -- process-hover-rebate must pick its Stripe REFUND key from the claim's is_test, not from the request Origin.
// Ben's ruling 6578880344: refuse an AUTOMATIC refund on an is_test claim that holds a live charge; otherwise the TEST
// key for test claims; real claims unchanged. Drives the REAL exported handler (gh-2462 pattern).
// FAIL-FIRST: on main (Origin-only pick) tests (3) and (4) fail; (1), (2), (5) are the live-key controls and pass on both.
// Run: deno test --allow-read --allow-env --allow-net supabase/functions/process-hover-rebate/gh3323-refund-key-by-is-test.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { BASE_ENV, type Env, fakeSupabase, req, SERVICE_KEY } from "../_shared/caller-gate-test-kit.ts";
import { handler } from "./index.ts";

const LIVE = "sk_live_FIXTURE";
const TEST = "sk_test_FIXTURE";
const ENV_BOTH: Env = { ...BASE_ENV, STRIPE_SECRET_KEY: LIVE, STRIPE_SECRET_KEY_TEST: TEST };
const STAGING = "https://jade-alpaca-b82b5e.netlify.app";
const CLAIM = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
const order = { id: "o1", claim_id: CLAIM, homeowner_stripe_payment_intent_id: "pi_x", homeowner_charge_amount: 5000, rebate_due: true, rebate_paid_at: null };
const claimRow = (o: Record<string, unknown> = {}) => ({ user_id: "u", is_test: false, completion_date: "2026-10-01", live_charge_authorized_at: null, ...o });

async function run(claim: Record<string, unknown>, env: Env, origin?: string) {
  const sb = fakeSupabase({ hover_orders: [order], claims: [claim] });
  const stripe: { url: string; key: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.stripe.com")) {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      if (init?.method === "POST") stripe.push({ url, key: atob(auth.replace("Basic ", "")).replace(/:$/, "") }); // gh-3452: count refunds created, not the lookup GET
    }
    // gh-3452: the pre-refund lookup is a GET and expects a list; the POST creates the refund.
    const isList = (init?.method ?? "GET") === "GET";
    return Promise.resolve(new Response(JSON.stringify(isList ? { data: [] } : { id: "re_1" }), { status: 200 }));
  }) as typeof fetch;
  try {
    const r = req("https://x.supabase.co/functions/v1/process-hover-rebate", { claim_id: CLAIM }, `Bearer ${SERVICE_KEY}`);
    if (origin) r.headers.set("Origin", origin);
    const res = await handler(r, (n) => env[n], sb.make);
    return { res, body: await res.json(), stripe };
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("(1) CONTROL real claim, production origin -> refund on the LIVE key", async () => {
  const r = await run(claimRow(), ENV_BOTH);
  assertEquals(r.body.results[0].status, "rebated");
  assert(r.stripe.length === 1 && r.stripe[0].key === LIVE, JSON.stringify(r.stripe));
});

Deno.test("(2) CONTROL real claim, staging origin -> refund on the TEST key (pre-existing)", async () => {
  const r = await run(claimRow(), ENV_BOTH, STAGING);
  assert(r.stripe.length === 1 && r.stripe[0].key === TEST, JSON.stringify(r.stripe));
});

Deno.test("(5) CONTROL no Stripe key configured -> 500 before any Stripe call (pre-existing)", async () => {
  const r = await run(claimRow(), { ...ENV_BOTH, STRIPE_SECRET_KEY: undefined, STRIPE_SECRET_KEY_TEST: undefined });
  assertEquals(r.res.status, 500);
  assertEquals(r.stripe.length, 0);
});

Deno.test("(3) is_test claim, no live-charge marker, production origin -> TEST key, never the live key", async () => {
  const r = await run(claimRow({ is_test: true }), ENV_BOTH);
  assert(r.stripe.length === 1, "refund attempted on the test key");
  assertEquals(r.stripe[0].key, TEST);
});

Deno.test("(4) is_test claim holding a live charge -> NO automatic refund, whatever the Origin; order stays due", async () => {
  for (const origin of [undefined, STAGING]) {
    const r = await run(claimRow({ is_test: true, live_charge_authorized_at: "2026-08-31T20:00:00Z" }), ENV_BOTH, origin);
    assertEquals(r.stripe.length, 0, `Stripe was called (origin ${origin}): ${JSON.stringify(r.stripe)}`);
    assertEquals(r.body.results[0].status, "skipped");
    assert(String(r.body.results[0].detail).includes("live_charge_on_test_claim_manual_refund_only"));
  }
});

Deno.test("(6) is_test claim, TEST key missing -> no refund, never a fallback to the live key", async () => {
  const r = await run(claimRow({ is_test: true }), { ...ENV_BOTH, STRIPE_SECRET_KEY_TEST: undefined });
  assertEquals(r.stripe.length, 0);
  assertEquals(r.body.results[0].status, "skipped");
});
