// gh-3438 -- Ben's ruling 6669903256 (PR #3450): the contractor switch email names the amounts and does not say "refunded in full".
// Wording (Ben's): "We refunded your $175.00 platform fee. The remaining $5.54 [processing fee] is not refundable."
// Drives the REAL exported handler with Mailgun enabled and a Stripe fetch stub, and reads the email actually sent.
// FAIL-FIRST: at head 83f86d4c the card email says "Your platform fee has been refunded in full", so (1) and (2) fail there.
// Run: deno test --allow-read --allow-env --allow-net supabase/functions/switch-contractor/gh3438-email-names-amounts.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { BASE_ENV, type Env, fakeSupabase, USER_ID, USER_JWT } from "../_shared/caller-gate-test-kit.ts";
import * as mod from "./index.ts";
const { handler } = mod;
// deno-lint-ignore no-explicit-any
const m_ = mod as any; // so this file also compiles and FAILS (not a type error) against a head without these exports

const ENV: Env = { ...BASE_ENV, MAILGUN_API_KEY: "mg-fixture", MAILGUN_DOMAIN: "mail.example.test", STRIPE_SECRET_KEY: "sk_live_FIXTURE", STRIPE_SECRET_KEY_TEST: "sk_test_FIXTURE" };
const CLAIM = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
const quote = { id: "q1", status: "selected", bid_status: "active", cancellation_reason: null, payment_intent_id: "pi_1", payment_status: "succeeded", contractors: { id: "c1", company_name: "Acme", email: "ctr@example.com" } };
const claim = { id: CLAIM, user_id: USER_ID, status: "contract_signed", selected_contractor_id: "c1", is_test: false, live_charge_authorized_at: null, trades: ["roofing"] };
// deno-lint-ignore no-explicit-any
const asUser = (make: any) => ((u: string, k: string) => { const c = make(u, k); c.auth.getUser = () => Promise.resolve({ data: { user: { id: USER_ID } }, error: null }); return c; }) as any;

const FULL = "refunded in full";
const WORDS = "We refunded your $175.00 platform fee. The remaining $5.54 processing fee is not refundable.";

async function contractorEmail(pi: Record<string, unknown>) {
  const sb = fakeSupabase({ claims: [claim], quotes: [quote] });
  let text = "";
  let html = "";
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.stripe.com/v1/refunds")) return Promise.resolve(new Response(JSON.stringify({ id: "re_1", status: "succeeded" }), { status: 200 }));
    if (url.includes("api.stripe.com/v1/payment_intents/")) return Promise.resolve(new Response(JSON.stringify(pi), { status: 200 }));
    if (url.includes("api.mailgun.net")) {
      const f = new URLSearchParams(String(init?.body ?? ""));
      if (f.get("to") === "ctr@example.com") { text = f.get("text") ?? ""; html = f.get("html") ?? ""; }
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await handler(
      new Request("https://x.supabase.co/functions/v1/switch-contractor", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${USER_JWT}` }, body: JSON.stringify({ claim_id: CLAIM }) }),
      (n) => ENV[n], asUser(sb.make),
    );
    assertEquals(res.status, 200);
    return { text, html };
  } finally { globalThis.fetch = real; }
}

Deno.test("(1) card charge 18054: the contractor email names $175.00 refunded and $5.54 not refundable, never 'refunded in full'", async () => {
  const m = await contractorEmail({ latest_charge: "ch_1", amount: 18054, metadata: { platform_fee_cents: "17500", card_fee_cents: "554" } });
  assert(m.text.includes(WORDS), "text: " + m.text);
  assert(m.html.includes(WORDS), "html: " + m.html);
  assert(!m.text.includes(FULL) && !m.html.includes(FULL), "still says refunded in full: " + m.text);
});

Deno.test("(2) the amounts come from the charge, not from a constant: a $250.00 fee on a card charge of 25775 names $250.00 and $7.75", async () => {
  const m = await contractorEmail({ latest_charge: "ch_1", amount: 25775, metadata: { platform_fee_cents: "25000" } });
  assert(m.text.includes("We refunded your $250.00 platform fee. The remaining $7.75 processing fee is not refundable."), m.text);
  assert(!m.text.includes("$175.00") && !m.text.includes("$5.54"), m.text);
});

Deno.test("(3) bank-transfer charge 17500 (nothing kept): names $175.00 and does not invent a remaining amount", async () => {
  const m = await contractorEmail({ latest_charge: "ch_1", amount: 17500, metadata: { platform_fee_cents: "17500" } });
  assert(m.text.includes("We refunded your $175.00 platform fee."), m.text);
  assert(!m.text.includes("not refundable") && !m.text.includes("remaining"), m.text);
  assert(!m.text.includes(FULL), m.text);
});

Deno.test("(4) refund not issued (metadata missing): the existing pending wording, no amount named", async () => {
  const m = await contractorEmail({ latest_charge: "ch_1", amount: 18054 });
  assert(m.text.includes("We will process your platform fee refund separately."), m.text);
  assert(!m.text.includes("We refunded your"), m.text);
});

Deno.test("(5) refundedEmailLine / formatUsd", () => {
  assertEquals(m_.formatUsd(17500), "$175.00");
  assertEquals(m_.formatUsd(554), "$5.54");
  assertEquals(m_.refundedEmailLine(17500, 554), WORDS + " The refund will appear in your account within 5–10 business days.");
});
