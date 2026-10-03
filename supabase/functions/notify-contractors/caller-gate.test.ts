// gh-2462 -- caller gate for notify-contractors (emails/SMS contractors), #2309 pattern plus
// the user-JWT + row-ownership half for the browser callers (see user-gate.ts).
//
// Drives the REAL exported handler with injected env, a fake supabase client (its
// auth.getUser accepts only USER_JWT) and a counting fetch stub (Mailgun and send-sms are
// fetches). NEGATIVE CONTROL: with the `authorizeNotifyCaller(...)` decision ignored in
// index.ts, the "refused" tests FAIL (the handler builds the client and starts the
// new_opportunity fan-out). Output is in the PR body.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ANON_JWT,
  BAD_BEARERS,
  BASE_ENV,
  type Env,
  fakeSupabase,
  OTHER_USER_ID,
  req,
  type Rows,
  SECRET_DEFAULT,
  SERVICE_KEY,
  USER_ID,
  USER_JWT,
  withFetchStub,
} from "../_shared/caller-gate-test-kit.ts";
import { handler } from "./index.ts";
import { authorizeNotifyCaller, type OwnershipLookups } from "./user-gate.ts";

const URL_ = "https://x.supabase.co/functions/v1/notify-contractors";
const CLAIM = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
const CONTRACTOR = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

// Rows answered by the fake client (filters ignored). The claim has no address, so a
// request that passes the gate stops at the location check (400) before any send.
const OWNED: Rows = {
  claims: [{ user_id: USER_ID, is_test: false, property_address: "", property_state: null }],
  contractors: [{ user_id: USER_ID }],
  quotes: [{ id: "q1" }],
};
const NOT_OWNED: Rows = {
  claims: [{ user_id: OTHER_USER_ID, is_test: false, property_address: "" }],
  contractors: [{ user_id: OTHER_USER_ID }],
  quotes: [{ id: "q1" }],
};

async function run(r: Request, rows: Rows = OWNED, env: Env = BASE_ENV) {
  const sb = fakeSupabase(rows);
  const { result, fetchCalls } = await withFetchStub(() => handler(r, (n) => env[n], sb.make));
  return { res: result, fetchCalls, clientCalls: sb.calls };
}
// Client calls other than building it and verifying the token (i.e. any DB read/write/rpc).
const sideEffects = (calls: string[]) => calls.filter((c) => c !== "createClient" && c !== "auth.getUser");

// Every body a real caller sends (browser and service).
const BODIES = [
  { claim_id: CLAIM },
  { event_type: "bid_accepted", claim_id: CLAIM },
  { event_type: "bid_update_confirmed", claim_id: CLAIM, contractor_id: CONTRACTOR },
  { event_type: "bid_renewal_requested", claim_id: CLAIM, contractor_id: CONTRACTOR },
  { event_type: "contract_signed", claim_id: CLAIM, message: "m" },
];

Deno.test("refused credentials -> 401: no Mailgun/SMS fetch, no rate-limit rpc, no fan-out query", async () => {
  for (const body of BODIES) {
    for (const [label, auth] of BAD_BEARERS) {
      const r = await run(req(URL_, body, auth));
      assertEquals(r.res.status, 401, `${label} ${JSON.stringify(body)}`);
      assertEquals(r.fetchCalls.length, 0, `no fetch for ${label}`);
      assertEquals(sideEffects(r.clientCalls), [], `no side-effect client call for ${label}`);
      // only the legacy-anon JWT shape is ever shown to auth; nothing else builds the client
      if (label !== "anon key (legacy JWT shape)") assertEquals(r.clientCalls.length, 0, label);
    }
  }
});

Deno.test("anon key (legacy JWT shape) is rejected by auth.getUser -> 401, no table read", async () => {
  const r = await run(req(URL_, { claim_id: CLAIM }, `Bearer ${ANON_JWT}`));
  assertEquals(r.res.status, 401);
  assertEquals(r.clientCalls, ["createClient", "auth.getUser"]);
});

Deno.test("service callers (both accepted keys) pass the gate for every event", async () => {
  for (const key of [SERVICE_KEY, SECRET_DEFAULT]) {
    for (const body of BODIES) {
      const r = await run(req(URL_, body, `Bearer ${key}`));
      assertNotEquals(r.res.status, 401, JSON.stringify(body));
      assertNotEquals(r.res.status, 403, JSON.stringify(body));
      assert(r.clientCalls.some((c) => c.startsWith("from:")), "past the gate the handler reads the DB");
      assert(!r.clientCalls.includes("auth.getUser"), "service callers never hit auth");
    }
  }
});

Deno.test("signed-in owner passes for each browser event", async () => {
  for (const body of BODIES.slice(0, 4)) {
    const r = await run(req(URL_, body, `Bearer ${USER_JWT}`));
    assertNotEquals(r.res.status, 401, JSON.stringify(body));
    assertNotEquals(r.res.status, 403, JSON.stringify(body));
  }
  // new_opportunity reaches the handler's own claims lookup (the next step)
  const r = await run(req(URL_, { claim_id: CLAIM }, `Bearer ${USER_JWT}`));
  assertEquals(r.res.status, 400); // fixture claim has no address -> location check, before any send
  assertEquals(r.fetchCalls.length, 0);
});

