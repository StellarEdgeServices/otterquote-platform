// gh-3861 -- hand-off-after-fulfilment. Drives the REAL exported handler with injected env, a fake admin
// gate, a recording fake supabase client and a recording fetch stub. NO email or SMS can go out: the only
// network door is the fetch stub, which answers 200 and records the URL, so a test can count notify-contractors
// invocations and prove nothing else is called. NEGATIVE CONTROLS (output in the PR body): on unfixed main the
// function does not exist, so every test below fails to import; with the plan.ts / admin / flag checks removed,
// the refusal tests fail (see the mutation notes in the PR).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handler } from "./index.ts";
import { flagIsOn, planHandOff } from "./plan.ts";

const URL_ = "https://x.supabase.co/functions/v1/hand-off-after-fulfilment";
const SB = "https://x.supabase.co";
const SERVICE_KEY = "fixture-runtime-service-key-0123456789";
const ADMIN_JWT = "fixture-admin-header.fixture-admin-payload.fixture-admin-signature";
const USER_JWT = "fixture-user-header.fixture-user-payload.fixture-user-signature";
const ORDER = "11111111-1111-4111-8111-111111111111";
const CLAIM = "22222222-2222-4222-8222-222222222222";
const HOMEOWNER = "33333333-3333-4333-8333-333333333333";
const NOTIFY_URL = `${SB}/functions/v1/notify-contractors`;

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const ENV_ON: Record<string, string | undefined> = {
  SUPABASE_URL: SB,
  SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  MEASUREMENT_CHARGE_ENABLED: "true",
};

function baseTables(over: Partial<Tables> = {}): Tables {
  return {
    hover_orders: [{ id: ORDER, claim_id: CLAIM, user_id: HOMEOWNER, status: "completed", requested_by_role: "homeowner" }],
    claims: [{
      id: CLAIM, status: "draft", ready_for_bids: false, trades: ["roofing"], is_test: true,
      roofing_bid_released_at: null, gutters_bid_released_at: null, siding_bid_released_at: null, windows_bid_released_at: null,
    }],
    activity_log: [],
    platform_alerts_log: [],
    ...over,
  };
}

// Recording STATEFUL fake client: update() applies its patch to tables.claims[0], insert() appends to tables[table], and
// reads honour .eq / .in / .contains filters, so a second run() against the same `tables` sees what the first one wrote
// (the retry tests depend on that). failInsert(table, payload) makes an insert return an error and not append.
function fakeClient(tables: Tables, opts: { updateError?: { message: string } | null; updateRows?: Row[] | null; failInsert?: (table: string, p: Row) => boolean } = {}) {
  const calls: string[] = [];
  const writes: { table: string; op: "update" | "insert"; payload: Row }[] = [];
  const matches = (r: Row, f: { eq: [string, unknown][]; inn: [string, unknown[]][]; cont: [string, Row][] }) =>
    f.eq.every(([c, v]) => r[c] === v) &&
    f.inn.every(([c, vs]) => vs.includes(r[c])) &&
    f.cont.every(([c, o]) => Object.entries(o).every(([k, v]) => ((r[c] ?? {}) as Row)[k] === v));
  // deno-lint-ignore no-explicit-any
  const make = ((_u: string, _k: string) => {
    calls.push("createClient");
    return {
      from: (table: string) => {
        calls.push(`from:${table}`);
        let op: "select" | "update" = "select";
        let patch: Row = {};
        const f = { eq: [] as [string, unknown][], inn: [] as [string, unknown[]][], cont: [] as [string, Row][] };
        // deno-lint-ignore no-explicit-any
        const b: any = {
          select: () => b,
          eq: (c: string, v: unknown) => { f.eq.push([c, v]); return b; },
          in: (c: string, vs: unknown[]) => { f.inn.push([c, vs]); return b; },
          contains: (c: string, o: Row) => { f.cont.push([c, o]); return b; },
          limit: () => b,
          update: (p: Row) => { op = "update"; patch = p; EVENTS.push(`update:${table}`); writes.push({ table, op: "update", payload: p }); return b; },
          insert: (p: Row) => {
            EVENTS.push(`insert:${table}`);
            writes.push({ table, op: "insert", payload: p });
            if (opts.failInsert?.(table, p)) return Promise.resolve({ data: null, error: { message: "insert failed" } });
            (tables[table] ??= []).push(p);
            return Promise.resolve({ data: null, error: null });
          },
          maybeSingle: () => Promise.resolve({ data: (tables[table] ?? []).find((r) => matches(r, f)) ?? null, error: null }),
          then: (res: (v: unknown) => unknown) => {
            if (op === "update") {
              const fails = !!opts.updateError || opts.updateRows === null || (opts.updateRows !== undefined && opts.updateRows.length === 0);
              if (!fails) for (const r of (tables[table] ?? []).filter((x) => matches(x, f))) Object.assign(r, patch);
              return Promise.resolve({
                data: opts.updateRows === undefined ? [{ id: CLAIM }] : opts.updateRows,
                error: opts.updateError ?? null,
              }).then(res);
            }
            return Promise.resolve({ data: (tables[table] ?? []).filter((r) => matches(r, f)), error: null }).then(res);
          },
        };
        return b;
      },
    };
  }) as any;
  return { make, calls, writes };
}

