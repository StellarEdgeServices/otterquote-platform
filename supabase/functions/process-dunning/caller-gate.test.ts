// gh-2309 -- tests for the process-dunning inbound caller gate.
//
// NEGATIVE CONTROL: with the gate neutralised (gateResponse returning null, i.e.
// the pre-fix behaviour of "no inbound check"), the "anonymous ... 401" tests and
// the index.ts wiring test FAIL. Raw before/after output is in the PR body.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyRequest,
  constantTimeEqual,
  gateResponse,
  hasServiceBearer,
  isUuid,
  validateHomeownerChoice,
} from "./caller-gate.ts";

const KEY = "sb_secret_test_service_key_0123456789";
const BASE = "https://x.supabase.co/functions/v1/process-dunning";
const CORS = { "Access-Control-Allow-Origin": "https://otterquote.com" };
const FAIL_ID = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";

const TRIGGER_BODY = JSON.stringify({ quote_id: "q", contractor_id: "c", claim_id: "cl", amount_cents: 99999999 });

/** Runs the same classify -> gate sequence index.ts runs, counting any network I/O. */
async function runGate(req: Request, key: string | undefined = KEY) {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => { fetchCalls++; return Promise.reject(new Error("I/O attempted")); }) as typeof fetch;
  try {
    const peek = await req.clone().json().catch(() => ({}));
    const route = classifyRequest(req, peek);
    const denied = gateResponse(route, req, key, CORS);
    return { route, denied, fetchCalls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("anonymous TRIGGER POST -> 401, zero I/O", async () => {
  const r = await runGate(new Request(BASE, { method: "POST", body: TRIGGER_BODY }));
  assertEquals(r.route.kind, "gated");
  assertEquals(r.denied?.status, 401);
  assertEquals(r.fetchCalls, 0);
});

Deno.test("anonymous CRON POST (empty body) and GET -> 401, zero I/O", async () => {
  for (const req of [new Request(BASE, { method: "POST" }), new Request(BASE, { method: "GET" })]) {
    const r = await runGate(req);
    assertEquals(r.denied?.status, 401);
    assertEquals(r.fetchCalls, 0);
  }
});

Deno.test("wrong bearer, anon-key-shaped bearer, non-Bearer scheme, near-miss key -> 401", async () => {
  const headers = [
    "Bearer wrong",
    "Bearer eyJhbGciOiJIUzI1NiJ9.anon.sig",
    `Basic ${KEY}`,
    `Bearer ${KEY}x`,
    `Bearer ${KEY.slice(0, -1)}`,
    "Bearer ",
    KEY, // no scheme
  ];
  for (const h of headers) {
    const r = await runGate(new Request(BASE, { method: "POST", body: TRIGGER_BODY, headers: { Authorization: h } }));
    assertEquals(r.denied?.status, 401, `should reject Authorization: ${h}`);
  }
});

Deno.test("fail-closed: unset/empty service key authorizes nobody, even an empty bearer", async () => {
  for (const key of [undefined, ""]) {
    const r = await runGate(new Request(BASE, { method: "POST", headers: { Authorization: "Bearer " } }), key);
    assertEquals(r.denied?.status, 401);
    const r2 = await runGate(new Request(BASE, { method: "POST", headers: { Authorization: "Bearer undefined" } }), key);
    assertEquals(r2.denied?.status, 401);
  }
});

Deno.test("service-role bearer (cron job 5 / docusign-webhook shape) passes the gate for TRIGGER and CRON", async () => {
  const auth = { Authorization: `Bearer ${KEY}` };
  const trig = await runGate(new Request(BASE, { method: "POST", body: TRIGGER_BODY, headers: auth }));
  assertEquals(trig.denied, null);
  const cron = await runGate(new Request(BASE, { method: "POST", body: "{}", headers: auth }));
  assertEquals(cron.denied, null);
  const lower = await runGate(new Request(BASE, { method: "POST", headers: { authorization: `bearer ${KEY}` } }));
  assertEquals(lower.denied, null);
});

Deno.test("401 body leaks nothing and carries CORS + JSON headers", async () => {
  const r = await runGate(new Request(BASE, { method: "POST", body: TRIGGER_BODY }));
  assertEquals(await r.denied!.json(), { error: "Unauthorized" });
  assertEquals(r.denied!.headers.get("Content-Type"), "application/json");
  assertEquals(r.denied!.headers.get("Access-Control-Allow-Origin"), "https://otterquote.com");
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
  const serveAt = idx("serve(async (req)");
  const gateAt = idx("gateResponse(route, req, supabaseKey");
  const clientAt = idx("const supabase    = createClient(");
  const firstFrom = lines.findIndex((l, i) => i > serveAt && !l.trim().startsWith("//") && l.includes(".from("));
  assert(serveAt > 0 && gateAt > serveAt, "gateResponse must be called inside serve()");
  assert(clientAt > gateAt, "service-role client must be created after the gate");
  assert(firstFrom > gateAt, "no DB read inside serve() before the gate");
  assert(src.includes("validateHomeownerChoice(url)"), "homeowner tokens must be validated");
});
