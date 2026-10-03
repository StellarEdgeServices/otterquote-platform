// gh-2462 -- caller gate for check-siding-design-completion (the D-164 bid-release scan),
// #2309 pattern. Drives the REAL exported handler with injected env, a fake supabase client
// and a counting fetch stub (Hover, get-hover-siding-data and notify-contractors are all
// fetches). NEGATIVE CONTROL: with the `serviceGate(...)` call in index.ts removed, the
// "refused" tests FAIL (the handler builds the client and queries claims).
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

const URL_ = "https://x.supabase.co/functions/v1/check-siding-design-completion";
const CLAIM = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
// cron job 6 sends {}; hover-webhook sends {claim_id}.
const BODIES = [{}, { claim_id: CLAIM }];

async function run(r: Request, env: Env = BASE_ENV) {
  const sb = fakeSupabase({});
  const { result, fetchCalls } = await withFetchStub(() => handler(r, (n) => env[n], sb.make));
  return { res: result, fetchCalls, clientCalls: sb.calls };
}

Deno.test("refused callers -> 401 with zero I/O (no client, no claims read, no Hover/notify fetch)", async () => {
  for (const body of BODIES) {
    for (const [label, auth] of BAD_BEARERS) {
      const r = await run(req(URL_, body, auth));
      assertEquals(r.res.status, 401, `${label} ${JSON.stringify(body)}`);
      assertEquals(r.fetchCalls.length, 0, `no fetch for ${label}`);
      assertEquals(r.clientCalls.length, 0, `no client for ${label}`);
    }
  }
  // GET (no body) is refused too
  const g = await run(new Request(URL_, { method: "GET" }));
  assertEquals(g.res.status, 401);
  assertEquals(g.clientCalls.length, 0);
});

Deno.test("fail-closed: empty/unset keys authorize nobody", async () => {
  const env = { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: "" };
  for (const h of ["Bearer ", "Bearer", "Bearer undefined", null]) {
    const r = await run(req(URL_, {}, h), env);
    assertEquals(r.res.status, 401);
    assertEquals(r.clientCalls.length, 0);
  }
});

Deno.test("legitimate callers pass the gate: cron (vault/secret default key) and hover-webhook (runtime key)", async () => {
  for (const key of [SECRET_DEFAULT, SERVICE_KEY]) {
    for (const body of BODIES) {
      const r = await run(req(URL_, body, `Bearer ${key}`));
      assertEquals(r.res.status, 200, `${JSON.stringify(body)}`);
      assertEquals(await r.res.json(), { ok: true, checked: 0, released: 0 });
      assert(r.clientCalls.includes("from:claims"), "past the gate the handler queries claims");
      assert(r.clientCalls.includes("rpc:record_cron_health"), "and records cron health");
    }
  }
});

Deno.test("OPTIONS stays ungated", async () => {
  const o = await run(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(o.res.status, 200);
  assertEquals(o.clientCalls.length, 0);
});

Deno.test("index.ts wiring: serviceGate precedes makeClient(...) and every .from( in handler", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const live = (l: string) => !l.trim().startsWith("//");
  const at = (needle: string) => lines.findIndex((l) => live(l) && l.includes(needle));
  const handlerAt = at("export async function handler(");
  const gateAt = at("serviceGate(req, getEnv, buildCorsHeaders(req))");
  const clientAt = at("makeClient(supabaseUrl, serviceKey)");
  const firstFrom = lines.findIndex((l, i) => i > handlerAt && live(l) && l.includes(".from("));
  assert(handlerAt > 0 && gateAt > handlerAt, "gate inside handler");
  assert(clientAt > gateAt && firstFrom > gateAt, "gate before client and DB");
  assert(src.includes("if (import.meta.main)"), "serve() guarded by import.meta.main");
});
