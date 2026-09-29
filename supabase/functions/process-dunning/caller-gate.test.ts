// gh-2309 -- tests for the process-dunning inbound caller gate.
//
// NEGATIVE CONTROL: with the gate neutralised (gateResponse returning null, i.e.
// the pre-fix behaviour of "no inbound check"), the "anonymous ... 401" tests and
// the index.ts wiring test FAIL. Raw before/after output is in the PR body.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  acceptedServiceKeys,
  classifyRequest,
  constantTimeEqual,
  gateResponse,
  getServiceRoleKey,
  hasServiceBearer,
  isUuid,
  validateHomeownerChoice,
} from "./caller-gate.ts";
import { handler } from "./index.ts";

const KEY = "fixture-runtime-service-key-0123456789"; // runtime SUPABASE_SERVICE_ROLE_KEY
const ALT = "fixture-rotated-default-key-9876543210"; // SUPABASE_SECRET_KEYS.default (docusign-webhook's key)
const BASE = "https://x.supabase.co/functions/v1/process-dunning";
const CORS = { "Access-Control-Allow-Origin": "https://otterquote.com" };
const FAIL_ID = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";

const TRIGGER_BODY = JSON.stringify({ quote_id: "q", contractor_id: "c", claim_id: "cl", amount_cents: 99999999 });

type Env = Record<string, string | undefined>;
const ENV_BOTH: Env = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: KEY,
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: ALT }),
};
const ENV_LEGACY_ONLY: Env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY };
const ENV_EMPTY: Env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: "" };

/**
 * Drives the REAL exported handler from index.ts (classify -> gate -> body), with
 * env injected and global fetch replaced by a counting stub that answers every
 * PostgREST/vendor call with an empty 200 array. fetchCalls === 0 on a 401 proves
 * the gate ran before any DB/vendor I/O.
 */