function gateFor(who: "admin" | "non-admin" | "bad-token") {
  const gateCalls: string[] = [];
  return {
    gateCalls,
    deps: {
      getUser: (_u: string, _k: string, auth: string) => {
        gateCalls.push("getUser");
        const ok = who !== "bad-token" && (auth === `Bearer ${ADMIN_JWT}` || auth === `Bearer ${USER_JWT}`);
        return Promise.resolve({ data: { user: ok ? { id: "u1", email: "dustinstohler1@gmail.com" } : null }, error: ok ? null : { message: "bad" } });
      },
      callIsAdminEmail: () => {
        gateCalls.push("is_admin_email");
        return Promise.resolve({ data: who === "admin", error: null });
      },
    },
  };
}

async function run(opts: {
  who?: "admin" | "non-admin" | "bad-token";
  env?: Record<string, string | undefined>;
  tables?: Tables;
  client?: Parameters<typeof fakeClient>[1];
  body?: unknown;
  notifyStatus?: number;
} = {}) {
  EVENTS = [];
  const gate = gateFor(opts.who ?? "admin");
  const tables = opts.tables ?? baseTables();
  const fc = fakeClient(tables, opts.client);
  const fetchCalls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    EVENTS.push(`fetch:${url.split("/").pop()}`);
    fetchCalls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve(new Response(JSON.stringify({ notified_count: 2 }), { status: opts.notifyStatus ?? 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  try {
    const r = new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.who === "non-admin" ? USER_JWT : ADMIN_JWT}` },
      body: JSON.stringify(opts.body ?? { order_id: ORDER }),
    });
    const res = await handler(r, (n) => (opts.env ?? ENV_ON)[n], fc.make, gate.deps);
    return { res, json: await res.json(), fetchCalls, writes: fc.writes, clientCalls: fc.calls, gateCalls: gate.gateCalls };
  } finally {
    globalThis.fetch = realFetch;
  }
}
// Shared event log across the fake client and the fetch stub, to assert ordering.
let EVENTS: string[] = [];
const notifyCalls = (c: { url: string }[]) => c.filter((x) => x.url === NOTIFY_URL);

Deno.test("admin + fulfilled report + flag on: claim released and notify-contractors invoked exactly once", async () => {
  const t = await run();
  assertEquals(t.res.status, 200);
  assertEquals(t.json.success, true);
  assertEquals(t.fetchCalls.length, 1);                       // nothing else on the wire: no Mailgun, no Twilio
  assertEquals(notifyCalls(t.fetchCalls).length, 1);          // exactly once
  assertEquals(t.fetchCalls[0].body, { claim_id: CLAIM });    // the existing new_opportunity path, body unchanged from Submit's
  assertEquals(t.fetchCalls[0].headers["Authorization"], `Bearer ${SERVICE_KEY}`);
  const upd = t.writes.filter((w) => w.table === "claims" && w.op === "update");
  assertEquals(upd.length, 1);
  assertEquals(upd[0].payload.status, "active");
  assertEquals(upd[0].payload.ready_for_bids, true);
  assert(typeof upd[0].payload.roofing_bid_released_at === "string");
  assertEquals("gutters_bid_released_at" in upd[0].payload, false); // only the claim's own trades
  const log = t.writes.filter((w) => w.table === "activity_log" && w.op === "insert");
  assertEquals(log.map((l) => l.payload.event_type), ["measurement_handoff_release_pending", "measurement_handoff_to_contractors"]);
  assertEquals((log[1].payload.metadata as Row).order_id, ORDER);
});

Deno.test("ordering: claim released, THEN pending row, THEN notify-contractors, THEN the hand-off (done) row", async () => {
  await run();
  assertEquals(EVENTS, ["update:claims", "insert:activity_log", "fetch:notify-contractors", "insert:activity_log"]);
});

Deno.test("re-save after a completed hand-off: skipped, notify-contractors NOT invoked again", async () => {
  const t = await run({ tables: baseTables({ activity_log: [{ id: "prior", event_type: "measurement_handoff_to_contractors", metadata: { order_id: ORDER } }] }) });
  assertEquals(t.res.status, 200);
  assertEquals(t.json.reason, "already_handed_off");
  assertEquals(t.fetchCalls.length, 0);
  assertEquals(t.writes.length, 0);
});

Deno.test("claim already open (homeowner clicked Submit first): skipped, contractors not told twice", async () => {
  const t = await run({ tables: baseTables({ claims: [{ id: CLAIM, status: "active", ready_for_bids: true, trades: ["roofing"], is_test: false }] }) });
  assertEquals(t.json.reason, "already_released");
  assertEquals(t.fetchCalls.length, 0);
  assertEquals(t.writes.length, 0);
});

Deno.test("NEGATIVE: a signed-in non-admin is refused 403; no write, no fetch", async () => {
  const t = await run({ who: "non-admin" });
  assertEquals(t.res.status, 403);
  assertEquals(t.fetchCalls.length, 0);
  assertEquals(t.writes.length, 0);
  assertEquals(t.clientCalls.length, 0);
});

Deno.test("NEGATIVE: an invalid token is refused 401; no write, no fetch", async () => {
  const t = await run({ who: "bad-token" });
  assertEquals(t.res.status, 401);
  assertEquals(t.fetchCalls.length, 0);
  assertEquals(t.writes.length, 0);
});

Deno.test("NEGATIVE: report not fulfilled (order not 'completed') is refused 409; claim untouched, nobody notified", async () => {
  for (const status of ["awaiting_fulfillment", "pending", "refunded", null]) {
    const t = await run({ tables: baseTables({ hover_orders: [{ id: ORDER, claim_id: CLAIM, user_id: HOMEOWNER, status, requested_by_role: "homeowner" }] }) });
    assertEquals(t.res.status, 409, `status ${status}`);
    assertEquals(t.json.error, "report_not_fulfilled");
    assertEquals(t.fetchCalls.length, 0);
    assertEquals(t.writes.length, 0);
  }
});

Deno.test("NEGATIVE: contractor-requested and unspecified-role orders do not open a homeowner's claim", async () => {
  for (const role of ["contractor", "unspecified"]) {
    const t = await run({ tables: baseTables({ hover_orders: [{ id: ORDER, claim_id: CLAIM, user_id: HOMEOWNER, status: "completed", requested_by_role: role }] }) });
    assertEquals(t.res.status, 409);
    assertEquals(t.fetchCalls.length, 0);
    assertEquals(t.writes.length, 0);
  }
});

Deno.test("NEGATIVE: order not found 404; missing/invalid order_id 400", async () => {
  assertEquals((await run({ tables: baseTables({ hover_orders: [] }) })).res.status, 404);
  assertEquals((await run({ body: {} })).res.status, 400);
  assertEquals((await run({ body: { order_id: "not-a-uuid" } })).res.status, 400);
});

Deno.test("FLAG OFF: nothing changes -- 200 skipped, no gate call, no client, no write, no fetch (unset, false, TRUE, 1, empty)", async () => {
  for (const v of [undefined, "false", "TRUE", "1", ""]) {
    const t = await run({ env: { ...ENV_ON, MEASUREMENT_CHARGE_ENABLED: v } });
    assertEquals(t.res.status, 200, `flag ${v}`);
    assertEquals(t.json.reason, "flag_off");
    assertEquals(t.fetchCalls.length, 0);
    assertEquals(t.writes.length, 0);
    assertEquals(t.clientCalls.length, 0);
    assertEquals(t.gateCalls.length, 0);
  }
  assertEquals(flagIsOn("true"), true);
  assertEquals(flagIsOn(undefined), false);
});

Deno.test("windows claims are refused (gh-3783 / D-375), as Submit does", async () => {
  const t = await run({ tables: baseTables({ claims: [{ id: CLAIM, status: "draft", ready_for_bids: false, trades: ["roofing", "windows"], is_test: false }] }) });
  assertEquals(t.res.status, 422);
  assertEquals(t.fetchCalls.length, 0);
  assertEquals(t.writes.length, 0);
});

Deno.test("claim in a status the hand-off must not touch (waitlisted / bidding / contract_signed) is refused", async () => {
  for (const status of ["waitlisted", "bidding", "contract_signed", "awarded"]) {
    const t = await run({ tables: baseTables({ claims: [{ id: CLAIM, status, ready_for_bids: false, trades: ["roofing"], is_test: false }] }) });
    assertEquals(t.res.status, 409, status);
    assertEquals(t.fetchCalls.length, 0);
    assertEquals(t.writes.length, 0);
  }
});

Deno.test("the gh-2559 bid-open guard refusing the release (estimate not read yet) sends nothing and writes no hand-off row", async () => {
  const t = await run({ client: { updateError: { message: "[gh2559-bid-open:unread_estimate] PLACEHOLDER" }, updateRows: null } });
  assertEquals(t.res.status, 409);
  assertEquals(t.json.error, "bid_open_guard_refused");
  assertEquals(t.fetchCalls.length, 0);
  assertEquals(t.writes.filter((w) => w.table === "activity_log").length, 0);
});

Deno.test("zero rows updated is not success: nothing sent", async () => {
  const t = await run({ client: { updateRows: [] } });
  assertEquals(t.res.status, 409);
  assertEquals(t.fetchCalls.length, 0);
});

const PENDING_ROWS = (t: Tables) => (t.activity_log ?? []).filter((r) => r.event_type === "measurement_handoff_release_pending");
const DONE_ROWS = (t: Tables) => (t.activity_log ?? []).filter((r) => r.event_type === "measurement_handoff_to_contractors");

Deno.test("notify-contractors failing: 502, alert logged, a PENDING row (not a done row) is left for the retry", async () => {
  const tables = baseTables();
  const t = await run({ tables, notifyStatus: 500 });
  assertEquals(t.res.status, 502);
  assertEquals(t.json.released, true);
  assertEquals(t.json.notified, false);
  assertEquals(notifyCalls(t.fetchCalls).length, 1);
  assertEquals(PENDING_ROWS(tables).length, 1);
  assertEquals(DONE_ROWS(tables).length, 0);
  assertEquals(t.writes.filter((w) => w.table === "platform_alerts_log").length, 1);
  assertEquals(EVENTS, ["update:claims", "insert:activity_log", "fetch:notify-contractors", "insert:platform_alerts_log"]);
});

Deno.test("RETRY (blocking finding of review 7102446666): fail, then re-save: notify-contractors called once and succeeds, claim not re-written", async () => {
  const tables = baseTables();
  const first = await run({ tables, notifyStatus: 500 });
  assertEquals(first.res.status, 502);
  assertEquals(tables.claims[0].ready_for_bids, true); // post-state of the failed run: claim open, contractors not told
  const second = await run({ tables, notifyStatus: 200 });
  assertEquals(second.res.status, 200);
  assertEquals(second.json.success, true);
  assertEquals(second.json.notified, true);
  assertEquals(second.json.retried, true);
  assertEquals(notifyCalls(second.fetchCalls).length, 1);
  assertEquals(second.writes.filter((w) => w.table === "claims").length, 0); // no second release
  assertEquals(DONE_ROWS(tables).length, 1);
  assertEquals(PENDING_ROWS(tables).length, 1); // not duplicated
});

Deno.test("SUCCESS then re-save: notify-contractors NOT called again (once per success)", async () => {
  const tables = baseTables();
  const first = await run({ tables });
  assertEquals(notifyCalls(first.fetchCalls).length, 1);
  const second = await run({ tables });
  assertEquals(second.res.status, 200);
  assertEquals(second.json.reason, "already_handed_off");
  assertEquals(second.fetchCalls.length, 0);
  assertEquals(second.writes.length, 0);
  const third = await run({ tables });
  assertEquals(third.fetchCalls.length, 0);
});

Deno.test("RETRY after a retry that succeeded: a third save does not notify (exactly once per success)", async () => {
  const tables = baseTables();
  await run({ tables, notifyStatus: 500 });
  const ok = await run({ tables });
  assertEquals(notifyCalls(ok.fetchCalls).length, 1);
  const again = await run({ tables });
  assertEquals(again.fetchCalls.length, 0);
  assertEquals(again.json.reason, "already_handed_off");
});

Deno.test("429 from notify-contractors: 502 with notify_status 429, pending kept, alert names the status; retry then succeeds once", async () => {
  const tables = baseTables();
  const first = await run({ tables, notifyStatus: 429 });
  assertEquals(first.res.status, 502);
  assertEquals(first.json.error, "notify_failed");
  assertEquals(first.json.notify_status, 429);
  assertEquals(PENDING_ROWS(tables).length, 1);
  assertEquals(DONE_ROWS(tables).length, 0);
  const alert = first.writes.find((w) => w.table === "platform_alerts_log");
  assert(String(alert?.payload.message).includes("429"));
  const stillLimited = await run({ tables, notifyStatus: 429 }); // second try also limited: still owed, still no done row
  assertEquals(stillLimited.res.status, 502);
  assertEquals(notifyCalls(stillLimited.fetchCalls).length, 1);
  assertEquals(PENDING_ROWS(tables).length, 1); // pending not duplicated across failures
  const third = await run({ tables, notifyStatus: 200 });
  assertEquals(third.res.status, 200);
  assertEquals(notifyCalls(third.fetchCalls).length, 1);
  assertEquals(DONE_ROWS(tables).length, 1);
});

Deno.test("claim opened by the homeowner's Submit (no pending row): a re-save does not notify", async () => {
  const tables = baseTables({ claims: [{ id: CLAIM, status: "active", ready_for_bids: true, trades: ["roofing"], is_test: false }] });
  const t = await run({ tables });
  assertEquals(t.json.reason, "already_released");
  assertEquals(t.fetchCalls.length, 0);
});

Deno.test("pending row but the claim has moved on (bidding): not re-notified", async () => {
  const tables = baseTables({
    claims: [{ id: CLAIM, status: "bidding", ready_for_bids: true, trades: ["roofing"], is_test: false }],
    activity_log: [{ event_type: "measurement_handoff_release_pending", metadata: { order_id: ORDER } }],
  });
  const t = await run({ tables });
  assertEquals(t.json.reason, "already_released");
  assertEquals(t.fetchCalls.length, 0);
});

Deno.test("pending row for a claim the guard has since closed again (ready_for_bids false): normal release path, one pending row", async () => {
  const tables = baseTables({ activity_log: [{ event_type: "measurement_handoff_release_pending", metadata: { order_id: ORDER } }] });
  const t = await run({ tables });
  assertEquals(t.res.status, 200);
  assertEquals(notifyCalls(t.fetchCalls).length, 1);
  assertEquals(t.writes.filter((w) => w.table === "claims").length, 1);
});

Deno.test("done marker cannot be written after a successful notify: 502 handoff_record_failed, admin alert says do NOT re-save", async () => {
  const tables = baseTables();
  const t = await run({ tables, client: { failInsert: (table, p) => table === "activity_log" && p.event_type === "measurement_handoff_to_contractors" } });
  assertEquals(t.res.status, 502);
  assertEquals(t.json.error, "handoff_record_failed");
  assertEquals(t.json.notified, true);
  const alert = t.writes.find((w) => w.table === "platform_alerts_log");
  assert(String(alert?.payload.message).includes("Do NOT re-save"));
});

Deno.test("pending marker insert failing does not stop the notify (contractors are still told)", async () => {
  const tables = baseTables();
  const t = await run({ tables, client: { failInsert: (table, p) => table === "activity_log" && p.event_type === "measurement_handoff_release_pending" } });
  assertEquals(t.res.status, 200);
  assertEquals(notifyCalls(t.fetchCalls).length, 1);
});

Deno.test("planHandOff: pure decisions", () => {
  const now = "2026-11-23T02:00:00Z";
  const o = { id: ORDER, claim_id: CLAIM, status: "completed", requested_by_role: null };
  const c = { id: CLAIM, status: "documents_needed", ready_for_bids: null, trades: ["roofing", "gutters", "siding"], roofing_bid_released_at: null, gutters_bid_released_at: "earlier" };
  const p = planHandOff(o, c, now);
  assert(p.action === "release");
  assertEquals(p.patch, { status: "active", ready_for_bids: true, roofing_bid_released_at: now }); // gutters already stamped, siding waits (D-164)
  assertEquals(planHandOff(null, c, now), { action: "refuse", status: 404, reason: "order_not_found" });
  assertEquals(planHandOff({ ...o, status: "awaiting_fulfillment" }, c, now), { action: "refuse", status: 409, reason: "report_not_fulfilled" });
});

Deno.test("wiring: flag check precedes the admin gate, the gate precedes the client; no mail/SMS code, no contractor wording", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const iFlag = src.indexOf("flagIsOn(getEnv(FLAG_ENV))");
  const iGate = src.indexOf("await requireAdmin(");
  const iClient = src.indexOf("makeClient(supabaseUrl, serviceKey)");
  const iNotify = src.indexOf("/functions/v1/notify-contractors");
  assert(iFlag > 0 && iFlag < iGate && iGate < iClient && iClient < iNotify, "order: flag, admin gate, client, notify");
  for (const banned of ["mailgun", "twilio", "Subject", "formData"]) {
    assertEquals(src.toLowerCase().includes(banned.toLowerCase()), false, banned);
  }
});
