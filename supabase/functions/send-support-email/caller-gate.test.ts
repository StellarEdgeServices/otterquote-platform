// gh-2462 Q2 -- tests for send-support-email's key gate, field whitelist and rate limit.
// Drives the REAL exported handler with injected env, a fake supabase client and a counting
// fetch stub (Mailgun). Fixtures are not real keys.
//
// NEGATIVE CONTROL: with hasAcceptedKey() forced to true in index.ts, the "refused" tests
// (401 + zero fetch + no client) FAIL. Raw output is in the builder report.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handler } from "./index.ts";
import { LIMITS } from "./caller-gate.ts";

const ANON = "fixture-anon-header.fixture-anon-payload.fixture-anon-signature";
const PUBLISHABLE = "sb_publishable_fixture";
const SERVICE = "fixture-runtime-service-key-0123456789";
const SECRET_DEFAULT = "fixture-rotated-default-key-9876543210";
const USER_JWT = "fixture-user-header.fixture-user-payload.fixture-user-signature";
const URL_ = "https://x.supabase.co/functions/v1/send-support-email";

type Env = Record<string, string | undefined>;
const ENV: Env = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  SUPABASE_ANON_KEY: ANON,
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_DEFAULT }),
  MAILGUN_API_KEY: "fixture-mailgun",
  MAILGUN_DOMAIN: "mail.example.test",
};

const GOOD = { from_name: "Pat Roofer", from_email: "pat@example.com", subject: "Help", message: "Hello" };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface Run {
  res: Response;
  fetchCalls: string[];
  clientCalls: string[];
}

