// D-391 layer 2 (#2875): twilio-sms-optout. Run: deno test supabase/functions/twilio-sms-optout/handler.test.ts
// No network, no Twilio, no database, no SMS: every dependency is a counting fake.
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { type Deps, findOptOutKeywords, handle, timingSafeEqual, twilioSignature } from "./handler.ts";

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
    recordStopOverStaff: () => Promise.resolve(true), // exercised by its own test below (kept out of `log` so the order assertions above are unchanged)
    hasOpenStop: () => Promise.resolve(true), // #3771: exercised by the stateful race tests below
    release: (p) => { log.push(`release ${p}`); return Promise.resolve(true); },
    flag: (p, b, k, sid) => { log.push(`flag ${p} ${JSON.stringify(b)} [${k.join(",")}] ${sid}`); return Promise.resolve(true); },
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

// REVIEW 6323770893 (BLOCKING): STOP must be honoured from the signed Body alone, with or without OptOutType.
// Keyword set: SMS terms in the CEO110 legal read s1b (STOP, END, CANCEL, QUIT, UNSUBSCRIBE, REVOKE, OPT OUT) plus the
// s3 note that Twilio also covers OPTOUT, and Twilio's standard STOPALL.
Deno.test("STOP body with NO OptOutType still opts the number out (fail-open fix)", async () => {
  const { deps, log } = make();
  assertEquals((await handle(await inbound({ From: PHONE, Body: "STOP" }), deps)).status, 200);
  assertEquals(log, [`suppress ${PHONE} STOP`, `optedout ${PHONE} STOP`]);
});

Deno.test("keyword match ignores case and whitespace, with or without OptOutType; every standard synonym opts out", async () => {
  for (const [body, want] of [[" stop ", "STOP"], ["Stop\n", "STOP"], ["\tQuit", "QUIT"], ["opt   out", "OPT OUT"], ["OptOut", "OPTOUT"],
                              ["stopall", "STOPALL"], ["UNSUBSCRIBE", "UNSUBSCRIBE"], ["cancel", "CANCEL"], ["end", "END"], ["revoke", "REVOKE"]]) {
    for (const extra of [{}, { OptOutType: "STOP" }] as Record<string, string>[]) {
      const { deps, log } = make();
      assertEquals((await handle(await inbound({ From: PHONE, Body: body, ...extra }), deps)).status, 200);
      assertEquals(log, [`suppress ${PHONE} ${want}`, `optedout ${PHONE} ${want}`], `${JSON.stringify(body)} ${JSON.stringify(extra)}`);
    }
  }
});

Deno.test("NEGATIVE CONTROL: non-keyword bodies without OptOutType do NOT opt out", async () => {
  for (const body of ["thanks", "please call me", "STOPPING", "endpoint", "yes", "HELP", "START", ""]) {
    const { deps, log } = make();
    assertEquals((await handle(await inbound({ From: PHONE, Body: body }), deps)).status, 200);
    assertEquals(log, [], JSON.stringify(body));
  }
});

Deno.test("an unsigned STOP body is still refused and writes nothing", async () => {
  const { deps, log } = make();
  assertEquals((await handle(await inbound({ From: PHONE, Body: "STOP" }, { sign: false }), deps)).status, 403);
  assertEquals(log, []);
});

// ---- Free-text opt-out flagger (Marty's ruling, #2875 comment 6365843245): whole-word keyword -> pause + review, NOT an opt-out ----

Deno.test("findOptOutKeywords: a keyword as a whole word matches, case-insensitively", () => {
  const hit: [string, string[]][] = [
    ["stop", ["STOP"]], ["STOP", ["STOP"]], ["Please stop texting me", ["STOP"]], ["stop by tomorrow", ["STOP"]],
    ["Stop.", ["STOP"]], ["stop-over", ["STOP"]], ["I want to opt out", ["OPT OUT"]], ["opt-out please", ["OPT OUT"]],
    ["OPT   OUT", ["OPT OUT"]], ["cancel my account", ["CANCEL"]], ["this is the end", ["END"]], ["quit!", ["QUIT"]],
    ["unsubscribe me", ["UNSUBSCRIBE"]], ["I revoke consent", ["REVOKE"]], ["optout", ["OPTOUT"]], ["stopall", ["STOPALL"]],
    ["stop\nthanks", ["STOP"]], ["stop and cancel, stop", ["STOP", "CANCEL"]],
  ];
  for (const [body, want] of hit) assertEquals(findOptOutKeywords(body), want, JSON.stringify(body));
});

Deno.test("findOptOutKeywords NEGATIVE CONTROL: a keyword inside a longer word does NOT match", () => {
  for (const body of ["stopped by yesterday", "nonstop", "STOPPING", "unstoppable", "endpoint", "weekend", "cancelled", "quitting",
                      "bus stops here", "stop_sign", "opted", "thanks", "yes", "HELP", "START", "", "   "]) {
    assertEquals(findOptOutKeywords(body), [], JSON.stringify(body));
  }
});

