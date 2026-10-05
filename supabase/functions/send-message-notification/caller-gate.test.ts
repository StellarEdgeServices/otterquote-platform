// gh-2462 (Q3) -- caller gate for send-message-notification: service bearer, or the
// message sender's own user JWT. Never returns recipient_email.
//
// Drives the REAL exported handler with injected env, a fake supabase client (its
// auth.getUser accepts only USER_JWT, resolving to USER_ID) and a counting fetch stub
// (Mailgun is a fetch). NEGATIVE CONTROL: with the gate block removed from index.ts
// (the `isService`/`looksLikeJwt` 401, the `auth.getUser` check and the sender 403), the
// "refused" tests FAIL. Output is in the commit report.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
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

const URL_ = "https://x.supabase.co/functions/v1/send-message-notification";
const MESSAGE_ID = "3f2b8c1e-9a4d-4e57-8b1c-2d6f7a9e0b13";
const RECIPIENT_EMAIL = "recipient-fixture@example.test";
const BODY = { message_id: MESSAGE_ID };

// Contractor-sent message (so the homeowner is the recipient): one profiles lookup.
function rowsFor(senderId: string): Rows {
  return {
    messages: [{
      id: MESSAGE_ID,
      claim_id: "c1",
      sender_id: senderId,
      sender_role: "contractor",
      body: "hello there",
      created_at: "2026-10-01T00:00:00Z",
      claims: { id: "c1", user_id: "homeowner-1", selected_trades: [] },
      profiles: { id: senderId, full_name: "Sender Name", email: "sender-fixture@example.test" },
    }],
    profiles: [{ email: RECIPIENT_EMAIL, full_name: "Recipient Name" }],
  };
}
const OWN: Rows = rowsFor(USER_ID);
const NOT_OWN: Rows = rowsFor(OTHER_USER_ID);

async function run(r: Request, rows: Rows = OWN, env: Env = BASE_ENV) {
  const sb = fakeSupabase(rows);
  const { result, fetchCalls } = await withFetchStub(() => handler(r, (n) => env[n], sb.make));
  const text = await result.text();
  return { res: result, text, fetchCalls, clientCalls: sb.calls };
}
const mailgun = (calls: string[]) => calls.filter((u) => u.includes("api.mailgun.net"));
// Client calls other than building it and verifying the token (any DB read / rpc).
const sideEffects = (calls: string[]) => calls.filter((c) => c !== "createClient" && c !== "auth.getUser");

Deno.test("refused credentials -> 401: no Mailgun fetch, no DB read, no rate-limit rpc", async () => {
  for (const [label, auth] of BAD_BEARERS) {
    const r = await run(req(URL_, BODY, auth));
    assertEquals(r.res.status, 401, label);
    assertEquals(r.fetchCalls.length, 0, `no fetch for ${label}`);
    assertEquals(sideEffects(r.clientCalls), [], `no side-effect client call for ${label}`);
    // only the legacy-anon JWT shape is ever shown to auth; nothing else builds the client
    if (label !== "anon key (legacy JWT shape)") assertEquals(r.clientCalls.length, 0, label);
  }
});

Deno.test("no credential: 401 before any DB read even with a bad/empty body", async () => {
  for (const body of [undefined, {}, { message_id: 5 }]) {
    const r = await run(req(URL_, body, null));
    assertEquals(r.res.status, 401);
    assertEquals(r.clientCalls.length, 0);
  }
});

Deno.test("anon key (legacy JWT shape) is rejected by auth.getUser -> 401, no table read", async () => {
  const r = await run(req(URL_, BODY, `Bearer ${BAD_BEARERS[1][1]!.slice(7)}`));
  assertEquals(r.res.status, 401);
  assertEquals(r.clientCalls, ["createClient", "auth.getUser"]);
  assertEquals(r.fetchCalls.length, 0);
});

Deno.test("signed-in user who is NOT the sender -> 403, no Mailgun, no rate-limit rpc", async () => {
  const r = await run(req(URL_, BODY, `Bearer ${USER_JWT}`), NOT_OWN);
  assertEquals(r.res.status, 403);
  assertEquals(mailgun(r.fetchCalls).length, 0);
  assertEquals(r.fetchCalls.length, 0);
  assertFalse(r.clientCalls.includes("rpc:check_rate_limit"));
  assertFalse(r.text.includes(RECIPIENT_EMAIL));
});

Deno.test("signed-in sender -> 200 and exactly one Mailgun call", async () => {
  const r = await run(req(URL_, BODY, `Bearer ${USER_JWT}`));
  assertEquals(r.res.status, 200);
  assertEquals(mailgun(r.fetchCalls).length, 1);
  assertEquals(r.fetchCalls.length, 1);
  assert(r.clientCalls.includes("auth.getUser"));
});

Deno.test("service bearers (both accepted keys) -> 200 for any sender, never hit auth", async () => {
  for (const key of [SERVICE_KEY, SECRET_DEFAULT]) {
    for (const rows of [OWN, NOT_OWN]) {
      const r = await run(req(URL_, BODY, `Bearer ${key}`), rows);
      assertEquals(r.res.status, 200);
      assertEquals(mailgun(r.fetchCalls).length, 1);
      assertFalse(r.clientCalls.includes("auth.getUser"));
    }
  }
});

