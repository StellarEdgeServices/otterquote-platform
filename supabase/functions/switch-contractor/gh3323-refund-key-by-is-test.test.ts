// gh-3323 -- switch-contractor must pick its Stripe REFUND key from the claim's is_test, not from the request Origin.
// Ben's ruling 6578880344: refuse an AUTOMATIC refund on an is_test claim that holds a live charge; otherwise the TEST
// key for test claims; real claims unchanged.
//
// Drives the REAL exported handler with injected env, a fake supabase client and a Stripe fetch stub that records the
// Authorization key of every Stripe call. FAIL-FIRST: on main the key is chosen from Origin alone, so tests (3) and (4)
// fail there (the LIVE key is used / a refund is attempted for an is_test claim). (1), (2), (5) are the live-key CONTROLS:
// they pass before and after, proving real claims are unchanged.
// Run: deno test --allow-read --allow-env --allow-net supabase/functions/switch-contractor/gh3323-refund-key-by-is-test.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { BASE_ENV, type Env, fakeSupabase, USER_ID, USER_JWT } from "../_shared/caller-gate-test-kit.ts";
import { handler } from "./index.ts";

const LIVE = "sk_live_FIXTURE";
const TEST = "sk_test_FIXTURE";
const ENV_BOTH: Env = { ...BASE_ENV, MAILGUN_API_KEY: undefined, MAILGUN_DOMAIN: undefined, STRIPE_SECRET_KEY: LIVE, STRIPE_SECRET_KEY_TEST: TEST };
const STAGING = "https://jade-alpaca-b82b5e.netlify.app";
const CLAIM = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";

const quote = { id: "q1", status: "selected", bid_status: "active", cancellation_reason: null, payment_intent_id: "pi_1", payment_status: "succeeded", contractors: { id: "c1", company_name: "Acme", email: null } };
const claimRow = (o: Record<string, unknown> = {}) => ({
  id: CLAIM, user_id: USER_ID, status: "contract_signed", selected_contractor_id: "c1", is_test: false,
  live_charge_authorized_at: null, trades: ["roofing"], ...o,
});

// switch-contractor validates the JWT through the header-scoped client (auth.getUser() takes no token), which the kit's
// fake rejects; this wrapper admits the caller so the handler runs past the auth step (every test asserts status 200).
// deno-lint-ignore no-explicit-any
const asUser = (make: any) => ((u: string, k: string) => { const c = make(u, k); c.auth.getUser = () => Promise.resolve({ data: { user: { id: USER_ID } }, error: null }); return c; }) as any;

type StripeCall = { url: string; method: string; key: string };
async function run(claim: Record<string, unknown>, env: Env, origin?: string) {
  const sb = fakeSupabase({ claims: [claim], quotes: [quote] });
  const stripe: StripeCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.stripe.com")) {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      stripe.push({ url, method: init?.method ?? "GET", key: atob(auth.replace("Basic ", "")).replace(/:$/, "") });
      const body = url.includes("/payment_intents/") ? { latest_charge: "ch_1" } : { id: "re_1", status: "succeeded" };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${USER_JWT}` };
    if (origin) headers.Origin = origin;
    const res = await handler(
      new Request("https://x.supabase.co/functions/v1/switch-contractor", { method: "POST", headers, body: JSON.stringify({ claim_id: CLAIM }) }),
      (n) => env[n], asUser(sb.make),
    );
    return { res, body: await res.json(), stripe };
  } finally {
    globalThis.fetch = real;
  }
}

// ---- live-key CONTROLS: real claims are unchanged ------------------------------------------------------------------
Deno.test("(1) CONTROL real claim, production origin -> refund on the LIVE key", async () => {
  const r = await run(claimRow(), ENV_BOTH);
  assertEquals(r.res.status, 200);
  assertEquals(r.body.refund_issued, true);
  assert(r.stripe.length === 2 && r.stripe.every((c) => c.key === LIVE), JSON.stringify(r.stripe));
});

Deno.test("(2) CONTROL real claim, staging origin -> refund on the TEST key (pre-existing)", async () => {
  const r = await run(claimRow(), ENV_BOTH, STAGING);
  assertEquals(r.body.refund_issued, true);
  assert(r.stripe.length === 2 && r.stripe.every((c) => c.key === TEST), JSON.stringify(r.stripe));
});

Deno.test("(5) CONTROL real claim, no Stripe key configured -> no refund attempt (pre-existing)", async () => {
  const r = await run(claimRow(), { ...ENV_BOTH, STRIPE_SECRET_KEY: undefined, STRIPE_SECRET_KEY_TEST: undefined });
  assertEquals(r.stripe.length, 0);
  assertEquals(r.body.refund_issued, false);
});

// ---- the defect ----------------------------------------------------------------------------------------------------
Deno.test("(3) is_test claim, no live-charge marker, production origin -> TEST key, never the live key", async () => {
  const r = await run(claimRow({ is_test: true }), ENV_BOTH);
  assertEquals(r.res.status, 200);
  assert(r.stripe.length > 0, "a refund attempt is still made, on the test key");
  assert(r.stripe.every((c) => c.key === TEST), "live key used for an is_test claim: " + JSON.stringify(r.stripe));
});

Deno.test("(4) is_test claim holding a live charge (live_charge_authorized_at set) -> NO automatic refund, whatever the Origin", async () => {
  for (const origin of [undefined, STAGING]) {
    const r = await run(claimRow({ is_test: true, live_charge_authorized_at: "2026-08-31T20:00:00Z" }), ENV_BOTH, origin);
    assertEquals(r.stripe.length, 0, `Stripe was called (origin ${origin}): ${JSON.stringify(r.stripe)}`);
    assertEquals(r.res.status, 200, "the switch itself still completes");
    assertEquals(r.body.refund_issued, false);
    assertEquals(r.body.refund_id, null);
  }
});

Deno.test("(6) is_test claim, TEST key missing -> no refund, never a fallback to the live key", async () => {
  const r = await run(claimRow({ is_test: true }), { ...ENV_BOTH, STRIPE_SECRET_KEY_TEST: undefined });
  assertEquals(r.res.status, 200, "the switch ran (not a vacuous 401)");
  assertEquals(r.stripe.length, 0);
});

Deno.test("(7) is_test is read from the claim row, not from the request body", async () => {
  const sb = fakeSupabase({ claims: [claimRow({ is_test: true, live_charge_authorized_at: "2026-08-31T20:00:00Z" })], quotes: [quote] });
  const stripe: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((i: string | URL | Request) => {
    const u = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (u.includes("stripe.com")) stripe.push(u);
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await handler(
      new Request("https://x.supabase.co/functions/v1/switch-contractor", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${USER_JWT}` },
        body: JSON.stringify({ claim_id: CLAIM, is_test: false, live_charge_authorized_at: null }),
      }),
      (n) => ENV_BOTH[n], asUser(sb.make),
    );
    assertEquals(res.status, 200, "the switch ran (not a vacuous 401)");
  } finally { globalThis.fetch = real; }
  assertEquals(stripe.length, 0);
});
