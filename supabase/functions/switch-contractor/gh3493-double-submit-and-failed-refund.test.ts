// gh-3493 -- (1) two concurrent switch requests produce ONE refund and ONE honest email; (2) a refund that fails
// (Stripe error at create, or a 200 whose refund.status is failed/canceled) sends no "We refunded" email and raises an OPS alert.
// Drives the REAL exported handler with a stateful in-memory supabase fake (update filters are applied, so a status guard matters)
// and a Stripe/Mailgun fetch stub. No Stripe or Mailgun call is made. Customer wording: only text already in the repo.
// FAIL-FIRST: on main, (1) makes two refund attempts and sends two contractor emails; (2) tells the contractor "We refunded".
// Run: deno test --allow-read --allow-env --allow-net supabase/functions/switch-contractor/gh3493-double-submit-and-failed-refund.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { BASE_ENV, type Env, USER_ID, USER_JWT } from "../_shared/caller-gate-test-kit.ts";
import { handler } from "./index.ts";

const CLAIM = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
const ENV: Env = { ...BASE_ENV, MAILGUN_API_KEY: "mg-fixture", MAILGUN_DOMAIN: "mail.example.test", STRIPE_SECRET_KEY: "sk_live_FIXTURE" };
const REFUNDED = "We refunded your $175.00 platform fee.";
const PENDING = "We will process your platform fee refund separately.";

type Row = Record<string, unknown>;
// Minimal stateful supabase: select/update/insert with eq / in / or / order / limit. update applies its eq filters to the live rows.
function statefulSb(tables: Record<string, Row[]>) {
  const from = (t: string) => {
    let mode: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    const filters: Array<(r: Row) => boolean> = [];
    const run = () => {
      const rows = (tables[t] ??= []);
      if (mode === "insert") return [];
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") hit.forEach((r) => Object.assign(r, patch));
      return hit.map((r) => ({ ...r }));
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: () => b,
      update: (p: Row) => { mode = "update"; patch = p; return b; },
      insert: () => { mode = "insert"; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; },
      or: () => b, order: () => b, limit: () => b,
      single: () => Promise.resolve().then(() => { const d = run(); return { data: d[0] ?? null, error: null }; }),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve().then(() => ({ data: run(), error: null })).then(res, rej),
    };
    return b;
  };
  // deno-lint-ignore no-explicit-any
  return ((_u: string, _k: string) => ({ from, rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } }, error: null }) } })) as any;
}

const fixture = () => ({
  claims: [{ id: CLAIM, user_id: USER_ID, status: "contract_signed", selected_contractor_id: "c1", is_test: false,
    live_charge_authorized_at: null, trades: ["roofing"] }],
  quotes: [{ id: "q1", claim_id: CLAIM, contractor_id: "c1", status: "selected", bid_status: "active", cancellation_reason: null,
    payment_intent_id: "pi_1", payment_status: "succeeded",
    contractors: { id: "c1", company_name: "Acme", email: "ctr@example.com" } }],
  activity_log: [],
});

type Mail = { to: string; text: string };
async function run(n: number, refund: { status: number; body: Row }) {
  const make = statefulSb(fixture());
  const mail: Mail[] = [];
  const refunds: string[] = [];
  const errors: string[] = [];
  const realFetch = globalThis.fetch, realErr = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.stripe.com/v1/refunds")) {
      refunds.push(url);
      return Promise.resolve(new Response(JSON.stringify(refund.body), { status: refund.status }));
    }
    if (url.includes("api.stripe.com")) {
      return Promise.resolve(new Response(JSON.stringify({ latest_charge: "ch_1", amount: 18054, metadata: { platform_fee_cents: "17500" } }), { status: 200 }));
    }
    if (url.includes("api.mailgun.net")) {
      const f = new URLSearchParams(String(init?.body ?? ""));
      mail.push({ to: f.get("to") ?? "", text: f.get("text") ?? "" });
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const call = () => handler(
      new Request("https://x.supabase.co/functions/v1/switch-contractor", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${USER_JWT}` },
        body: JSON.stringify({ claim_id: CLAIM }),
      }), (k) => ENV[k], make);
    const results = await Promise.all(Array.from({ length: n }, call));
    return { statuses: results.map((r) => r.status), refunds, mail: mail.filter((m) => m.to === "ctr@example.com"), errors };
  } finally {
    globalThis.fetch = realFetch; console.error = realErr;
  }
}
const OK = { status: 200, body: { id: "re_1", status: "succeeded" } };

Deno.test("CONTROL one request, refund succeeds: one refund, 'We refunded' email", async () => {
  const r = await run(1, OK);
  assertEquals(r.statuses, [200]);
  assertEquals(r.refunds.length, 1);
  assertEquals(r.mail.length, 1);
  assert(r.mail[0].text.includes(REFUNDED), r.mail[0].text);
});

Deno.test("(1) two concurrent requests: one refund, one honest contractor email, loser stops before refund and email", async () => {
  const r = await run(2, OK);
  assertEquals([...r.statuses].sort(), [200, 500], "exactly one request wins");
  assertEquals(r.refunds.length, 1, "refund attempts: " + r.refunds.length);
  assertEquals(r.mail.length, 1, "contractor emails: " + JSON.stringify(r.mail.map((m) => m.text.slice(0, 200))));
  assert(r.mail[0].text.includes(REFUNDED) && !r.mail[0].text.includes(PENDING));
});

for (const status of ["failed", "canceled", "requires_action"]) {
  Deno.test(`(2) Stripe 200 with refund.status '${status}': no 'We refunded' email, existing 'process separately' wording, OPS alert`, async () => {
    const r = await run(1, { status: 200, body: { id: "re_1", status } });
    assertEquals(r.statuses, [200]);
    assertEquals(r.mail.length, 1);
    assert(!r.mail[0].text.includes("We refunded"), r.mail[0].text);
    assert(r.mail[0].text.includes(PENDING), r.mail[0].text);
    assert(r.errors.some((e) => e.includes("OPS: refund FAILED") && e.includes(CLAIM)), "no OPS alert: " + JSON.stringify(r.errors));
  });
}

Deno.test("(2b) Stripe refund create returns 402: no 'We refunded' email, OPS alert naming the claim", async () => {
  const r = await run(1, { status: 402, body: { error: { message: "declined" } } });
  assertEquals(r.mail.length, 1);
  assert(!r.mail[0].text.includes("We refunded") && r.mail[0].text.includes(PENDING));
  assert(r.errors.some((e) => e.includes("OPS: refund FAILED") && e.includes(CLAIM)), "no OPS alert: " + JSON.stringify(r.errors));
});

Deno.test("CONTROL refund.status 'pending' still counts as refunded (5-10 business days wording)", async () => {
  const r = await run(1, { status: 200, body: { id: "re_1", status: "pending" } });
  assert(r.mail[0].text.includes(REFUNDED), r.mail[0].text);
  assert(!r.errors.some((e) => e.includes("OPS: refund FAILED")));
});
