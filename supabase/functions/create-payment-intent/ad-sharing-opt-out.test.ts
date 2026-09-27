// gh-2107 / D-330 half 2 -- the GPC advertising-sharing opt-out recorded at PaymentIntent creation.
// Dustin's ruling "b." (#2078 comment 5801822166), scope item 2: the client reads navigator.globalPrivacyControl and the
// server honours Sec-GPC: 1; either one sets the flag. Written before the wiring in index.ts.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  detectGpcSignal,
  OPT_OUT_PI_TYPES,
  type OptOutSource,
  type OptOutStore,
  recordGpcOptOut,
} from "./ad-sharing-opt-out.ts";

const USER = "11111111-2222-4333-8444-555555555555";
const AT = new Date("2026-09-24T01:00:00.000Z");

function hdrs(h: Record<string, string> = {}): Headers {
  return new Headers(h);
}
interface Call { userId: string; source: OptOutSource; at: string }
function fakeStore(result: { code?: string } | null | "throw" = null): { store: OptOutStore; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    store: {
      markOptedOut: (userId, source, atIso) => {
        calls.push({ userId, source, at: atIso });
        if (result === "throw") return Promise.reject(new Error('duplicate key value violates "secret_constraint" Key (id)=(999)'));
        return Promise.resolve(result);
      },
    },
  };
}
async function run(over: Partial<Parameters<typeof recordGpcOptOut>[0]> = {}) {
  const { store, calls } = fakeStore();
  const logs: string[] = [];
  const outcome = await recordGpcOptOut({
    callerId: USER,
    piType: "hover_measurement",
    headers: hdrs({ "Sec-GPC": "1" }),
    body: {},
    store,
    now: () => AT,
    log: (m) => logs.push(m),
    ...over,
  });
  return { outcome, calls, logs };
}

// -- the signal --------------------------------------------------------------
Deno.test("detectGpcSignal: Sec-GPC: 1 is the header signal; header name is case-insensitive; surrounding space tolerated", () => {
  assertEquals(detectGpcSignal(hdrs({ "Sec-GPC": "1" }), {}), "gpc_header");
  assertEquals(detectGpcSignal(hdrs({ "sec-gpc": " 1 " }), {}), "gpc_header");
});

Deno.test("detectGpcSignal: absent, '0', '2', 'true', empty are NOT a header signal (only '1' means opt out)", () => {
  for (const v of ["0", "2", "true", "", "yes", "1x"]) assertEquals(detectGpcSignal(hdrs({ "Sec-GPC": v }), {}), null, `value ${JSON.stringify(v)}`);
  assertEquals(detectGpcSignal(hdrs(), {}), null);
});

Deno.test("detectGpcSignal: body gpc === true is the client signal; a string, a number, false or a missing field are not", () => {
  assertEquals(detectGpcSignal(hdrs(), { gpc: true }), "gpc_client");
  for (const v of ["true", 1, "1", false, null, undefined, {}, []]) assertEquals(detectGpcSignal(hdrs(), { gpc: v }), null, `gpc ${JSON.stringify(v)}`);
  for (const b of [null, undefined, "gpc", 5, true]) assertEquals(detectGpcSignal(hdrs(), b), null);
});

Deno.test("detectGpcSignal: the header wins when both are present, and either alone is enough", () => {
  assertEquals(detectGpcSignal(hdrs({ "Sec-GPC": "1" }), { gpc: true }), "gpc_header");
  assertEquals(detectGpcSignal(hdrs({ "Sec-GPC": "0" }), { gpc: true }), "gpc_client");
});

// -- the write ---------------------------------------------------------------
Deno.test("recordGpcOptOut: a header signal writes the flag once, for the CALLER, with source gpc_header and the injected time", async () => {
  const r = await run();
  assertEquals(r.outcome, "recorded");
  assertEquals(r.calls, [{ userId: USER, source: "gpc_header", at: "2026-09-24T01:00:00.000Z" }]);
  assertEquals(r.logs.length, 0);
});