Deno.test("signed-in NON-owner -> 403 for each browser event, nothing sent", async () => {
  for (const body of BODIES.slice(0, 4)) {
    const r = await run(req(URL_, body, `Bearer ${USER_JWT}`), NOT_OWNED);
    assertEquals(r.res.status, 403, JSON.stringify(body));
    assertEquals(r.fetchCalls.length, 0);
    assert(!r.clientCalls.includes("rpc:check_rate_limit"));
  }
});

Deno.test("contractor without a quote on the claim -> 403", async () => {
  const rows = { ...OWNED, quotes: [] };
  for (const body of BODIES.slice(2, 4)) {
    const r = await run(req(URL_, body, `Bearer ${USER_JWT}`), rows);
    assertEquals(r.res.status, 403, JSON.stringify(body));
  }
});

Deno.test("signed-in user cannot fire service-only events -> 403", async () => {
  for (const event_type of ["contract_signed", "bid_expired", "agreement_requested", "something_else"]) {
    const r = await run(req(URL_, { event_type, claim_id: CLAIM, contractor_id: CONTRACTOR }, `Bearer ${USER_JWT}`));
    assertEquals(r.res.status, 403, event_type);
    assertEquals(r.fetchCalls.length, 0);
  }
});

Deno.test("health_check and OPTIONS stay ungated (platform-health-check ping)", async () => {
  const h = await run(req(URL_, { health_check: true }, null));
  assertEquals(h.res.status, 200);
  assertEquals(h.clientCalls.length, 0);
  const o = await run(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(o.res.status, 200);
});

// Pure unit tests of the decision (no handler).
function lookups(over: Partial<OwnershipLookups> = {}): OwnershipLookups {
  return {
    userIdForToken: (t) => Promise.resolve(t === USER_JWT ? USER_ID : null),
    claimOwnerId: () => Promise.resolve(USER_ID),
    contractorUserId: () => Promise.resolve(USER_ID),
    contractorHasQuote: () => Promise.resolve(true),
    ...over,
  };
}
const keys = [SERVICE_KEY, SECRET_DEFAULT];

Deno.test("user body is reduced to the fields the real caller sends (no fan-out steering)", async () => {
  const body = { claim_id: CLAIM, trade_types: ["roofing"], claim_zip: "00000", job_type: "x", claim_county: "y" };
  const d = await authorizeNotifyCaller(req(URL_, body, `Bearer ${USER_JWT}`), body, keys, lookups());
  assert(d.ok && d.caller === "user");
  assertEquals(d.body, { claim_id: CLAIM });
  const b2 = { event_type: "bid_update_confirmed", claim_id: CLAIM, contractor_id: CONTRACTOR, trade: "t", location: "l" };
  const d2 = await authorizeNotifyCaller(req(URL_, b2, `Bearer ${USER_JWT}`), b2, keys, lookups());
  assert(d2.ok);
  assertEquals(d2.body, { event_type: "bid_update_confirmed", claim_id: CLAIM, contractor_id: CONTRACTOR });
  // service callers keep their full body
  const d3 = await authorizeNotifyCaller(req(URL_, body, `Bearer ${SERVICE_KEY}`), body, keys, lookups());
  assert(d3.ok && d3.caller === "service");
  assertEquals(d3.body, body);
});

Deno.test("non-UUID ids and lookup failures fail closed", async () => {
  for (const body of [{ claim_id: "not-a-uuid" }, { claim_id: `${CLAIM}' or '1'='1` }, {}, { claim_id: 5 }]) {
    const d = await authorizeNotifyCaller(req(URL_, body, `Bearer ${USER_JWT}`), body as Record<string, unknown>, keys, lookups());
    assert(!d.ok && d.status === 403, JSON.stringify(body));
  }
  const d = await authorizeNotifyCaller(req(URL_, {}, `Bearer ${USER_JWT}`), { claim_id: CLAIM }, keys, lookups({ claimOwnerId: () => Promise.resolve(null) }));
  assert(!d.ok && d.status === 403);
});

Deno.test("index.ts wiring: the caller decision precedes the client build and Mailgun env read", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const live = (l: string) => !l.trim().startsWith("//");
  const at = (needle: string) => lines.findIndex((l) => live(l) && l.includes(needle));
  const handlerAt = at("export async function handler(");
  const gateAt = at("await authorizeNotifyCaller(req, peekBody");
  const denyAt = at("return deny(decision.status, corsHeaders)");
  assert(handlerAt > 0 && gateAt > handlerAt && denyAt > gateAt, "gate inside handler");
  assert(at("const supabase = getClient();") > denyAt, "service client used only after the gate");
  assert(at('getEnv("MAILGUN_API_KEY")') > denyAt, "Mailgun only after the gate");
  assert(src.includes('decision.caller === "service" ? await req.json() : decision.body'), "user body sanitized");
  assert(src.includes("if (import.meta.main)"), "serve() guarded by import.meta.main");
});
