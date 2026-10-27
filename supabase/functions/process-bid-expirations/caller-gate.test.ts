// gh-3104 -- caller gate for process-bid-expirations (hourly bid-expiry sweep + emails), the gh-2309 / gh-2462 pattern.
//
// Drives the REAL exported handler with injected env, a fake supabase client and a
// counting fetch stub (Mailgun is a fetch). NEGATIVE CONTROL: with the
// `serviceGate(...)` call in index.ts removed, every "refused" test below FAILS (the
// handler builds the client and reaches the DB / mail path). Output is in the PR body.
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

const URL_ = "https://x.supabase.co/functions/v1/process-bid-expirations";
// The bodies the real callers send, plus the scoped manual-run shapes.
const BODIES: unknown[] = [{}, { claim_id: "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13" }];

async function run(r: Request, env: Env = BASE_ENV, rows = {}) {
  const sb = fakeSupabase(rows);
  const { result, fetchCalls } = await withFetchStub(() => handler(r, (n) => env[n], sb.make));
  return { res: result, fetchCalls, clientCalls: sb.calls };
}

Deno.test("refused callers (incl. anon key) -> 401 with zero I/O (no client, no DB read, no mail)", async () => {
  for (const body of BODIES) {
    for (const [label, auth] of BAD_BEARERS) {
      const r = await run(req(URL_, body, auth));
      assertEquals(r.res.status, 401, `${label} ${JSON.stringify(body)}`);
      assertEquals(r.fetchCalls.length, 0, `no fetch for ${label}`);
      assertEquals(r.clientCalls.length, 0, `no client for ${label}`);
      assertEquals(await r.res.json(), { error: "Unauthorized" });
    }
  }
});

Deno.test("fail-closed: empty/unset keys authorize nobody, even an empty bearer", async () => {
  const envs: Env[] = [
    { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: "" },
    { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEYS: undefined },
    { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: JSON.stringify({ default: "" }) },
  ];
  for (const env of envs) {
    for (const h of ["Bearer ", "Bearer", "Bearer undefined", "Bearer null", null]) {
      const r = await run(req(URL_, BODIES[0], h), env);
      assertEquals(r.res.status, 401, `${JSON.stringify(h)}`);
      assertEquals(r.clientCalls.length, 0);
    }
  }
});

Deno.test("service callers proceed: runtime service key and the vault/secret default key", async () => {
  for (const key of [SERVICE_KEY, SECRET_DEFAULT]) {
    for (const body of BODIES) {
      const r = await run(req(URL_, body, `Bearer ${key}`));
      assertEquals(r.res.status, 200, `${JSON.stringify(body)}`);
      assert(r.clientCalls.includes("createClient"), "past the gate the handler builds the client");
      assert(r.clientCalls.includes("from:quotes"), "past the gate the handler reaches from:quotes");
    }
  }
  // lower-case scheme, as pg_net / other clients may send
  assertEquals((await run(req(URL_, BODIES[0], `bearer ${SERVICE_KEY}`))).res.status, 200);
  // legacy-only env (SUPABASE_SECRET_KEYS unset) still accepts the runtime key, not the other one
  const legacy = { ...BASE_ENV, SUPABASE_SECRET_KEYS: undefined };
  assertEquals((await run(req(URL_, BODIES[0], `Bearer ${SERVICE_KEY}`), legacy)).res.status, 200);
  assertEquals((await run(req(URL_, BODIES[0], `Bearer ${SECRET_DEFAULT}`), legacy)).res.status, 401);
});

Deno.test("OPTIONS preflight stays ungated and does no I/O", async () => {
  const o = await run(new Request(URL_, { method: "OPTIONS" }));
  assert(o.res.status === 200 || o.res.status === 204);
  assertEquals(o.clientCalls.length, 0);
  assertEquals(o.fetchCalls.length, 0);
});

// Structural pin: the gate runs before the client is built and before any `.from(` / `.rpc(` in the handler.
Deno.test("index.ts wiring: serviceGate precedes makeClient(...) and every .from(/.rpc( in handler", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const live = (l: string) => !l.trim().startsWith("//");
  const at = (needle: string) => lines.findIndex((l) => live(l) && l.includes(needle));
  const handlerAt = at("export async function handler(");
  const gateAt = at("serviceGate(req, getEnv, corsHeaders)");
  const clientAt = at("makeClient(supabaseUrl,");
  const firstIo = lines.findIndex((l, i) => i > handlerAt && live(l) && (l.includes(".from(") || l.includes(".rpc(")));
  assert(handlerAt > 0 && gateAt > handlerAt, "gate inside handler");
  assert(clientAt > gateAt && firstIo > gateAt, "gate before client and DB");
  assert(src.includes("if (import.meta.main)"), "serve() guarded by import.meta.main");
});

// One source of truth: this copy of caller-gate.ts must stay byte-identical to process-hover-rebate's.
Deno.test("caller-gate.ts is byte-identical to process-hover-rebate/caller-gate.ts", async () => {
  const mine = await Deno.readTextFile(new URL("./caller-gate.ts", import.meta.url));
  const ref = await Deno.readTextFile(new URL("../process-hover-rebate/caller-gate.ts", import.meta.url));
  assertEquals(mine, ref);
});