async function runGate(req: Request, env: Env = ENV_BOTH) {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    return Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  try {
    const probe = req.clone(); // handler may consume the body
    const res = await handler(req, (n) => env[n]);
    const denied = res.status === 401 ? res : null;
    const peek = await probe.json().catch(() => ({}));
    return { route: classifyRequest(req, peek), res, denied, fetchCalls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("anonymous TRIGGER POST -> 401, zero I/O", async () => {
  const r = await runGate(new Request(BASE, { method: "POST", body: TRIGGER_BODY }));
  assertEquals(r.route.kind, "gated");
  assertEquals(r.res.status, 401);
  assertEquals(r.fetchCalls, 0);
});

Deno.test("anonymous CRON POST (empty body) and GET -> 401, zero I/O", async () => {
  for (const req of [new Request(BASE, { method: "POST" }), new Request(BASE, { method: "GET" })]) {
    const r = await runGate(req);
    assertEquals(r.res.status, 401);
    assertEquals(r.fetchCalls, 0);
  }
});

Deno.test("wrong bearer, anon-key-shaped bearer, non-Bearer scheme, near-miss keys -> 401 (both keys configured)", async () => {
  const headers = [
    "Bearer wrong",
    "Bearer eyJhbGciOiJIUzI1NiJ9.anon.sig",
    `Basic ${KEY}`,
    `Bearer ${KEY}x`,
    `Bearer ${KEY.slice(0, -1)}`,
    `Bearer ${ALT}x`,
    `Bearer ${ALT.slice(0, -1)}`,
    "Bearer ",
    KEY, // no scheme
  ];
  for (const h of headers) {
    const r = await runGate(new Request(BASE, { method: "POST", body: TRIGGER_BODY, headers: { Authorization: h } }));
    assertEquals(r.res.status, 401, `should reject Authorization: ${h}`);
    assertEquals(r.fetchCalls, 0, `no I/O for ${h}`);
  }
});

Deno.test("fail-closed: empty/unset env keys authorize nobody, even an empty bearer", async () => {
  const envs: Env[] = [
    ENV_EMPTY,
    { SUPABASE_URL: "https://x.supabase.co" }, // both unset
    { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: JSON.stringify({ default: "" }) },
    { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: "{not json" },
  ];
  for (const env of envs) {
    for (const h of ["Bearer ", "Bearer", "Bearer undefined", "Bearer null", "Bearer  "]) {
      const r = await runGate(new Request(BASE, { method: "POST", headers: { Authorization: h } }), env);
      assertEquals(r.res.status, 401, `${JSON.stringify(env)} + ${JSON.stringify(h)}`);
      assertEquals(r.fetchCalls, 0);
    }
    // the missing header entirely
    const r0 = await runGate(new Request(BASE, { method: "POST" }), env);
    assertEquals(r0.res.status, 401);
  }
});

Deno.test("accepted key 1: runtime SUPABASE_SERVICE_ROLE_KEY passes TRIGGER and CRON (real handler proceeds past the gate)", async () => {
  const auth = { Authorization: `Bearer ${KEY}` };
  const cron = await runGate(new Request(BASE, { method: "POST", body: "{}", headers: auth }));
  assert(cron.res.status !== 401, `CRON got ${cron.res.status}`);
  assert(cron.fetchCalls > 0, "CRON past the gate must reach the DB");
  const trig = await runGate(new Request(BASE, { method: "POST", body: TRIGGER_BODY, headers: auth }));
  assert(trig.res.status !== 401, `TRIGGER got ${trig.res.status}`);
  const lower = await runGate(new Request(BASE, { method: "POST", body: "{}", headers: { authorization: `bearer ${KEY}` } }));
  assert(lower.res.status !== 401);
  // also passes when only the legacy var exists (SUPABASE_SECRET_KEYS unset)
  const legacy = await runGate(new Request(BASE, { method: "POST", body: "{}", headers: auth }), ENV_LEGACY_ONLY);
  assert(legacy.res.status !== 401);
});

Deno.test("accepted key 2: getServiceRoleKey() value (SUPABASE_SECRET_KEYS.default, docusign-webhook's bearer) passes TRIGGER and CRON", async () => {
  const auth = { Authorization: `Bearer ${ALT}` };
  const cron = await runGate(new Request(BASE, { method: "POST", body: "{}", headers: auth }));
  assert(cron.res.status !== 401, `CRON got ${cron.res.status}`);
  assert(cron.fetchCalls > 0);
  const trig = await runGate(new Request(BASE, { method: "POST", body: TRIGGER_BODY, headers: auth }));
  assert(trig.res.status !== 401, `TRIGGER got ${trig.res.status}`);
});

Deno.test("wrong key fails with a different key configured, and a valid key from ANOTHER env is not accepted", async () => {
  const other = "fixture-someone-elses-key-000000000000";
  for (const env of [ENV_BOTH, ENV_LEGACY_ONLY]) {
    const r = await runGate(new Request(BASE, { method: "POST", body: "{}", headers: { Authorization: `Bearer ${other}` } }), env);
    assertEquals(r.res.status, 401);
    assertEquals(r.fetchCalls, 0);
  }
  // With only the legacy env configured, the rotated key is not accepted.
  const r2 = await runGate(new Request(BASE, { method: "POST", body: "{}", headers: { Authorization: `Bearer ${ALT}` } }), ENV_LEGACY_ONLY);
  assertEquals(r2.res.status, 401);
});

Deno.test("getServiceRoleKey / acceptedServiceKeys mirror docusign-webhook's helper", () => {
  const g = (env: Env) => (n: string) => env[n];
  assertEquals(getServiceRoleKey(g(ENV_BOTH)), ALT);
  assertEquals(getServiceRoleKey(g(ENV_LEGACY_ONLY)), KEY);
  assertEquals(getServiceRoleKey(g({ ...ENV_LEGACY_ONLY, SUPABASE_SECRET_KEYS: "{bad" })), KEY);
  assertEquals(getServiceRoleKey(g({})), "");
  assertEquals(acceptedServiceKeys(g(ENV_BOTH)), [KEY, ALT]);
  // gateResponse itself, and hasServiceBearer's list form, skip empty entries
  const req = new Request(BASE, { method: "POST", headers: { Authorization: "Bearer " } });
  assert(!hasServiceBearer(req, ["", undefined, null]));
  assertEquals(gateResponse({ kind: "gated" }, req, ["", ""], CORS)?.status, 401);
});

Deno.test("401 body leaks nothing and carries CORS + JSON headers", async () => {
  const r = await runGate(new Request(BASE, { method: "POST", body: TRIGGER_BODY }));
  assertEquals(await r.res.json(), { error: "Unauthorized" });
  assertEquals(r.res.headers.get("Content-Type"), "application/json");
});

Deno.test("homeowner_choice GET (emailed link) stays reachable with no bearer", async () => {
  const req = new Request(`${BASE}?mode=homeowner_choice&failure_id=${FAIL_ID}&choice=proceed`, { method: "GET" });
  const r = await runGate(req);
  assertEquals(r.route.kind, "homeowner_choice");
  assertEquals(r.denied, null);
});

Deno.test("homeowner_choice is GET-only: POST/PUT/DELETE with that mode are gated", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const init: RequestInit = method === "POST" || method === "PUT" || method === "PATCH" ? { method, body: "{}" } : { method };
    const r = await runGate(new Request(`${BASE}?mode=homeowner_choice&failure_id=${FAIL_ID}&choice=proceed`, init));
    assertEquals(r.route.kind, "gated", method);
    assertEquals(r.denied?.status, 401, method);
  }
});

Deno.test("homeowner_choice does not unlock TRIGGER/CRON: other modes and no-mode GET are gated", async () => {
  for (const qs of ["", "?mode=other", "?mode=Homeowner_Choice", "?failure_id=" + FAIL_ID]) {
    const r = await runGate(new Request(BASE + qs, { method: "GET" }));
    assertEquals(r.denied?.status, 401, qs);
  }
});

Deno.test("health_check and OPTIONS preflight stay ungated and do no I/O", async () => {
  const h = await runGate(new Request(BASE, { method: "POST", body: JSON.stringify({ health_check: true }) }));
  assertEquals(h.route.kind, "health");
  assertEquals(h.denied, null);
  assertEquals(h.fetchCalls, 0);
  const o = await runGate(new Request(BASE, { method: "OPTIONS" }));
  assertEquals(o.route.kind, "preflight");
  assertEquals(o.denied, null);
  // health_check:"true" (string) or false must NOT bypass the gate
  for (const b of [{ health_check: "true" }, { health_check: false }, { health_check: 1 }]) {
    const r = await runGate(new Request(BASE, { method: "POST", body: JSON.stringify({ ...b, quote_id: "q", contractor_id: "c" }) }));
    assertEquals(r.denied?.status, 401, JSON.stringify(b));
  }
});

Deno.test("homeowner token validation: failure_id must be a UUID, choice an enum", () => {
  const ok = validateHomeownerChoice(new URL(`${BASE}?mode=homeowner_choice&failure_id=${FAIL_ID}&choice=different`));
  assertEquals(ok, { ok: true, failureId: FAIL_ID, choice: "different" });
  const bad = [
    `?failure_id=${FAIL_ID}`, // missing choice
    `?choice=proceed`, // missing id
    `?failure_id=${FAIL_ID}&choice=delete`,
    `?failure_id=not-a-uuid&choice=proceed`,
    `?failure_id=${encodeURIComponent(FAIL_ID + "' or '1'='1")}&choice=proceed`,
    `?failure_id=${encodeURIComponent("*")}&choice=proceed`,
    `?failure_id=${FAIL_ID}%00&choice=proceed`,
  ];
  for (const qs of bad) {
    const r = validateHomeownerChoice(new URL(BASE + qs));
    assertEquals(r.ok, false, qs);
  }
  assert(isUuid(FAIL_ID.toUpperCase()));
  assert(!isUuid(null));
});

Deno.test("constantTimeEqual / hasServiceBearer basics", () => {
  assert(constantTimeEqual("abc", "abc"));
  assert(!constantTimeEqual("abc", "abd"));
  assert(!constantTimeEqual("abc", "abcd"));
  assert(!constantTimeEqual("", "a"));
  assert(hasServiceBearer(new Request(BASE, { headers: { Authorization: `Bearer ${KEY}` } }), KEY));
  assert(!hasServiceBearer(new Request(BASE), KEY));
});

// Structural pin: the deployed handler must route + gate BEFORE it builds the
// service-role client or reads the body, so a 401 provably precedes any DB/vendor I/O.
Deno.test("index.ts wiring: gateResponse runs before createClient(...) and before any .from(", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const idx = (needle: string) => lines.findIndex((l) => !l.trim().startsWith("//") && l.includes(needle));
  const serveAt = idx("export async function handler(");
  const gateAt = idx("gateResponse(route, req, acceptedServiceKeys(getEnv)");
  const clientAt = idx("const supabase    = createClient(");
  const firstFrom = lines.findIndex((l, i) => i > serveAt && !l.trim().startsWith("//") && l.includes(".from("));
  assert(serveAt > 0 && gateAt > serveAt, "gateResponse must be called inside serve()");
  assert(clientAt > gateAt, "service-role client must be created after the gate");
  assert(firstFrom > gateAt, "no DB read inside serve() before the gate");
  assert(src.includes("validateHomeownerChoice(url)"), "homeowner tokens must be validated");
});