async function run(
  req: Request,
  env: Env = ENV,
  rpc: { data: unknown; error: unknown } = { data: { allowed: true }, error: null },
): Promise<Run> {
  const clientCalls: string[] = [];
  const makeClient = ((_u: string, _k: string) => {
    clientCalls.push("createClient");
    return {
      rpc: (n: string) => {
        clientCalls.push(`rpc:${n}`);
        return Promise.resolve(rpc);
      },
      from: (t: string) => ({
        insert: (_row: unknown) => {
          clientCalls.push(`insert:${t}`);
          return Promise.resolve({ error: null });
        },
      }),
    };
  // deno-lint-ignore no-explicit-any
  }) as any;
  const realFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    fetchCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(new Response(JSON.stringify({ id: "mg-1" }), { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await handler(req, (n) => env[n], makeClient);
    return { res, fetchCalls, clientCalls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("no key, wrong key, near-miss keys, non-Bearer, empty bearer -> 401, zero fetch, no client", async () => {
  const cases: Record<string, string>[] = [
    {},
    { apikey: "wrong" },
    { Authorization: "Bearer wrong" },
    { apikey: `${ANON}x` },
    { apikey: ANON.slice(0, -1) },
    { Authorization: `Bearer ${PUBLISHABLE}x` },
    { Authorization: `Bearer ${SERVICE}x` },
    { Authorization: `Basic ${ANON}` },
    { Authorization: "Bearer " },
    { Authorization: ANON }, // key without scheme
    { Authorization: `Bearer ${USER_JWT}` }, // a user JWT alone is not a project key
  ];
  for (const h of cases) {
    const r = await run(post(GOOD, h));
    assertEquals(r.res.status, 401, JSON.stringify(h));
    assertEquals(r.fetchCalls.length, 0);
    assertEquals(r.clientCalls.length, 0);
  }
});

Deno.test("empty env fails closed, even for an empty presented key", async () => {
  const empty: Env = { ...ENV, SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_PUBLISHABLE_KEYS: "", SUPABASE_SECRET_KEYS: "" };
  for (const h of [{ apikey: ANON }, { Authorization: "Bearer " }, { apikey: "" }, {}] as Record<string, string>[]) {
    const r = await run(post(GOOD, h), empty);
    assertEquals(r.res.status, 401);
    assertEquals(r.fetchCalls.length, 0);
    assertEquals(r.clientCalls.length, 0);
  }
});

Deno.test("anon key and publishable key (apikey or Bearer) -> 200, exactly one Mailgun call", async () => {
  const headers: Record<string, string>[] = [
    { apikey: ANON, Authorization: `Bearer ${ANON}` }, // public form
    { apikey: PUBLISHABLE },
    { Authorization: `Bearer ${PUBLISHABLE}` },
    { apikey: ANON, Authorization: `Bearer ${USER_JWT}` }, // supabase-js invoke, signed-in user
  ];
  for (const h of headers) {
    const r = await run(post(GOOD, h));
    assertEquals(r.res.status, 200, JSON.stringify(h));
    assertEquals(r.fetchCalls.length, 1);
    assert(r.fetchCalls[0].startsWith("https://api.mailgun.net/"));
    assert(r.clientCalls.includes("insert:support_tickets"));
  }
});

Deno.test("service key bearer (platform-health-check) is accepted", async () => {
  const r = await run(post(GOOD, { Authorization: `Bearer ${SERVICE}` }));
  assertEquals(r.res.status, 200);
  const r2 = await run(post(GOOD, { Authorization: `Bearer ${SECRET_DEFAULT}` }));
  assertEquals(r2.res.status, 200);
});

Deno.test("health check answered for platform-health-check's headers, no I/O; refused without a key", async () => {
  const ok = await run(post({ health_check: true }, { Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" }));
  assertEquals(ok.res.status, 200);
  assertEquals(await ok.res.json(), { status: "ok" });
  assertEquals(ok.fetchCalls.length, 0);
  assertEquals(ok.clientCalls.length, 0);

  const bad = await run(post({ health_check: true }));
  assertEquals(bad.res.status, 401);
});

Deno.test("OPTIONS is ungated", async () => {
  const r = await run(new Request(URL_, { method: "OPTIONS", headers: { Origin: "https://otterquote.com" } }));
  assertEquals(r.res.status, 200);
  assertEquals(r.fetchCalls.length, 0);
  assertEquals(r.clientCalls.length, 0);
});

Deno.test("unknown field, wrong type, oversize, bad email, missing field, bad JSON -> 400 with no Mailgun and no client", async () => {
  const h = { apikey: ANON };
  const bodies: unknown[] = [
    { ...GOOD, to_email: "victim@example.com" },
    { ...GOOD, html: "<b>x</b>" },
    { ...GOOD, message: 123 },
    { ...GOOD, subject: ["a"] },
    { ...GOOD, from_name: "n".repeat(LIMITS.from_name + 1) },
    { ...GOOD, from_email: `${"a".repeat(LIMITS.from_email)}@example.com` },
    { ...GOOD, subject: "s".repeat(LIMITS.subject + 1) },
    { ...GOOD, message: "m".repeat(LIMITS.message + 1) },
    { ...GOOD, user_id: "u".repeat(LIMITS.user_id + 1) },
    { ...GOOD, from_email: "not-an-email" },
    { from_name: "x", from_email: "a@b.co" },
    [GOOD],
    "{not json",
  ];
  for (const b of bodies) {
    const r = await run(post(b, h));
    assertEquals(r.res.status, 400, JSON.stringify(b).slice(0, 80));
    assertEquals(r.fetchCalls.length, 0);
    assertEquals(r.clientCalls.length, 0);
  }
});

Deno.test("fields at the limits are accepted (optional subject and user_id may be omitted)", async () => {
  const body = {
    from_name: "n".repeat(LIMITS.from_name),
    from_email: "a@example.com",
    subject: "s".repeat(LIMITS.subject),
    message: "m".repeat(LIMITS.message),
    user_id: "7d6c5b4a-3f2e-4d1c-8b0a-9e8f7d6c5b4a",
  };
  assertEquals((await run(post(body, { apikey: ANON }))).res.status, 200);
  assertEquals((await run(post({ from_name: "A", from_email: "a@example.com", message: "m" }, { apikey: ANON }))).res.status, 200);
});

Deno.test("rate limit denied -> 429, no Mailgun call, no ticket insert", async () => {
  const r = await run(post(GOOD, { apikey: ANON }), ENV, { data: { allowed: false, reason: "hourly" }, error: null });
  assertEquals(r.res.status, 429);
  assertEquals(r.fetchCalls.length, 0);
  assert(r.clientCalls.includes("rpc:check_rate_limit"));
  assert(!r.clientCalls.includes("insert:support_tickets"));
});

Deno.test("rate limit: no row/empty result is denied (deny-by-default); RPC error fails open like check-email-exists", async () => {
  const none = await run(post(GOOD, { apikey: ANON }), ENV, { data: null, error: null });
  assertEquals(none.res.status, 429);
  assertEquals(none.fetchCalls.length, 0);

  const err = await run(post(GOOD, { apikey: ANON }), ENV, { data: null, error: { message: "boom" } });
  assertEquals(err.res.status, 200);
  assertEquals(err.fetchCalls.length, 1);
});

Deno.test("wiring order: gate -> body validation -> rate limit -> Mailgun -> ticket insert", async () => {
  const r = await run(post(GOOD, { apikey: ANON }));
  assertEquals(r.res.status, 200);
  assertEquals(r.clientCalls, ["createClient", "rpc:check_rate_limit", "insert:support_tickets"]);

  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const at = (s: string) => src.indexOf(s);
  const order = ["hasAcceptedKey(", "validatePayload(", '"check_rate_limit"', "api.mailgun.net", '.from("support_tickets")'].map(at);
  assert(order.every((i) => i > 0), `missing marker: ${order}`);
  assertEquals([...order].sort((a, b) => a - b), order);
  assert(src.includes("if (import.meta.main)"));
});
