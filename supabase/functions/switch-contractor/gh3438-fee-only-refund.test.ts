// gh-3438 -- switch-contractor refunds the PLATFORM FEE ONLY (Dustin: "Fee only"; Agreement 6.4 excludes any card processing fee).
// Drives the REAL exported handler with a fake supabase client and a Stripe fetch stub that records every refund request body.
// FAIL-FIRST: on main stripeRefund() sends no `amount` (whole charge), so (1) and (2) fail there; (3)-(7) assert the fail-closed
// behaviour when metadata.platform_fee_cents is missing/invalid (no refund, OPS alert, never the whole charge).
// Run: deno test --allow-read --allow-env --allow-net supabase/functions/switch-contractor/gh3438-fee-only-refund.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { BASE_ENV, type Env, fakeSupabase, USER_ID, USER_JWT } from "../_shared/caller-gate-test-kit.ts";
import * as mod from "./index.ts";
const { handler } = mod;
// deno-lint-ignore no-explicit-any
const parsePlatformFeeCents = (...a: unknown[]) => (mod as any).parsePlatformFeeCents(...a);

const ENV: Env = { ...BASE_ENV, MAILGUN_API_KEY: undefined, MAILGUN_DOMAIN: undefined, STRIPE_SECRET_KEY: "sk_live_FIXTURE", STRIPE_SECRET_KEY_TEST: "sk_test_FIXTURE" };
const CLAIM = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
const quote = { id: "q1", status: "selected", bid_status: "active", cancellation_reason: null, payment_intent_id: "pi_1", payment_status: "succeeded", contractors: { id: "c1", company_name: "Acme", email: "ctr@example.com" } };
const claim = { id: CLAIM, user_id: USER_ID, status: "contract_signed", selected_contractor_id: "c1", is_test: false, live_charge_authorized_at: null, trades: ["roofing"] };
// deno-lint-ignore no-explicit-any
const asUser = (make: any) => ((u: string, k: string) => { const c = make(u, k); c.auth.getUser = () => Promise.resolve({ data: { user: { id: USER_ID } }, error: null }); return c; }) as any;

async function run(pi: Record<string, unknown>) {
  const sb = fakeSupabase({ claims: [claim], quotes: [quote] });
  const refunds: URLSearchParams[] = [];
  const errors: string[] = [];
  const real = globalThis.fetch;
  const realErr = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.stripe.com/v1/refunds")) {
      refunds.push(new URLSearchParams(String(init?.body ?? "")));
      return Promise.resolve(new Response(JSON.stringify({ id: "re_1", status: "succeeded" }), { status: 200 }));
    }
    if (url.includes("api.stripe.com/v1/payment_intents/")) return Promise.resolve(new Response(JSON.stringify(pi), { status: 200 }));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await handler(
      new Request("https://x.supabase.co/functions/v1/switch-contractor", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${USER_JWT}` }, body: JSON.stringify({ claim_id: CLAIM }) }),
      (n) => ENV[n], asUser(sb.make),
    );
    return { res, body: await res.json(), refunds, errors };
  } finally { globalThis.fetch = real; console.error = realErr; }
}

Deno.test("(1) card charge 18054 (17500 fee + 554 card fee): Stripe refund request carries amount=17500", async () => {
  const r = await run({ latest_charge: "ch_1", amount: 18054, metadata: { platform_fee_cents: "17500", card_fee_cents: "554" } });
  assertEquals(r.res.status, 200);
  assertEquals(r.refunds.length, 1);
  assertEquals(r.refunds[0].get("amount"), "17500");
  assertEquals(r.refunds[0].get("charge"), "ch_1");
  assertEquals(r.body.refund_issued, true);
});

Deno.test("(2) bank-transfer charge 17500 (no card fee): amount=17500, equal to the whole charge", async () => {
  const r = await run({ latest_charge: "ch_1", amount: 17500, metadata: { platform_fee_cents: "17500" } });
  assertEquals(r.refunds.length, 1);
  assertEquals(r.refunds[0].get("amount"), "17500");
  assertEquals(r.body.refund_issued, true);
});

for (const [name, md] of [
  ["metadata absent", undefined],
  ["platform_fee_cents missing", { card_fee_cents: "554" }],
  ["platform_fee_cents empty", { platform_fee_cents: "" }],
  ["platform_fee_cents not a number", { platform_fee_cents: "175.00" }],
  ["platform_fee_cents zero", { platform_fee_cents: "0" }],
  ["platform_fee_cents negative", { platform_fee_cents: "-17500" }],
  ["platform_fee_cents exceeds the charge", { platform_fee_cents: "20000" }],
] as const) {
  Deno.test(`(3) ${name}: NO refund (never the whole charge), OPS alert, switch still completes, refund reported pending`, async () => {
    const r = await run({ latest_charge: "ch_1", amount: 18054, ...(md ? { metadata: md } : {}) });
    assertEquals(r.res.status, 200, "the switch itself still completes");
    assertEquals(r.refunds.length, 0, "a refund request was sent: " + JSON.stringify(r.refunds.map(String)));
    assertEquals(r.body.refund_issued, false);
    assertEquals(r.body.refund_id, null);
    assert(r.errors.some((e) => e.includes("OPS: refund NOT issued") && e.includes("platform_fee_cents")), "no OPS alert: " + r.errors.join(" | "));
  });
}

Deno.test("(4) parsePlatformFeeCents: accepts positive integers up to the charge, rejects the rest", () => {
  assertEquals(parsePlatformFeeCents("17500", 18054), 17500);
  assertEquals(parsePlatformFeeCents(17500, 18054), 17500);
  assertEquals(parsePlatformFeeCents("17500"), 17500);
  assertEquals(parsePlatformFeeCents("18054", 18054), 18054);
  for (const bad of [undefined, null, "", " ", "abc", "1e3", "175.0", "0", "-1", {}, [], NaN]) assertEquals(parsePlatformFeeCents(bad, 18054), null, String(bad));
  assertEquals(parsePlatformFeeCents("18055", 18054), null);
});