Deno.test("recordGpcOptOut: a client-only signal records source gpc_client", async () => {
  const r = await run({ headers: hdrs(), body: { gpc: true } });
  assertEquals(r.outcome, "recorded");
  assertEquals(r.calls[0].source, "gpc_client");
});

Deno.test("recordGpcOptOut: NO signal writes nothing (it never clears or touches the flag)", async () => {
  for (const [h, b] of [[hdrs(), {}], [hdrs({ "Sec-GPC": "0" }), { gpc: false }], [hdrs(), null]] as const) {
    const r = await run({ headers: h, body: b });
    assertEquals(r.outcome, "no_signal");
    assertEquals(r.calls.length, 0);
  }
});

Deno.test("recordGpcOptOut: only measurement PaymentIntents record it; a platform fee, an escrow, a missing type do not", async () => {
  assertEquals([...OPT_OUT_PI_TYPES].sort(), ["hover_measurement", "measurement_order"]);
  for (const t of ["measurement_order", "hover_measurement"]) assertEquals((await run({ piType: t })).outcome, "recorded", t);
  for (const t of ["platform_fee", "deductible_escrow", "measurement_upgrade", "", undefined, null, 7]) {
    const r = await run({ piType: t });
    assertEquals(r.outcome, "not_applicable", String(t));
    assertEquals(r.calls.length, 0);
  }
});

Deno.test("recordGpcOptOut: no authenticated caller (service-role call) means nothing is recorded", async () => {
  const r = await run({ callerId: null });
  assertEquals(r.outcome, "not_applicable");
  assertEquals(r.calls.length, 0);
});

// -- failure never blocks payment, never leaks database text ------------------
Deno.test("recordGpcOptOut: a store failure is swallowed (payment unaffected) and logged with a FIXED message plus a safe code only", async () => {
  const { store } = fakeStore({ code: "23514" });
  const logs: string[] = [];
  const outcome = await recordGpcOptOut({ callerId: USER, piType: "hover_measurement", headers: hdrs({ "Sec-GPC": "1" }), body: {}, store, log: (m) => logs.push(m) });
  assertEquals(outcome, "failed");
  assertEquals(logs.length, 1);
  assert(logs[0].includes("(code 23514)") && logs[0].includes("payment unaffected"));
});

Deno.test("recordGpcOptOut: a code that is not a short alphanumeric token is dropped (a message cannot ride in the code)", async () => {
  const { store } = fakeStore({ code: 'bad code with spaces and an address 1 Main St' });
  const logs: string[] = [];
  await recordGpcOptOut({ callerId: USER, piType: "hover_measurement", headers: hdrs({ "Sec-GPC": "1" }), body: {}, store, log: (m) => logs.push(m) });
  assert(!logs[0].includes("Main St") && !logs[0].includes("code "), logs[0]);
});

Deno.test("recordGpcOptOut: a thrown error is swallowed and NOTHING from it (database text) reaches the log", async () => {
  const { store } = fakeStore("throw");
  const logs: string[] = [];
  const outcome = await recordGpcOptOut({ callerId: USER, piType: "hover_measurement", headers: hdrs({ "Sec-GPC": "1" }), body: {}, store, log: (m) => logs.push(m) });
  assertEquals(outcome, "failed");
  const all = logs.join("\n");
  for (const s of ["duplicate key", "secret_constraint", "999"]) assert(!all.includes(s), `must not forward: ${s}`);
});

// -- structure: it is wired into index.ts, after auth, for the caller only -----
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("index.ts imports and calls recordGpcOptOut exactly once, AFTER the caller is authenticated and the body is parsed", () => {
  assert(index.includes('from "./ad-sharing-opt-out.ts"'));
  const calls = index.split("recordGpcOptOut(").length - 1;
  assertEquals(calls, 1);
  const authAt = index.indexOf("callerId = caller.id");
  const parseAt = index.indexOf("await req.json()");
  const callAt = index.indexOf("recordGpcOptOut(");
  assert(authAt > 0 && parseAt > authAt && callAt > parseAt, "call must come after auth and body parse");
});