Deno.test("free text with a whole-word keyword: PAUSES + queues for review; no suppression, no opted_out flip; replies empty TwiML", async () => {
  const { deps, log } = make();
  const r = await handle(await inbound({ From: PHONE, Body: "please stop texting me", MessageSid: "SM123" }), deps);
  assertEquals(r.status, 200);
  assertEquals(await r.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assertEquals(log, [`flag ${PHONE} "please stop texting me" [STOP] SM123`]);
});

Deno.test("free text is flagged even when Twilio tags it HELP, and START with extra words is flagged, not released", async () => {
  for (const extra of [{ OptOutType: "HELP" }, { OptOutType: "START" }] as Record<string, string>[]) {
    const { deps, log } = make();
    assertEquals((await handle(await inbound({ From: PHONE, Body: "start but cancel everything", ...extra }), deps)).status, 200);
    assertEquals(log, [`flag ${PHONE} "start but cancel everything" [CANCEL] null`]);
  }
});

Deno.test("free text WITHOUT a whole-word keyword is not flagged (stopped by / nonstop)", async () => {
  for (const body of ["stopped by yesterday", "nonstop calls", "thanks"]) {
    const { deps, log } = make();
    assertEquals((await handle(await inbound({ From: PHONE, Body: body }), deps)).status, 200);
    assertEquals(log, [], body);
  }
});

Deno.test("exact keyword stays a full opt-out and is NOT also flagged; literal START still releases", async () => {
  const a = make();
  await handle(await inbound({ From: PHONE, Body: "STOP" }), a.deps);
  assertEquals(a.log, [`suppress ${PHONE} STOP`, `optedout ${PHONE} STOP`]);
  const b = make();
  await handle(await inbound({ From: PHONE, Body: "START", OptOutType: "START" }), b.deps);
  assertEquals(b.log, [`release ${PHONE}`]);
});

Deno.test("a failed flag write -> 500 (Twilio retries; a possible revocation is never dropped)", async () => {
  const { deps } = make({ flag: () => Promise.resolve(false) });
  assertEquals((await handle(await inbound({ From: PHONE, Body: "stop calling" }), deps)).status, 500);
});

Deno.test("an unsigned free-text keyword body is refused and flags nothing", async () => {
  const { deps, log } = make();
  assertEquals((await handle(await inbound({ From: PHONE, Body: "please stop" }, { sign: false }), deps)).status, 403);
  assertEquals(log, []);
});

Deno.test("#3761: a STOP also re-labels a staff-recorded open opt-out (recordStopOverStaff), and a failed re-label is a 500 so Twilio retries", async () => {
  const seen: string[] = [];
  const ok = make({ recordStopOverStaff: (p, k) => { seen.push(`${p} ${k}`); return Promise.resolve(true); } });
  assertEquals((await handle(await inbound({ From: PHONE, Body: "STOP", OptOutType: "STOP" }), ok.deps)).status, 200);
  assertEquals(seen, [`${PHONE} STOP`]);
  const bad = make({ recordStopOverStaff: () => Promise.resolve(false) });
  assertEquals((await handle(await inbound({ From: PHONE, Body: "STOP", OptOutType: "STOP" }), bad.deps)).status, 500);
});

// ---- #3771: a STOP racing a staff release must always leave an open sms_keyword row ----
// Stateful in-memory store mirroring the live rules: ONE open row per phone (insert -> 23505 no-op), the relabel only touches
// open staff rows, the staff release closes open staff rows. `beforeRelabel` injects the staff release between the STOP's
// failed insert and its relabel (the exact interleaving of the issue). Deps are cast because the base handler has no hasOpenStop.
type Row = { phone: string; channel: string; released_at: string | null };
function store(beforeRelabel: (rows: Row[], n: number) => void = () => {}) {
  const rows: Row[] = [{ phone: PHONE, channel: "support_call", released_at: null }]; // staff opt-out already open
  let relabels = 0;
  const open = () => rows.filter((r) => r.phone === PHONE && r.released_at === null);
  const { deps } = make({
    suppress: (p) => {
      if (open().length === 0) rows.push({ phone: p, channel: "sms_keyword", released_at: null }); // else 23505: no-op, success
      return Promise.resolve(true);
    },
    recordStopOverStaff: () => {
      relabels++;
      beforeRelabel(rows, relabels);
      for (const r of open()) if (r.channel === "email" || r.channel === "support_call") r.channel = "sms_keyword";
      return Promise.resolve(true);
    },
    ...({ hasOpenStop: () => Promise.resolve(open().some((r) => r.channel === "sms_keyword")) } as unknown as Partial<Deps>),
  });
  return { deps, rows, open };
}
const staffRelease = (rows: Row[]) => { for (const r of rows) if (r.released_at === null && r.channel !== "sms_keyword") r.released_at = "staff-release"; };

Deno.test("#3771: staff release commits between the STOP's 23505 no-op and its relabel -> an open sms_keyword row still exists", async () => {
  const s = store((rows, n) => { if (n === 1) staffRelease(rows); });
  const r = await handle(await inbound({ From: PHONE, Body: "STOP", OptOutType: "STOP" }), s.deps);
  assertEquals(r.status, 200);
  assertEquals(s.open().length, 1);
  assertEquals(s.open()[0].channel, "sms_keyword");
});

Deno.test("#3771: no race -> unchanged behaviour (staff row relabelled once, no extra row)", async () => {
  const s = store();
  assertEquals((await handle(await inbound({ From: PHONE, Body: "STOP", OptOutType: "STOP" }), s.deps)).status, 200);
  assertEquals(s.rows.length, 1);
  assertEquals(s.open()[0].channel, "sms_keyword");
});

Deno.test("#3771: staff releases on every pass -> bounded, ends 200 with an open row (insert wins) ", async () => {
  const s = store((rows, n) => { if (n <= 2) staffRelease(rows); });
  assertEquals((await handle(await inbound({ From: PHONE, Body: "STOP", OptOutType: "STOP" }), s.deps)).status, 200);
  assertEquals(s.open().map((r) => r.channel), ["sms_keyword"]);
});

Deno.test("#3771: if no open STOP row can be confirmed, the answer is 500 (Twilio retries), never a 200 with nothing open", async () => {
  const { deps } = make(({ hasOpenStop: () => Promise.resolve(false) } as unknown as Partial<Deps>));
  assertEquals((await handle(await inbound({ From: PHONE, Body: "STOP", OptOutType: "STOP" }), deps)).status, 500);
});
