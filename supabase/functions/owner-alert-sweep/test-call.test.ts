// gh-3428 (Ben ruling 6668057340): owner-only test invocation of owner-alert-sweep. No network, no Twilio, no call: global fetch is a recorder.
// The real handler in index.ts is loaded with Deno.serve captured and Deno.env.get faked, so these tests exercise the deployed entry point.
// Run: deno test --allow-read=supabase/functions supabase/functions/owner-alert-sweep/

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildTwiml } from "./sweep.ts";

const SERVICE_KEY = "fixture-runtime-service-key-0123456789";
const ANON_JWT = "fixture-anon-header.fixture-anon-payload.fixture-anon-signature";
const USER_JWT = "fixture-user-header.fixture-user-payload.fixture-user-signature";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_PHONE_NUMBER: "TWILIO_NUMBER_PLACEHOLDER",
  OWNER_ALERT_PHONE: "OWNER_NUMBER_PLACEHOLDER",
};

type Handler = (req: Request) => Promise<Response>;
let handlerPromise: Promise<Handler> | null = null;
let env: Record<string, string> = ENV;

function loadHandler(): Promise<Handler> {
  handlerPromise ??= (async () => {
    let captured: Handler | null = null;
    const realServe = Deno.serve;
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = (h: Handler) => { captured = h; return { shutdown() {}, finished: Promise.resolve() }; };
    Deno.env.get = (k: string) => env[k];
    try { await import("./index.ts"); } finally { (Deno as any).serve = realServe; }
    assert(captured, "index.ts did not register a handler");
    return captured;
  })();
  return handlerPromise;
}

interface Rec { url: string; body: string }
async function call(authorization: string | null, body: string | null, setEnv: Record<string, string> = ENV, rpc: Record<string, unknown> = {}) {
  const handler = await loadHandler();
  env = setEnv;
  const fetches: Rec[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetches.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (url.startsWith("https://api.twilio.com/")) return new Response(JSON.stringify({ sid: "CA_FAKE" }), { status: 201 });
    const m = url.match(/\/rest\/v1\/rpc\/(\w+)/);
    if (m) return new Response(JSON.stringify(rpc[m[1]] ?? null), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authorization !== null) headers["authorization"] = authorization;
    const res = await handler(new Request("https://x.supabase.co/functions/v1/owner-alert-sweep", { method: "POST", headers, body: body ?? undefined }));
    return { status: res.status, json: await res.json() as Record<string, unknown>, fetches };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const TEST_BODY = JSON.stringify({ test_call: true });
const twilioCalls = (f: Rec[]) => f.filter((r) => r.url.startsWith("https://api.twilio.com/"));

Deno.test("test_call with the service-role key places exactly one call and touches no table", async () => {
  const r = await call(`Bearer ${SERVICE_KEY}`, TEST_BODY);
  assertEquals(r.status, 200);
  assertEquals(r.json.ok, true);
  assertEquals(r.json.test_call, true);
  assertEquals(r.fetches.length, 1, "exactly one outbound request");
  assertEquals(twilioCalls(r.fetches).length, 1, "and it is the Twilio call");
  assert(!r.fetches.some((f) => f.url.includes("supabase.co")), "no Supabase request: no rpc, no table read or write");
  const sent = new URLSearchParams(r.fetches[0].body);
  assertEquals(sent.get("To"), "OWNER_NUMBER_PLACEHOLDER");
  assertEquals(sent.get("From"), "TWILIO_NUMBER_PLACEHOLDER");
  const twiml = sent.get("Twiml") ?? "";
  assertStringIncludes(twiml.toLowerCase(), "this is a test");
  assert(!/claim|measurement/i.test(twiml), "the test message names no claim or customer event");
  assert(!JSON.stringify(r.json).includes("OWNER_NUMBER_PLACEHOLDER"), "no number in the response");
});

Deno.test("test call text says plainly that it is a test, once per repeat, and no real event text", () => {
  const t = buildTwiml({ event_kind: "test_call", state: null, claim_id: "" });
  assertStringIncludes(t.toLowerCase(), "this is a test");
  assert(!/New claim open|Measurement purchase|State unknown|Claim </.test(t));
});

Deno.test("test_call is refused and places no call for anon, user, no token, wrong and near-miss tokens", async () => {
  const bad: [string, string | null][] = [
    ["no token", null], ["empty bearer", "Bearer "], ["anon JWT", `Bearer ${ANON_JWT}`], ["user JWT", `Bearer ${USER_JWT}`],
    ["wrong", "Bearer wrong"], ["near-miss +x", `Bearer ${SERVICE_KEY}x`], ["near-miss -1", `Bearer ${SERVICE_KEY.slice(0, -1)}`],
  ];
  for (const [label, auth] of bad) {
    const r = await call(auth, TEST_BODY);
    assert(r.status === 401 || r.status === 403, `${label}: status ${r.status}`);
    assertEquals(r.fetches.length, 0, `${label}: no outbound request at all`);
  }
});

Deno.test("test_call with the right key but Twilio secrets missing returns 503 and places nothing", async () => {
  const { TWILIO_AUTH_TOKEN: _drop, ...partial } = ENV;
  const r = await call(`Bearer ${SERVICE_KEY}`, TEST_BODY, partial);
  assertEquals(r.status, 503);
  assertEquals(r.fetches.length, 0);
});

Deno.test("only a JSON boolean true is a test call: other bodies run the normal sweep", async () => {
  for (const body of [null, "{}", "not json", JSON.stringify({ test_call: "true" }), JSON.stringify({ test_call: 1 }), JSON.stringify({ test_call: false })]) {
    const r = await call(`Bearer ${SERVICE_KEY}`, body, ENV, { owner_alert_claim_batch: [] });
    assertEquals(r.status, 200, `body ${body}`);
    assertEquals(r.json.leased, 0);
    assertEquals(twilioCalls(r.fetches).length, 0, `body ${body}: no call`);
    assertEquals(r.fetches.length, 1);
    assertStringIncludes(r.fetches[0].url, "/rpc/owner_alert_claim_batch");
  }
});

Deno.test("a normal sweep is unchanged: claim rpc, one real-event call, mark rpc, original spoken text", async () => {
  const alert = { id: "a1", event_kind: "claim_bidding", claim_id: "00000000-0000-0000-0000-00000000c101", state: "OH", attempts: 1 };
  const r = await call(`Bearer ${SERVICE_KEY}`, JSON.stringify({}), ENV, { owner_alert_claim_batch: [alert], owner_alert_mark: "called" });
  assertEquals(r.status, 200);
  assertEquals(r.json.ok, true);
  assertEquals([r.json.leased, r.json.called, r.json.retry, r.json.failed_final], [1, 1, 0, 0]);
  assertEquals(r.fetches.length, 3);
  assertStringIncludes(r.fetches[0].url, "/rpc/owner_alert_claim_batch");
  assert(r.fetches[1].url.startsWith("https://api.twilio.com/"));
  assertStringIncludes(r.fetches[2].url, "/rpc/owner_alert_mark");
  assertEquals(new URLSearchParams(r.fetches[1].body).get("Twiml"), buildTwiml(alert));
  assertStringIncludes(buildTwiml(alert), "New claim open for bids");
});

Deno.test("a normal sweep with a bad token is still refused", async () => {
  for (const auth of [null, `Bearer ${ANON_JWT}`, `Bearer ${USER_JWT}`]) {
    const r = await call(auth, null);
    assert(r.status === 401 || r.status === 403);
    assertEquals(r.fetches.length, 0);
  }
});
