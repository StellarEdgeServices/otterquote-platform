// gh-1916 (PR #2722 LEGAL-READ F5): send-sms accepts service-role callers only.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-sms/service-only.test.ts
// No network, no Twilio, no SMS: Supabase auth and Twilio are fakes.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { authorizeServiceOnly, constantTimeEqual } from "./sender-selection.ts";

const SERVICE_KEY = "svc-role-key-for-tests";
const ANON_KEY = "anon-key-for-tests";
const USER_JWT = "user-jwt-for-tests";

// Fake auth.getUser: only USER_JWT is a logged-in user; the anon key and junk are not.
const getUser = async (token: string) => (token === USER_JWT ? { user: { id: "u1" } } : null);

/** Mirror of the handler's order: gate first, Twilio only after the gate says ok. */
async function handle(authHeader: string, twilio: () => Promise<void>): Promise<number> {
  const d = await authorizeServiceOnly(authHeader, SERVICE_KEY, getUser);
  if (!d.ok) return d.status;
  await twilio();
  return 200;
}

Deno.test("anon key -> 401 and Twilio is never called", async () => {
  let calls = 0;
  assertEquals(await handle(`Bearer ${ANON_KEY}`, async () => { calls++; }), 401);
  assertEquals(calls, 0);
});
Deno.test("no Authorization header -> 401 and Twilio is never called", async () => {
  let calls = 0;
  assertEquals(await handle("", async () => { calls++; }), 401);
  assertEquals(calls, 0);
});
Deno.test("authenticated end user -> 403 and Twilio is never called", async () => {
  let calls = 0;
  assertEquals(await handle(`Bearer ${USER_JWT}`, async () => { calls++; }), 403);
  assertEquals(calls, 0);
});
Deno.test("service role -> passes through to the (mocked) Twilio call", async () => {
  let calls = 0;
  assertEquals(await handle(`Bearer ${SERVICE_KEY}`, async () => { calls++; }), 200);
  assertEquals(calls, 1);
});
Deno.test("an empty configured service key authorizes nobody (fail closed)", async () => {
  const d = await authorizeServiceOnly("Bearer ", "", getUser);
  assertEquals(d.ok, false);
  const d2 = await authorizeServiceOnly("Bearer x", "", getUser);
  assertEquals(d2.ok, false);
});
Deno.test("a near-miss of the service key is not accepted", async () => {
  const d = await authorizeServiceOnly(`Bearer ${SERVICE_KEY}x`, SERVICE_KEY, getUser);
  assertEquals(d.ok, false);
  assert(constantTimeEqual("a", "a") && !constantTimeEqual("a", "b") && !constantTimeEqual("a", "ab"));
});

// Source pin: index.ts must call the gate before it reads the body or touches Twilio, and must not
// fall back to the old any-user gate.
async function indexCode(): Promise<string> {
  const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}
Deno.test("index.ts calls authorizeServiceOnly before req.json() and the Twilio POST", async () => {
  const src = await indexCode();
  const gate = src.indexOf("authorizeServiceOnly(");
  assert(gate > 0, "authorizeServiceOnly not called");
  assert(gate < src.indexOf("req.json()"), "gate must precede req.json()");
  assert(gate < src.indexOf("Messages.json"), "gate must precede the Twilio POST");
  assert(!src.includes("resolveAuthorization("), "old any-user gate is back");
});
