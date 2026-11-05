// gh-3452 -- a rebate refund that succeeds at Stripe but fails its hover_orders update must end with rebate_paid_at set
// by the scan (repair path: findExistingRebateRefund), with NO second refund. Drives the REAL exported handler (gh-2462).
// The Stripe fake models the 24-hour idempotency window: after it lapses a repeated POST creates a SECOND refund.
// FAIL-FIRST: on main, scan 2 POSTs a second refund and nothing reads existing refunds; tests (1) and (3) fail.
// Run: deno test --allow-read --allow-env --allow-net supabase/functions/process-hover-rebate/gh3452-refund-ok-db-failed-repair.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { BASE_ENV, req, SERVICE_KEY } from "../_shared/caller-gate-test-kit.ts";
import { handler } from "./index.ts";

const CLAIM = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
const URL_ = "https://x.supabase.co/functions/v1/process-hover-rebate";

// Stateful fake: hover_orders rows persist; the update can be told to fail; the scan filter is honoured.
function world(opts: { updateFails: () => boolean }) {
  const order: Record<string, unknown> = { id: "o1", claim_id: CLAIM, homeowner_stripe_payment_intent_id: "pi_x", homeowner_charge_amount: 5000, rebate_due: true, rebate_paid_at: null };
  const claim = { user_id: "u", is_test: false, completion_date: "2026-10-01", live_charge_authorized_at: null };
  const logs: string[] = [];
  const make = () => ({
    from: (table: string) => {
      let patch: Record<string, unknown> | null = null;
      let inserted: Record<string, unknown> | null = null;
      const b: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
              let out: { data: unknown; error: unknown } = { data: [], error: null };
              if (table === "hover_orders" && patch) {
                if (opts.updateFails()) out = { data: null, error: { message: "db down" } };
                else if (order.rebate_paid_at === null) { Object.assign(order, patch); out = { data: [{ id: "o1" }], error: null }; }
              } else if (table === "hover_orders") {
                out = { data: order.rebate_due && order.rebate_paid_at === null ? [order] : [], error: null };
              } else if (inserted) {
                logs.push(String(inserted.event_type ?? inserted.alert_type));
              }
              return Promise.resolve(out).then(res, rej);
            };
          }
          if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: table === "claims" ? claim : null, error: null });
          if (prop === "update") return (p: Record<string, unknown>) => { patch = p; return b; };
          if (prop === "insert") return (r: Record<string, unknown>) => { inserted = r; return b; };
          return () => b;
        },
      });
      return b;
    },
  });
  return { order, logs, make: make as any };
}

// Stripe fake. `idemWindowOpen` false = the 24h key has expired, so a repeat POST makes a NEW refund.
function stripe(state: { refunds: any[]; idemWindowOpen: boolean }, opts: { listStatus?: number } = {}) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.replace("https://api.stripe.com/v1", "")}`);
    if (method === "GET") {
      if (opts.listStatus) return Promise.resolve(new Response("{}", { status: opts.listStatus }));
      return Promise.resolve(new Response(JSON.stringify({ data: state.refunds }), { status: 200 }));
    }
    if (state.idemWindowOpen && state.refunds.length) return Promise.resolve(new Response(JSON.stringify(state.refunds[0]), { status: 200 }));
    const form = new URLSearchParams(String(init?.body));
    const r = { id: `re_${state.refunds.length + 1}`, status: "succeeded", metadata: { type: form.get("metadata[type]"), hover_order_id: form.get("metadata[hover_order_id]") } };
    state.refunds.push(r);
    return Promise.resolve(new Response(JSON.stringify(r), { status: 200 }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

async function scan(w: ReturnType<typeof world>) {
  const res = await handler(req(URL_, { scan: true }, `Bearer ${SERVICE_KEY}`), (n) => BASE_ENV[n], w.make);
  return await res.json();
}

Deno.test("(1) refund ok + DB update fails, key expired, next scan -> rebate_paid_at set, still exactly one refund", async () => {
  const st = { refunds: [] as any[], idemWindowOpen: true };
  let fail = true;
  const w = world({ updateFails: () => fail });
  const s = stripe(st);
  try {
    await scan(w);                       // refund created, DB write fails
    assertEquals(st.refunds.length, 1);
    assertEquals(w.order.rebate_paid_at, null);
    fail = false; st.idemWindowOpen = false; // DB healthy again, 24h later
    await scan(w);
    assertEquals(st.refunds.length, 1, `second refund created: ${s.calls.join(" | ")}`);
    assert(w.order.rebate_paid_at, "rebate_paid_at must be set by the repair");
    assertEquals(w.order.rebate_due, false);
    assert(w.logs.includes("hover_rebate_repaired"), w.logs.join());
  } finally { s.restore(); }
});

Deno.test("(2) CONTROL happy path: no prior refund -> one refund, paid set, not logged as repaired", async () => {
  const st = { refunds: [] as any[], idemWindowOpen: true };
  const w = world({ updateFails: () => false });
  const s = stripe(st);
  try {
    await scan(w);
    assertEquals(st.refunds.length, 1);
    assert(w.order.rebate_paid_at);
    assert(!w.logs.includes("hover_rebate_repaired"));
  } finally { s.restore(); }
});

Deno.test("(3) repeat scans after repair and concurrent scans never add a refund", async () => {
  const st = { refunds: [{ id: "re_1", status: "succeeded", metadata: { type: "hover_measurement_rebate", hover_order_id: "o1" } }], idemWindowOpen: false };
  const w = world({ updateFails: () => false });
  const s = stripe(st);
  try {
    await Promise.all([scan(w), scan(w)]);
    await scan(w);
    assertEquals(st.refunds.length, 1, s.calls.join(" | "));
    assert(w.order.rebate_paid_at);
  } finally { s.restore(); }
});

Deno.test("(4) refund lookup fails -> fail closed: no refund created, order stays due", async () => {
  const st = { refunds: [] as any[], idemWindowOpen: false };
  const w = world({ updateFails: () => false });
  const s = stripe(st, { listStatus: 500 });
  try {
    const body = await scan(w);
    assertEquals(st.refunds.length, 0);
    assertEquals(body.results[0].status, "failed");
    assertEquals(w.order.rebate_paid_at, null);
  } finally { s.restore(); }
});

Deno.test("(5) a failed or canceled refund for the order does not count as paid", async () => {
  const st = { refunds: [{ id: "re_0", status: "failed", metadata: { type: "hover_measurement_rebate", hover_order_id: "o1" } }], idemWindowOpen: false };
  const w = world({ updateFails: () => false });
  const s = stripe(st);
  try {
    await scan(w);
    assertEquals(st.refunds.length, 2);
  } finally { s.restore(); }
});
