// gh-2462 -- caller gate for process-hover-rebate (the Stripe-refund path), #2309 pattern.
//
// Drives the REAL exported handler with injected env, a fake supabase client and a
// counting fetch stub (Stripe would be a fetch). NEGATIVE CONTROL: with the
// `serviceGate(...)` call in index.ts removed, every "refused" test below FAILS (the
// handler builds the client and scans hover_orders). Output is in the PR body.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BAD_BEARERS,
  BASE_ENV,
  type Env,
  fakeSupabase,
  req,
  SECRET_DEFAULT,
  SERVICE_KEY,
  withFetchStub,
} from "../_shared/caller-gate-test-kit.ts";
import { handler } from "./index.ts";

const URL_ = "https://x.supabase.co/functions/v1/process-hover-rebate";
const CLAIM = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
// The two bodies the real callers send: cron job 10 and the completion trigger.
const BODIES = [{ scan: true }, { claim_id: CLAIM }, {}];

async function run(r: Request, env: Env = BASE_ENV, rows = {}) {
  const sb = fakeSupabase(rows);
  const { result, fetchCalls } = await withFetchStub(() => handler(r, (n) => env[n], sb.make));
  return { res: result, fetchCalls, clientCalls: sb.calls };
}

Deno.test("refused callers -> 401 with zero I/O (no client, no hover_orders read, no Stripe)", async () => {
  for (const body of BODIES) {
    for (const [label, auth] of BAD_BEARERS) {
      const r = await run(req(URL_, body, auth));
      assertEquals(r.res.status, 401, `${label} ${JSON.stringify(body)}`);
      assertEquals(r.fetchCalls.length, 0, `no fetch for ${label}`);
      assertEquals(r.clientCalls.length, 0, `no client for ${label}`);
      assertEquals(await r.res.json(), { error: "Unauthorized" });
    }
  }
});

Deno.test("refund-shaped rows present: refused caller still never reaches Stripe", async () => {
  const rows = {
    hover_orders: [{ id: "o1", claim_id: CLAIM, homeowner_stripe_payment_intent_id: "pi_x", homeowner_charge_amount: 5000, rebate_due: true, rebate_paid_at: null }],
    claims: [{ user_id: "u", is_test: false, completion_date: "2026-10-01" }],
  };
  const r = await run(req(URL_, { claim_id: CLAIM }, null), BASE_ENV, rows);
  assertEquals(r.res.status, 401);
  assertEquals(r.fetchCalls.filter((u) => u.includes("stripe.com")).length, 0);
});

Deno.test("fail-closed: empty/unset keys authorize nobody, even an empty bearer", async () => {
  const envs: Env[] = [
    { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: "" },
    { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEYS: undefined },
    { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: JSON.stringify({ default: "" }) },
  ];
  for (const env of envs) {
    for (const h of ["Bearer ", "Bearer", "Bearer undefined", "Bearer null", null]) {
      const r = await run(req(URL_, { scan: true }, h), env);
      assertEquals(r.res.status, 401, `${JSON.stringify(h)}`);
      assertEquals(r.clientCalls.length, 0);
    }
  }
});

Deno.test("legitimate callers pass the gate: runtime service key and the vault/secret default key", async () => {
  for (const key of [SERVICE_KEY, SECRET_DEFAULT]) {
    for (const body of BODIES) {
      const r = await run(req(URL_, body, `Bearer ${key}`));
      assertEquals(r.res.status, 200, `${JSON.stringify(body)}`);
      assert(r.clientCalls.includes("from:hover_orders"), "past the gate the handler reads hover_orders");
    }
  }
  // lower-case scheme, as pg_net / other clients may send
  const lower = await run(req(URL_, { scan: true }, `bearer ${SERVICE_KEY}`));
  assertEquals(lower.res.status, 200);
  // legacy-only env (SUPABASE_SECRET_KEYS unset) still accepts the runtime key, not the other one
  const legacy = { ...BASE_ENV, SUPABASE_SECRET_KEYS: undefined };
  assertEquals((await run(req(URL_, { scan: true }, `Bearer ${SERVICE_KEY}`), legacy)).res.status, 200);
  assertEquals((await run(req(URL_, { scan: true }, `Bearer ${SECRET_DEFAULT}`), legacy)).res.status, 401);
});

Deno.test("legitimate scan with a due order reaches Stripe (gate does not block the refund path)", async () => {
  const rows = {
    hover_orders: [{ id: "o1", claim_id: CLAIM, homeowner_stripe_payment_intent_id: "pi_x", homeowner_charge_amount: 5000, rebate_due: true, rebate_paid_at: null }],
    claims: [{ user_id: "u", is_test: false, completion_date: "2026-10-01" }],
  };
  const r = await run(req(URL_, { scan: true }, `Bearer ${SECRET_DEFAULT}`), BASE_ENV, rows);
  assertEquals(r.res.status, 200);
  assertEquals(r.fetchCalls.filter((u) => u.includes("api.stripe.com/v1/refunds")).length, 1);
});

Deno.test("health_check and OPTIONS stay ungated", async () => {
  const h = await run(req(URL_, { health_check: true }, null));
  assertEquals(h.res.status, 200);
  assertEquals(await h.res.json(), { status: "ok" });
  assertEquals(h.fetchCalls.length, 0);
  const o = await run(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(o.res.status, 200);
  assertEquals(o.clientCalls.length, 0);
  for (const b of [{ health_check: "true" }, { health_check: 1 }, { health_check: false, scan: true }]) {
    assertEquals((await run(req(URL_, b, null))).res.status, 401, JSON.stringify(b));
  }
});

// Structural pin: the gate runs before the client is built and before any `.from(` in the handler.
Deno.test("index.ts wiring: serviceGate precedes makeClient(...) and every .from( in handler", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const live = (l: string) => !l.trim().startsWith("//");
  const at = (needle: string) => lines.findIndex((l) => live(l) && l.includes(needle));
  const handlerAt = at("export async function handler(");
  const gateAt = at("serviceGate(req, getEnv, corsHeaders)");
  const clientAt = at("makeClient(supabaseUrl, supabaseKey)");
  const stripeKeyAt = at('getEnv("STRIPE_SECRET_KEY")');
  const firstFrom = lines.findIndex((l, i) => i > handlerAt && live(l) && l.includes(".from("));
  assert(handlerAt > 0 && gateAt > handlerAt, "gate inside handler");
  assert(clientAt > gateAt && stripeKeyAt > gateAt && firstFrom > gateAt, "gate before client, Stripe key and DB");
  assert(src.includes("if (import.meta.main)"), "serve() guarded by import.meta.main");
});

// The five copies of caller-gate.ts must stay byte-identical (one source of truth).
Deno.test("caller-gate.ts copies are byte-identical across the gated functions", async () => {
  const mine = await Deno.readTextFile(new URL("./caller-gate.ts", import.meta.url));
  for (const fn of ["check-siding-design-completion", "notify-feature-request", "notify-contractors", "check-rate-limits"]) {
    const other = await Deno.readTextFile(new URL(`../${fn}/caller-gate.ts`, import.meta.url));
    assertEquals(other, mine, `${fn}/caller-gate.ts drifted from process-hover-rebate/caller-gate.ts`);
  }
});
