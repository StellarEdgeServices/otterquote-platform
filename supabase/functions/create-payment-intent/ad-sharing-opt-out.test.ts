// gh-2107 / D-330 half 2 -- the GPC advertising-sharing opt-out recorded at PaymentIntent creation.
// Dustin's ruling "b." (#2078 comment 5801822166), scope item 2: the client reads navigator.globalPrivacyControl and the
// server honours Sec-GPC: 1; either one sets the flag. Written before the wiring in index.ts.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  detectGpcSignal,
  makeGpcStore,
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
const adSharingOptOutSrc = await Deno.readTextFile(new URL("./ad-sharing-opt-out.ts", import.meta.url));

Deno.test("index.ts imports and calls recordGpcOptOut exactly once, AFTER the caller is authenticated and the body is parsed", () => {
  assert(index.includes('from "./ad-sharing-opt-out.ts"'));
  const calls = index.split("recordGpcOptOut(").length - 1;
  assertEquals(calls, 1);
  const authAt = index.indexOf("callerId = caller.id");
  const parseAt = index.indexOf("await req.json()");
  const callAt = index.indexOf("recordGpcOptOut(");
  assert(authAt > 0 && parseAt > authAt && callAt > parseAt, "call must come after auth and body parse");
});

Deno.test("index.ts builds its store via makeGpcStore(supabase), and makeGpcStore writes the three profile columns, sets TRUE only, and never clears the flag", () => {
  const wireI = index.indexOf("makeGpcStore");
  assert(wireI > 0, "index.ts must build the store via the importable makeGpcStore, not an inline object");
  assert(index.includes('from "./ad-sharing-opt-out.ts"'));

  const src = adSharingOptOutSrc;
  const fnAt = src.indexOf("export function makeGpcStore");
  assert(fnAt > 0, "makeGpcStore is defined in ad-sharing-opt-out.ts");
  const i = src.indexOf("markOptedOut", fnAt);
  assert(i > fnAt, "the store's markOptedOut is defined inside makeGpcStore");
  const block = src.slice(i, i + 900);
  assert(block.includes('.from("profiles")'));
  assert(/ad_sharing_opt_out:\s*true/.test(block), "sets TRUE");
  assert(!/ad_sharing_opt_out:\s*false/.test(block) && !/ad_sharing_opt_out:\s*null/.test(block), "never writes false or null");
  assert(block.includes("ad_sharing_opt_out_at") && block.includes("ad_sharing_opt_out_source"));
  assert(block.includes('.eq("id", userId)'), "scoped to the caller's own row");
});

