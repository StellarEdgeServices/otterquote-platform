// gh-2462 -- caller gate for notify-feature-request (emails the admin inbox), #2309 pattern.
// Drives the REAL exported handler with injected env and a counting fetch stub (Mailgun is
// a fetch). NEGATIVE CONTROL: with the `serviceGate(...)` call in index.ts removed, the
// "refused" test FAILS (an anonymous body sends the Mailgun email and returns 200).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BAD_BEARERS,
  BASE_ENV,
  type Env,
  req,
  SECRET_DEFAULT,
  SERVICE_KEY,
  withFetchStub,
} from "../_shared/caller-gate-test-kit.ts";
import { handler } from "./index.ts";

const URL_ = "https://x.supabase.co/functions/v1/notify-feature-request";
// Exactly what notify_feature_request_webhook() posts.
const TRIGGER_BODY = {
  type: "INSERT",
  table: "feature_requests",
  record: { contractor_name: "Fixture Co", contractor_email: "c@example.test", request_text: "x", created_at: "2026-10-03T00:00:00Z" },
};

async function run(r: Request, env: Env = BASE_ENV) {
  const { result, fetchCalls } = await withFetchStub(() => handler(r, (n) => env[n]));
  return { res: result, fetchCalls };
}

Deno.test("refused callers -> 401, Mailgun never called", async () => {
  for (const body of [TRIGGER_BODY, {}, { anything: "goes" }]) {
    for (const [label, auth] of BAD_BEARERS) {
      const r = await run(req(URL_, body, auth));
      assertEquals(r.res.status, 401, `${label} ${JSON.stringify(body)}`);
      assertEquals(r.fetchCalls.length, 0, `no Mailgun call for ${label}`);
    }
  }
});

Deno.test("fail-closed: empty/unset keys authorize nobody", async () => {
  const env = { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEYS: "" };
  for (const h of ["Bearer ", "Bearer", "Bearer undefined", null]) {
    const r = await run(req(URL_, TRIGGER_BODY, h), env);
    assertEquals(r.res.status, 401);
    assertEquals(r.fetchCalls.length, 0);
  }
});

Deno.test("legitimate caller (DB trigger, vault key = secret default) passes and sends the email", async () => {
  for (const key of [SECRET_DEFAULT, SERVICE_KEY]) {
    const r = await run(req(URL_, TRIGGER_BODY, `Bearer ${key}`));
    assertEquals(r.res.status, 200);
    assertEquals(r.fetchCalls.length, 1);
    assert(r.fetchCalls[0].startsWith("https://api.mailgun.net/v3/"), r.fetchCalls[0]);
  }
});

Deno.test("OPTIONS stays ungated", async () => {
  const o = await run(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(o.res.status, 200);
  assertEquals(o.fetchCalls.length, 0);
});

Deno.test("index.ts wiring: serviceGate precedes the Mailgun env read and the body parse", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const live = (l: string) => !l.trim().startsWith("//");
  const at = (needle: string) => lines.findIndex((l) => live(l) && l.includes(needle));
  const handlerAt = at("export async function handler(");
  const gateAt = at("serviceGate(req, getEnv, corsHeaders)");
  assert(handlerAt > 0 && gateAt > handlerAt, "gate inside handler");
  assert(at('getEnv("MAILGUN_API_KEY")') > gateAt, "gate before Mailgun");
  assert(at("await req.json()") > gateAt, "gate before body parse");
  assert(src.includes("if (import.meta.main)"), "serve() guarded by import.meta.main");
});
