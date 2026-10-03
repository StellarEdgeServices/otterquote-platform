// gh-2462 -- caller gate for check-rate-limits (reads rate_limit_config / rate_limits and emails
// the admin inbox), #2309 pattern, service-only per the CTO ruling on #2304 (5965391365).
// Drives the REAL exported handler with injected env, a fake supabase client and a counting
// fetch stub (Mailgun is a fetch). NEGATIVE CONTROL: with the `serviceGate(...)` call in
// index.ts removed, the "refused" test FAILS (an anonymous call builds the client, reads
// rate_limit_config and sends the Mailgun alert).
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

const URL_ = "https://x.supabase.co/functions/v1/check-rate-limits";
// One function over the 70% threshold, alert not yet sent this month -> one Mailgun call.
const ROWS = {
  rate_limit_config: [{ function_name: "fixture-fn", max_per_month: 1, enabled: true, alert_sent_month: null }],
  rate_limits: [{ id: 1 }],
};

async function run(r: Request, env: Env = BASE_ENV) {
  const sb = fakeSupabase(ROWS);
  const { result, fetchCalls } = await withFetchStub(() => handler(r, (n) => env[n], sb.make));
  return { res: result, fetchCalls, clientCalls: sb.calls };
}

Deno.test("refused callers -> 401 with zero I/O (no client, no DB read, no Mailgun)", async () => {
  for (const body of [{}, { anything: "goes" }]) {
    for (const [label, auth] of BAD_BEARERS) {
      const r = await run(req(URL_, body, auth));
      assertEquals(r.res.status, 401, `${label} ${JSON.stringify(body)}`);
      assertEquals(r.fetchCalls.length, 0, `no Mailgun call for ${label}`);
      assertEquals(r.clientCalls.length, 0, `no client for ${label}`);
      assertEquals(await r.res.json(), { error: "Unauthorized" });
    }
  }
});

Deno.test("fail-closed: empty/unset keys authorize nobody", async () => {
  const env = { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: "" };
  for (const h of ["Bearer ", "Bearer", "Bearer undefined", null]) {
    const r = await run(req(URL_, {}, h), env);
    assertEquals(r.res.status, 401);
    assertEquals(r.fetchCalls.length, 0);
    assertEquals(r.clientCalls.length, 0);
  }
});

Deno.test("service bearer (runtime key or secret default) passes, reads the config and sends the alert", async () => {
  for (const key of [SECRET_DEFAULT, SERVICE_KEY]) {
    const r = await run(req(URL_, {}, `Bearer ${key}`));
    assertEquals(r.res.status, 200);
    assert(r.clientCalls.includes("from:rate_limit_config"), "config read");
    assertEquals(r.fetchCalls.length, 1);
    assert(r.fetchCalls[0].startsWith("https://api.mailgun.net/v3/"), r.fetchCalls[0]);
    assertEquals((await r.res.json()).alerts_sent, 1);
  }
});

Deno.test("OPTIONS stays ungated", async () => {
  const o = await run(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(o.res.status, 200);
  assertEquals(o.fetchCalls.length, 0);
  assertEquals(o.clientCalls.length, 0);
});

Deno.test("index.ts wiring: serviceGate precedes the client, the Mailgun env read and any DB call", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const live = (l: string) => !l.trim().startsWith("//") && !l.trim().startsWith("*");
  const at = (needle: string) => lines.findIndex((l) => live(l) && l.includes(needle));
  const handlerAt = at("export async function handler(");
  const gateAt = at("serviceGate(req, getEnv, corsHeaders)");
  assert(handlerAt > 0 && gateAt > handlerAt, "gate inside handler");
  assert(at('getEnv("MAILGUN_API_KEY")') > gateAt, "gate before Mailgun");
  assert(at("makeClient(") > gateAt, "gate before client");
  assert(at('.from("rate_limit_config")') > gateAt, "gate before DB");
  assert(!/^const \w+ = Deno\.env\.get\(/m.test(src), "no module-level env reads");
  assert(src.includes("if (import.meta.main)"), "serve() guarded by import.meta.main");
});