// -- gh-2105 (decision a-with-alert, legal/consent) --------------------------
// The first-round fix (batch 7 as originally submitted) had no `.select()`, so a zero-row
// RLS/id-mismatch match returned `error: null` and this module's own recordGpcOptOut treated it as
// "recorded" -- a real GPC opt-out signal silently never persisted. Review 5860481443 must-fix 1:
// simply checking `.select()` then over-reports, since the write's own `.or(...)` guard makes a
// zero-row match the STEADY-STATE case whenever the flag is already true. makeGpcStore (extracted
// from the former index.ts inline object per must-fix 2) disambiguates by reading the flag back.
Deno.test("wiring: makeGpcStore selects the write and can report a zero-row match through the SAME failure-log path as a real error", () => {
  const src = adSharingOptOutSrc;
  const fnAt = src.indexOf("export function makeGpcStore");
  const i = src.indexOf("markOptedOut", fnAt);
  const block = src.slice(i, i + 1800);
  assert(block.includes('.select("id")'), 'must chain .select("id") to see whether a row actually matched');
  assert(block.includes('"gh2105_zero_rows"'), "zero-row outcome must use the gh-2105 repo-wide sentinel code");
  // The zero-row branch must return a `{ code }` shape -- NOT throw and NOT
  // silently return null -- so it flows through recordGpcOptOut's existing
  // `if (failure) { log(...) }` branch above (payment stays unaffected,
  // same non-blocking contract every other outcome here already has).
  assert(!/if \(!Array\.isArray\(data\)[\s\S]{0,50}throw/.test(block), "the zero-row check must not throw -- payment must proceed either way");
});

// -- gh-2105 must-fix 2 (real behavioral coverage of makeGpcStore itself) ----
// Review 5860481443 must-fix 2: the old "mutation control" test drove a hand-scripted store that
// returned `{ code: "gh2105_zero_rows" }` directly -- it never called the actual fix code, so it
// passed against the unfixed b8cce8d5 sources too. These tests call the REAL `makeGpcStore` against
// a fake Supabase client that answers both calls it issues: the update chain
// (`.update().eq().or().select()`) and the disambiguating read (`.select().eq().maybeSingle()`).
interface FakeProfilesClient {
  client: { from(table: string): unknown };
  updateCalls: Record<string, unknown>[];
  readCalls: string[];
}
function fakeProfilesClient(
  updateResult: { error: { code?: string } | null; data: unknown[] | null },
  readResult: { error: { code?: string } | null; data: { ad_sharing_opt_out?: boolean } | null },
): FakeProfilesClient {
  const updateCalls: Record<string, unknown>[] = [];
  const readCalls: string[] = [];
  const client = {
    from(_table: string) {
      return {
        update(values: Record<string, unknown>) {
          updateCalls.push(values);
          return {
            eq(_col: string, _val: string) {
              return {
                or(_filter: string) {
                  return { select: (_cols: string) => Promise.resolve(updateResult) };
                },
              };
            },
          };
        },
        select(cols: string) {
          readCalls.push(cols);
          return {
            eq(_col: string, _val: string) {
              return { maybeSingle: () => Promise.resolve(readResult) };
            },
          };
        },
      };
    },
  };
  return { client, updateCalls, readCalls };
}

Deno.test("makeGpcStore: a zero-row match where the flag is ALREADY true is a no-op, NOT a reported failure", async () => {
  // FAIL-FIRST against the naive must-fix-1 shape (checks `.select()` but has no read-back): that
  // code returns { code: "gh2105_zero_rows" } here too -- the exact over-reporting bug must-fix 1
  // flagged (steady-state GPC re-sends on an already-opted-out user would spam the failure log).
  const { client, updateCalls, readCalls } = fakeProfilesClient(
    { error: null, data: [] },
    { error: null, data: { ad_sharing_opt_out: true } },
  );
  const store = makeGpcStore(client);
  const result = await store.markOptedOut(USER, "gpc_header", AT.toISOString());
  assertEquals(result, null, "already-opted-out zero-row match must not be a failure");
  assertEquals(updateCalls.length, 1);
  assertEquals(readCalls.length, 1, "must read the flag back to disambiguate the zero-row match");
});

Deno.test("makeGpcStore: a zero-row match where the flag is NOT already true reports gh2105_zero_rows", async () => {
  for (const notYetOptedOut of [{ ad_sharing_opt_out: false }, {}, null]) {
    const { client } = fakeProfilesClient({ error: null, data: [] }, { error: null, data: notYetOptedOut });
    const store = makeGpcStore(client);
    const result = await store.markOptedOut(USER, "gpc_header", AT.toISOString());
    assertEquals(result, { code: "gh2105_zero_rows" }, `case ${JSON.stringify(notYetOptedOut)}`);
  }
});

Deno.test("makeGpcStore: a successful (non-zero-row) update never triggers the disambiguating read", async () => {
  const { client, readCalls } = fakeProfilesClient({ error: null, data: [{ id: USER }] }, { error: null, data: null });
  const store = makeGpcStore(client);
  const result = await store.markOptedOut(USER, "gpc_header", AT.toISOString());
  assertEquals(result, null);
  assertEquals(readCalls.length, 0, "a matched row needs no disambiguating read");
});

Deno.test("makeGpcStore: a genuine database error on the update is returned as-is (no read-back)", async () => {
  const { client, readCalls } = fakeProfilesClient({ error: { code: "23514" }, data: null }, { error: null, data: null });
  const store = makeGpcStore(client);
  const result = await store.markOptedOut(USER, "gpc_header", AT.toISOString());
  assertEquals(result, { code: "23514" });
  assertEquals(readCalls.length, 0);
});

Deno.test("mutation control: makeGpcStore's real zero-row-miss branch feeds recordGpcOptOut's existing failure-log path exactly like a database error", async () => {
  const { client } = fakeProfilesClient({ error: null, data: [] }, { error: null, data: { ad_sharing_opt_out: false } });
  const store = makeGpcStore(client);
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
  assertEquals(outcome, "failed", "a genuine zero-row miss must NOT be reported as recorded");
  assertEquals(logs.length, 1);
  assert(logs[0].includes("(code gh2105_zero_rows)") && logs[0].includes("payment unaffected"));
});