Deno.test("response never contains recipient_email (keys and raw text), for user and service callers", async () => {
  for (const auth of [`Bearer ${USER_JWT}`, `Bearer ${SERVICE_KEY}`]) {
    const r = await run(req(URL_, BODY, auth));
    assertEquals(r.res.status, 200);
    const json = JSON.parse(r.text);
    assertEquals(Object.keys(json).sort(), ["notification_sent", "success"]);
    assertEquals(json.success, true);
    assertEquals(json.notification_sent, true);
    assertFalse("recipient_email" in json);
    assertFalse(r.text.includes(RECIPIENT_EMAIL), "recipient address must not appear in the body");
    assertFalse(r.text.includes("recipient_email"));
  }
});

Deno.test("OPTIONS stays ungated; other methods 405 before any client", async () => {
  const o = await run(new Request(URL_, { method: "OPTIONS" }));
  assertEquals(o.res.status, 204);
  assertEquals(o.clientCalls.length, 0);
  const g = await run(new Request(URL_, { method: "GET" }));
  assertEquals(g.res.status, 405);
  assertEquals(g.clientCalls.length, 0);
});

Deno.test("index.ts wiring: the gate precedes the client build, body parse, DB read and Mailgun", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = src.split("\n");
  const live = (l: string) => !l.trim().startsWith("//") && !l.trim().startsWith("*");
  const at = (needle: string) => lines.findIndex((l) => live(l) && l.includes(needle));
  const handlerAt = at("export async function handler(");
  const gateAt = at("hasServiceBearer(req, acceptedServiceKeys(getEnv))");
  const denyAt = at("return deny(401, buildCorsHeaders(req))");
  const senderAt = at("callerUserId !== message.sender_id");
  assert(handlerAt > 0 && gateAt > handlerAt && denyAt > gateAt, "gate inside handler");
  assert(at("makeClient(supabaseUrl, supabaseKey)") > denyAt, "client built only after the 401");
  assert(at("await req.json()") > denyAt, "body parsed only after the 401");
  assert(at('.from("messages")') > denyAt, "messages read only after the 401");
  assert(senderAt > at('.from("messages")'), "sender check after the message load");
  assert(at("check_rate_limit") > senderAt, "rate limit only after the sender check");
  assert(at("await sendMailgunEmail(") > senderAt, "Mailgun only after the sender check");
  assert(at("return deny(403, buildCorsHeaders(req))") > senderAt, "403 on mismatch");
  assertFalse(lines.some((l) => live(l) && l.includes("recipient_email")), "recipient_email not in any live line");
  assertFalse(lines.some((l) => live(l) && l.includes("Deno.env.get") && !l.includes("(n) => Deno.env.get(n)")), "env only via getEnv");
  assert(src.includes("if (import.meta.main)"), "serve() guarded by import.meta.main");
});

Deno.test("caller-gate.ts is byte-identical to notify-feature-request/caller-gate.ts when that copy is present", async () => {
  // The sibling copy lands with #2470 (its pin test lives in process-hover-rebate); skip until then.
  const here = await Deno.readTextFile(new URL("./caller-gate.ts", import.meta.url));
  let other: string;
  try {
    other = await Deno.readTextFile(new URL("../notify-feature-request/caller-gate.ts", import.meta.url));
  } catch (_e) {
    return;
  }
  assertEquals(here, other);
});

Deno.test("gh-2478: the message query does not select claims.selected_trades (no such column; nothing reads it)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const sel = src.slice(src.indexOf('.from("messages")'), src.indexOf(".eq(\"id\", messageId)"));
  assert(sel.includes("claims:claim_id"), "located the message select");
  assertFalse(sel.includes("selected_trades"), "select must not name selected_trades");
});

Deno.test("gh-2478: no select string embeds profiles via contractors (no FK -> PGRST200)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertFalse(src.includes("profiles:profiles"), "index.ts must not use a profiles:profiles embed");
  const selects = [...src.matchAll(/\.select\(\s*"([^"]*)"/g)].map((m) => m[1]);
  assert(selects.length > 0, "located select strings");
  for (const s of selects) {
    assertFalse(/contractors[^()]*\([^)]*profiles/.test(s), `select embeds profiles under contractors: ${s}`);
  }
});

Deno.test("gh-2478: homeowner sender with an awarded contractor -> notification_sent true, one Mailgun call", async () => {
  const rows: Rows = {
    messages: [{
      id: MESSAGE_ID,
      claim_id: "c1",
      sender_id: USER_ID,
      sender_role: "homeowner",
      body: "hello contractor",
      created_at: "2026-10-01T00:00:00Z",
      claims: { id: "c1", user_id: "homeowner-1" },
      profiles: { id: USER_ID, full_name: "Homeowner Name", email: "sender-fixture@example.test" },
    }],
    quotes: [{ contractor_id: "k1", contractors: { user_id: "contractor-user-1" } }],
    profiles: [{ email: RECIPIENT_EMAIL, full_name: "Contractor Name" }],
  };
  const r = await run(req(URL_, BODY, `Bearer ${USER_JWT}`), rows);
  assertEquals(r.res.status, 200);
  assertEquals(JSON.parse(r.text).notification_sent, true);
  assertEquals(mailgun(r.fetchCalls).length, 1);
  assertFalse(r.text.includes(RECIPIENT_EMAIL));
});
