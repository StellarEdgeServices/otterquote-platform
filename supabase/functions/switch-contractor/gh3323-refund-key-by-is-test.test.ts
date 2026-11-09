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

const quote = { id: "q1", status: "selected", bid_status: "active", cancellation_reason: null, payment_intent_id: "pi_1", payment_status: "succeeded", contractors: { id: "c1", company_name: "Acme", email: "ctr@example.com" } };
const claimRow = (o: Record<string, unknown> = {}) => ({
  id: CLAIM, user_id: USER_ID, status: "contract_signed", selected_contractor_id: "c1", is_test: false,
  live_charge_authorized_at: null, trades: ["roofing"], ...o,
});

// switch-contractor validates the JWT through the header-scoped client (auth.getUser() takes no token), which the kit's
// fake rejects; this wrapper admits the caller so the handler runs past the auth step (every test asserts status 200).
// deno-lint-ignore no-explicit-any
const asUser = (make: any) => ((u: string, k: string) => { const c = make(u, k); c.auth.getUser = () => Promise.resolve({ data: { user: { id: USER_ID } }, error: null }); return c; }) as any;

type StripeCall = { url: string; method: string; key: string };
type Mail = { to: string; subject: string; text: string; html: string };
async function run(claim: Record<string, unknown>, env: Env, origin?: string, q: Record<string, unknown> = quote) {
  const sb = fakeSupabase({ claims: [claim], quotes: [q] });
  const mail: Mail[] = [];
  const stripe: StripeCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.stripe.com")) {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      stripe.push({ url, method: init?.method ?? "GET", key: atob(auth.replace("Basic ", "")).replace(/:$/, "") });
      const body = url.includes("/payment_intents/") ? { latest_charge: "ch_1", amount: 18054, metadata: { platform_fee_cents: "17500" } } : { id: "re_1", status: "succeeded" };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    if (url.includes("api.mailgun.net")) {
      const f = new URLSearchParams(String(init?.body ?? ""));
      mail.push({ to: f.get("to") ?? "", subject: f.get("subject") ?? "", text: f.get("text") ?? "", html: f.get("html") ?? "" });
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
    return { res, body: await res.json(), stripe, mail };
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

// ---- what the two emails say when the refund is NOT done (review 6584282844 / LEGAL-READ 6584286256) ------------------
// Existing wording only: the "pending" sentences already in templates.ts / index.ts. FAIL-FIRST: on d012e34 the refused case
// sends "No platform fee had been charged ..." to the contractor and "Refund issued:   Yes" to support.
const ENV_MAIL: Env = { ...ENV_BOTH, MAILGUN_API_KEY: "mg-fixture", MAILGUN_DOMAIN: "mail.example.test" };
const NO_FEE = "No platform fee had been charged on this project, so no refund is necessary.";
const PENDING = "We will process your platform fee refund separately.";
const FULL = "refunded in full"; // gh-3438 (ruling 6669903256): the refunded email names the amounts instead; FULL must never appear
function emails(m: Mail[]) {
  const ctr = m.find((x) => x.to === "ctr@example.com");
  const sup = m.find((x) => x.to === "dustinstohler1@gmail.com");
  assert(ctr && sup, "both the contractor and the support email were sent: " + JSON.stringify(m.map((x) => x.to)));
  return { ctr: ctr!, sup: sup! };
}
function assertPending(m: Mail[]) {
  const { ctr, sup } = emails(m);
  assert(!ctr.text.includes(NO_FEE) && !ctr.html.includes(NO_FEE), "contractor told no fee was charged: " + ctr.text);
  assert(ctr.text.includes(PENDING), "contractor email lacks the pending wording: " + ctr.text);
  assert(!ctr.text.includes(FULL), "contractor told the fee was refunded");
  assert(sup.text.includes("Refund issued:   Pending"), "support email: " + sup.text);
  assert(!sup.text.includes("Refund issued:   Yes"), "support told a refund was issued");
}

Deno.test("(8) is_test + live-charge marker, charge succeeded: contractor and support emails say refund PENDING, not 'no fee' / 'Yes'", async () => {
  const r = await run(claimRow({ is_test: true, live_charge_authorized_at: "2026-08-31T20:00:00Z" }), ENV_MAIL);
  assertEquals(r.res.status, 200);
  assertEquals(r.stripe.length, 0);
  assertPending(r.mail);
});

Deno.test("(9) is_test, TEST key missing, charge succeeded: emails say PENDING", async () => {
  const r = await run(claimRow({ is_test: true }), { ...ENV_MAIL, STRIPE_SECRET_KEY_TEST: undefined });
  assertEquals(r.stripe.length, 0);
  assertPending(r.mail);
});

Deno.test("(10) real claim, no Stripe key configured, charge succeeded (existing defect, same fix): emails say PENDING", async () => {
  const r = await run(claimRow(), { ...ENV_MAIL, STRIPE_SECRET_KEY: undefined, STRIPE_SECRET_KEY_TEST: undefined });
  assertEquals(r.stripe.length, 0);
  assertPending(r.mail);
});

Deno.test("(11) CONTROL no charge on the quote -> 'no platform fee had been charged' is still said (true there)", async () => {
  const r = await run(claimRow({ is_test: true, live_charge_authorized_at: "2026-08-31T20:00:00Z" }), ENV_MAIL, undefined,
    { ...quote, payment_intent_id: null, payment_status: "pending" });
  const { ctr } = emails(r.mail);
  assert(ctr.text.includes(NO_FEE), ctr.text);
  assertEquals(r.stripe.length, 0);
});

Deno.test("(12) CONTROL real claim with a key: refund named by amount (gh-3438), support says Yes", async () => {
  const r = await run(claimRow(), ENV_MAIL);
  const { ctr, sup } = emails(r.mail);
  assert(ctr.text.includes("We refunded your $175.00 platform fee. The remaining $5.54 processing fee is not refundable."), ctr.text);
  assert(!ctr.text.includes(FULL), ctr.text);
  assert(sup.text.includes("Refund issued:   Yes"), sup.text);
});
