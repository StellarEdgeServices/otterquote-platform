// D-391 layer 2 (#2875): twilio-sms-optout. Run: deno test supabase/functions/twilio-sms-optout/handler.test.ts
// No network, no Twilio, no database, no SMS: every dependency is a counting fake.
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { type Deps, handle, timingSafeEqual, twilioSignature } from "./handler.ts";

const TOKEN = "fixture-auth-token";
const URL_ = "https://x.test/functions/v1/twilio-sms-optout";
const PHONE = "+15155550142";

function make(over: Partial<Deps> = {}, env: Record<string, string | undefined> = {}) {
  const log: string[] = [];
  const e: Record<string, string | undefined> = { TWILIO_AUTH_TOKEN: TOKEN, TWILIO_INBOUND_WEBHOOK_URL: URL_, ...env };
  const deps: Deps = {
    env: (n) => e[n],
    now: () => new Date("2026-10-21T12:00:00.000Z"),
    suppress: (p, k) => { log.push(`suppress ${p} ${k}`); return Promise.resolve(true); },
    markOptedOut: (p, k) => { log.push(`optedout ${p} ${k}`); return Promise.resolve(true); },
    release: (p) => { log.push(`release ${p}`); return Promise.resolve(true); },
    ...over,
  };
  return { deps, log };
}
async function inbound(params: Record<string, string>, opts: { sign?: boolean; sig?: string } = {}): Promise<Request> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (opts.sig !== undefined) headers["X-Twilio-Signature"] = opts.sig;
  else if (opts.sign !== false) headers["X-Twilio-Signature"] = await twilioSignature(TOKEN, URL_, params);
  return new Request(URL_, { method: "POST", headers, body: new URLSearchParams(params).toString() });
}

Deno.test("signature equals an independent HMAC-SHA1 computation (Python hmac cross-check of url + sorted key+value)", async () => {
  const sig = await twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", {
    CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212",
  });
  assertEquals(sig, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  assertEquals(timingSafeEqual("a", "a"), true);
  assertEquals(timingSafeEqual("a", "ab"), false);
});

Deno.test("unsigned, mis-signed, or unconfigured -> 403 and NOTHING is written", async () => {
  const p = { From: PHONE, Body: "STOP", OptOutType: "STOP" };
  const cases: [string, Request, Record<string, string | undefined>][] = [
    ["no signature", await inbound(p, { sign: false }), {}],
    ["wrong signature", await inbound(p, { sig: "AAAA" }), {}],
    ["tampered body", new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": await twilioSignature(TOKEN, URL_, p) },
      body: new URLSearchParams({ ...p, From: "+15155559999" }).toString(),
    }), {}],
    ["no auth token", await inbound(p), { TWILIO_AUTH_TOKEN: undefined }],
    ["no webhook url", await inbound(p), { TWILIO_INBOUND_WEBHOOK_URL: undefined }],
  ];
  for (const [label, req, env] of cases) {
    const { deps, log } = make({}, env);
    assertEquals((await handle(req, deps)).status, 403, label);
    assertEquals(log, [], label);
  }
  assertEquals((await handle(new Request(URL_, { method: "GET" }), make().deps)).status, 405);
});

Deno.test("STOP: suppression row first, then opted_out; replies with empty TwiML (we send nothing)", async () => {
  const { deps, log } = make();
  const r = await handle(await inbound({ From: PHONE, Body: " stop ", OptOutType: "STOP" }), deps);
  assertEquals(r.status, 200);
  assertEquals(await r.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assertEquals(log, [`suppress ${PHONE} STOP`, `optedout ${PHONE} STOP`]);
});

Deno.test("STOP: a failed suppression write -> 500 and the status flip is not attempted (Twilio retries)", async () => {
  const { deps, log } = make({ suppress: () => Promise.resolve(false) });
  assertEquals((await handle(await inbound({ From: PHONE, Body: "STOP", OptOutType: "STOP" }), deps)).status, 500);
  assertEquals(log, []);
  const m = make({ markOptedOut: () => Promise.resolve(false) });
  assertEquals((await handle(await inbound({ From: PHONE, Body: "STOP", OptOutType: "STOP" }), m.deps)).status, 500);
});

Deno.test("START releases only on the literal word START; UNSTOP / YES do not", async () => {
  let m = make();
  assertEquals((await handle(await inbound({ From: PHONE, Body: "start", OptOutType: "START" }), m.deps)).status, 200);
  assertEquals(m.log, [`release ${PHONE}`]);
  for (const body of ["UNSTOP", "YES"]) {
    m = make();
    assertEquals((await handle(await inbound({ From: PHONE, Body: body, OptOutType: "START" }), m.deps)).status, 200);
    assertEquals(m.log, [], body);
  }
});

Deno.test("HELP, ordinary replies, and a missing/odd From change nothing", async () => {
  const cases: Record<string, string>[] = [{ From: PHONE, Body: "HELP", OptOutType: "HELP" }, { From: PHONE, Body: "thanks" }, { From: "not-a-number", Body: "STOP", OptOutType: "STOP" }, { Body: "STOP", OptOutType: "STOP" }];
  for (const p of cases) {
    const { deps, log } = make();
    assertEquals((await handle(await inbound(p), deps)).status, 200);
    assertEquals(log, [], JSON.stringify(p));
  }
});