Deno.test("index.ts writes the three profile columns for the caller, sets TRUE only, and never clears the flag", () => {
  const i = index.indexOf("markOptedOut");
  assert(i > 0, "the store is defined in index.ts");
  const block = index.slice(i, i + 900);
  assert(block.includes('.from("profiles")'));
  assert(/ad_sharing_opt_out:\s*true/.test(block), "sets TRUE");
  assert(!/ad_sharing_opt_out:\s*false/.test(block) && !/ad_sharing_opt_out:\s*null/.test(block), "never writes false or null");
  assert(block.includes("ad_sharing_opt_out_at") && block.includes("ad_sharing_opt_out_source"));
  assert(block.includes('.eq("id", userId)'), "scoped to the caller's own row");
});

// -- gh-2105 (decision a-with-alert, legal/consent) --------------------------
// index.ts's markOptedOut had no `.select()`, so a zero-row RLS/id-mismatch
// match returned `error: null` and this module's own recordGpcOptOut treated
// it as "recorded" -- a real GPC opt-out signal silently never persisted,
// with none of the existing failure-log visibility this file already has for
// a genuine database error. FAIL-FIRST: on origin/k72/gh2105-batch6's
// (pre-batch-7) index.ts, none of these assertions hold -- there is no
// `.select("id")` chained and no `gh2105_zero_rows` code.
Deno.test("wiring: markOptedOut selects the write and reports a zero-row match through the SAME failure-log path as a real error", () => {
  const i = index.indexOf("markOptedOut");
  const block = index.slice(i, i + 1400);
  assert(block.includes('.select("id")'), 'must chain .select("id") to see whether a row actually matched');
  assert(block.includes('"gh2105_zero_rows"'), "zero-row outcome must use the gh-2105 repo-wide sentinel code");
  // The zero-row branch must return a `{ code }` shape -- NOT throw and NOT
  // silently return null -- so it flows through recordGpcOptOut's existing
  // `if (failure) { log(...) }` branch above (payment stays unaffected,
  // same non-blocking contract every other outcome here already has).
  assert(!/if \(!Array\.isArray\(data\)[\s\S]{0,50}throw/.test(block), "the zero-row check must not throw -- payment must proceed either way");
});

Deno.test("mutation control: a zero-row match (empty data array, no error) now yields code gh2105_zero_rows instead of silently succeeding", async () => {
  // Exercises the actual gpcStore built in index.ts is out of reach without a
  // live Supabase client, so this proves the CONTRACT recordGpcOptOut relies
  // on: any store whose markOptedOut distinguishes a zero-row match this way
  // surfaces it through the existing failure-log path, unchanged by this fix.
  const calls: Call[] = [];
  const store: OptOutStore = {
    markOptedOut: (userId, source, atIso) => {
      calls.push({ userId, source, at: atIso });
      // Simulates the real fix's shape: error is null, but data was [] --
      // pre-fix code only checked `error` and would have returned `null`
      // (success) here.
      return Promise.resolve({ code: "gh2105_zero_rows" });
    },
  };
  const logs: string[] = [];
  const outcome = await recordGpcOptOut({
    callerId: USER,
    piType: "hover_measurement",
    headers: hdrs({ "Sec-GPC": "1" }),
    body: {},
    store,
    now: () => AT,
    log: (m) => logs.push(m),
  });
  assertEquals(outcome, "failed", "a zero-row match must NOT be reported as recorded");
  assertEquals(logs.length, 1);
  assert(logs[0].includes("(code gh2105_zero_rows)") && logs[0].includes("payment unaffected"));
});
