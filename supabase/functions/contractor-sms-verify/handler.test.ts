// D-391 layer 2 (#2875): contractor-sms-verify. Run: deno test supabase/functions/contractor-sms-verify/handler.test.ts
// No network, no Twilio, no database, no SMS: every dependency is a counting fake.
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { type ContractorRow, type Deps, handle, maskPhone, normalizePhone, type NumberInsert } from "./handler.ts";

const USER = "7d6c5b4a-3f2e-4d1c-8b0a-9e8f7d6c5b4a";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const CID = "11111111-2222-4333-8444-555555555555";
const DB_TEXT = "DB-HELD DISCLOSURE TEXT (test fixture, not real wording)";

interface Spy {
  twilio: { url: string; body: string }[];
  inserts: NumberInsert[];
  bumps: string[];
  prefs: string[];
  rl: string[];
}
function make(over: Partial<Deps> = {}, opts: { twilioStatus?: string; twilioHttp?: number; env?: Record<string, string> } = {}) {
  const spy: Spy = { twilio: [], inserts: [], bumps: [], prefs: [], rl: [] };
  const env: Record<string, string> = {
    TWILIO_ACCOUNT_SID: "ACfixture", TWILIO_AUTH_TOKEN: "fixture-token", TWILIO_VERIFY_SERVICE_SID: "VAfixture", ...opts.env,
  };
  const deps: Deps = {
    env: (n) => env[n],
    fetch: (url, init) => {
      spy.twilio.push({ url, body: String(init.body) });
      const http = opts.twilioHttp ?? 200;
      return Promise.resolve(new Response(JSON.stringify({ status: opts.twilioStatus ?? "pending", sid: "VEfixture" }), { status: http }));
    },
    now: () => new Date("2026-10-21T12:00:00.000Z"),
    getUser: (t) => Promise.resolve(t === "good" ? { id: USER } : null),
    getContractor: (id): Promise<ContractorRow | null> => Promise.resolve(id === CID ? { id: CID, user_id: USER } : null),
    getCurrentDisclosure: () => Promise.resolve({ id: "v-current", disclosure_text: DB_TEXT }),
    isSuppressed: () => Promise.resolve(false),
    rateLimit: (fn, b) => { spy.rl.push(`${fn}:${b}`); return Promise.resolve("allowed"); },
    findVerified: () => Promise.resolve(null),
    hasPrimary: () => Promise.resolve(false),
    insertNumber: (row) => { spy.inserts.push(row); return Promise.resolve({ id: "n1" }); },
    bumpConfirmed: (id) => { spy.bumps.push(id); return Promise.resolve(true); },
    insertDefaultPreference: (id) => { spy.prefs.push(id); return Promise.resolve(); },
    ...over,
  };
  return { deps, spy };
}
function post(body: Record<string, unknown>, auth: string | null = "Bearer good"): Request {
  const h: Record<string, string> = { "Content-Type": "application/json", "user-agent": "test-ua", "x-forwarded-for": "203.0.113.9, 10.0.0.1" };
  if (auth) h.Authorization = auth;
  return new Request("https://x.test/f", { method: "POST", headers: h, body: JSON.stringify(body) });
}
const base = { contractor_id: CID, phone: "(515) 555-0142", source: "signup", consent_checked: true, disclosure_version_id: "v-current" };
const start = { ...base, action: "start" };
const check = { ...base, action: "check", code: "123456" };
async function code(res: Response) { return (await res.json()).error_code as string; }
function nothingHappened(spy: Spy) {
  assertEquals(spy.twilio.length, 0, "Twilio must not be called");
  assertEquals(spy.inserts.length, 0, "no consent record may be written");
}

Deno.test("normalizePhone: NANP and E.164 in, junk out", () => {
  assertEquals(normalizePhone("(515) 555-0142"), "+15155550142");
  assertEquals(normalizePhone("1-515-555-0142"), "+15155550142");
  assertEquals(normalizePhone("+44 20 7946 0958"), "+442079460958");
  for (const bad of ["", "555-0142", "015-555-0142", "(515) 155-0142", "abc", null, 5155550142, "+0123456789"]) assertEquals(normalizePhone(bad), null, String(bad));
  assertEquals(maskPhone("+15155550142"), "***0142");
});

Deno.test("no / bad token -> 401, nothing happens", async () => {
  for (const auth of [null, "Bearer nope", "Basic good"]) {
    const { deps, spy } = make();
    const r = await handle(post(start, auth), deps);
    assertEquals(r.status, 401);
    nothingHappened(spy);
    assertEquals(spy.rl.length, 0);
  }
});

Deno.test("signed in as a different user -> 403, nothing happens", async () => {
  const { deps, spy } = make({ getContractor: () => Promise.resolve({ id: CID, user_id: OTHER }) });
  const r = await handle(post(start), deps);
  assertEquals(r.status, 403);
  nothingHappened(spy);
});

Deno.test("unticked box -> 400 consent_required on both actions", async () => {
  for (const b of [start, check]) {
    const { deps, spy } = make();
    const r = await handle(post({ ...b, consent_checked: false }), deps);
    assertEquals(r.status, 400);
    assertEquals(await code(r), "consent_required");
    nothingHappened(spy);
  }
  const { deps } = make();
  const { consent_checked: _omit, ...noFlag } = start;
  assertEquals((await handle(post(noFlag), deps)).status, 400);
});

Deno.test("bad inputs -> 400 before any I/O", async () => {
  for (const b of [{ ...start, action: "send" }, { ...start, phone: "123" }, { ...start, source: "admin" }, { ...start, contractor_id: "x" },
                   { ...check, code: "12345" }, { ...check, code: "abcdef" }, { ...start, disclosure_version_id: "" }]) {
    const { deps, spy } = make();
    assertEquals((await handle(post(b), deps)).status, 400, JSON.stringify(b));
    nothingHappened(spy);
  }
});

Deno.test("no disclosure row seeded -> 409 disclosure_unavailable; stale id -> 409 disclosure_stale", async () => {
  let m = make({ getCurrentDisclosure: () => Promise.resolve(null) });
  let r = await handle(post(start), m.deps);
  assertEquals([r.status, await code(r)], [409, "disclosure_unavailable"]);
  nothingHappened(m.spy);
  m = make();
  r = await handle(post({ ...start, disclosure_version_id: "v-old" }), m.deps);
  assertEquals([r.status, await code(r)], [409, "disclosure_stale"]);
  nothingHappened(m.spy);
});

Deno.test("suppressed number is never texted a code, and never recorded", async () => {
  for (const b of [start, check]) {
    const { deps, spy } = make({ isSuppressed: () => Promise.resolve(true) }, { twilioStatus: "approved" });
    const r = await handle(post(b), deps);
    assertEquals([r.status, await code(r)], [409, "number_suppressed"]);
    nothingHappened(spy);
  }
});

Deno.test("rate limit: denied -> 429, RPC error -> 503 (fail closed), checked per account AND per number", async () => {
  let m = make({ rateLimit: () => Promise.resolve("denied") });
  assertEquals((await handle(post(start), m.deps)).status, 429);
  nothingHappened(m.spy);
  m = make({ rateLimit: () => Promise.resolve("error") });
  assertEquals((await handle(post(start), m.deps)).status, 503);
  nothingHappened(m.spy);
  m = make();
  await handle(post(start), m.deps);
  assertEquals(m.spy.rl.length, 2);
  assert(m.spy.rl[0].startsWith(`contractor-sms-verify-start:${USER}`));
  assert(!m.spy.rl[1].includes(USER) && !m.spy.rl[1].includes("5155550142"), "per-number bucket is a hash");
  assert(m.spy.rl[0] !== m.spy.rl[1]);
  m = make();
  await handle(post(check), m.deps);
  assert(m.spy.rl[0].startsWith("contractor-sms-verify-check:"));
});

Deno.test("Verify service not configured -> 503, no Twilio call", async () => {
  const { deps, spy } = make({}, { env: { TWILIO_VERIFY_SERVICE_SID: "" } });
  const r = await handle(post(start), deps);
  assertEquals([r.status, await code(r)], [503, "verify_not_configured"]);
  nothingHappened(spy);
});

Deno.test("start: asks Twilio Verify for an sms code, writes no record", async () => {
  const { deps, spy } = make({}, { env: { TWILIO_VERIFY_TEMPLATE_SID: "HJfixture" } });
  const r = await handle(post(start), deps);
  assertEquals(r.status, 200);
  assertEquals(spy.twilio.length, 1);
  assertEquals(spy.twilio[0].url, "https://verify.twilio.com/v2/Services/VAfixture/Verifications");
  const f = new URLSearchParams(spy.twilio[0].body);
  assertEquals([f.get("To"), f.get("Channel"), f.get("TemplateSid")], ["+15155550142", "sms", "HJfixture"]);
  assertEquals(spy.inserts.length, 0);
});

Deno.test("start: Twilio failure -> error code, no record", async () => {
  const { deps, spy } = make({}, { twilioHttp: 500 });
  const r = await handle(post(start), deps);
  assertEquals([r.status, await code(r)], [502, "code_not_sent"]);
  assertEquals(spy.inserts.length, 0);
});

Deno.test("check NEGATIVE CONTROL: any answer but 'approved' writes no consent record", async () => {
  for (const [status, http, want] of [["pending", 200, "wrong_code"], ["canceled", 200, "wrong_code"], ["", 404, "no_pending_code"], ["", 429, "too_many_attempts"], ["", 500, "check_failed"]] as const) {
    const { deps, spy } = make({}, { twilioStatus: status, twilioHttp: http });
    const r = await handle(post(check), deps);
    assertEquals(await code(r), want);
    assertEquals(spy.inserts.length, 0, `${status}/${http}`);
    assertEquals(spy.prefs.length, 0);
  }
});

Deno.test("check approved: writes the record from DB-held disclosure text, never client text; first number is primary", async () => {
  const { deps, spy } = make({}, { twilioStatus: "approved" });
  const r = await handle(post({ ...check, disclosure_text: "CLIENT-SUPPLIED TEXT", phone_e164: "+19999999999", user_id: OTHER }), deps);
  assertEquals(r.status, 200);
  assertEquals(spy.inserts.length, 1);
  const row = spy.inserts[0];
  assertEquals(row.disclosure_text, DB_TEXT);
  assertEquals(row.disclosure_version_id, "v-current");
  assertEquals(row.phone_e164, "+15155550142");
  assertEquals(row.user_id, USER);
  assertEquals(row.contractor_id, CID);
  assertEquals([row.is_primary, row.verification_method, row.source, row.verify_sid], [true, "sms_otp", "signup", "VEfixture"]);
  assertEquals([row.verified_at, row.last_confirmed_at], ["2026-10-21T12:00:00.000Z", "2026-10-21T12:00:00.000Z"]);
  assertEquals([row.consent_ip, row.consent_user_agent], ["203.0.113.9", "test-ua"]);
  assertEquals(spy.prefs, ["n1"]);
  assertEquals(new URLSearchParams(spy.twilio[0].body).get("Code"), "123456");
  assertEquals(spy.twilio[0].url, "https://verify.twilio.com/v2/Services/VAfixture/VerificationCheck");
});

Deno.test("check approved: a second number is not primary", async () => {
  const { deps, spy } = make({ hasPrimary: () => Promise.resolve(true) }, { twilioStatus: "approved" });
  await handle(post({ ...check, source: "settings" }), deps);
  assertEquals([spy.inserts[0].is_primary, spy.inserts[0].source], [false, "settings"]);
});

Deno.test("check approved: primary race is retried once as non-primary; a lost same-number race reconfirms", async () => {
  let calls = 0;
  let m = make({ insertNumber: () => { calls++; return Promise.resolve(calls === 1 ? { conflict: "primary" as const } : { id: `n${calls}` }); } }, { twilioStatus: "approved" });
  let r = await handle(post(check), m.deps);
  assertEquals([r.status, calls], [200, 2]);
  let n = 0;
  m = make({ insertNumber: () => Promise.resolve({ conflict: "live" as const }), findVerified: () => Promise.resolve(n++ === 0 ? null : { id: "w" }) }, { twilioStatus: "approved" });
  r = await handle(post(check), m.deps);
  assertEquals((await r.json()).reconfirmed, true);
});

Deno.test("check approved on an already-verified number: only the confirmation clock moves", async () => {
  const { deps, spy } = make({ findVerified: () => Promise.resolve({ id: "old" }) }, { twilioStatus: "approved" });
  const r = await handle(post({ ...check, source: "reverify" }), deps);
  const j = await r.json();
  assertEquals([r.status, j.reconfirmed, j.number_id], [200, true, "old"]);
  assertEquals(spy.bumps, ["old"]);
  assertEquals(spy.inserts.length, 0);
});

Deno.test("insert failure -> 500 and no preference row", async () => {
  const { deps, spy } = make({ insertNumber: () => Promise.resolve({ error: "boom" }) }, { twilioStatus: "approved" });
  assertEquals((await handle(post(check), deps)).status, 500);
  assertEquals(spy.prefs.length, 0);
});

Deno.test("CORS preflight and non-POST", async () => {
  const { deps } = make();
  assertEquals((await handle(new Request("https://x.test/f", { method: "OPTIONS", headers: { Origin: "https://app.otterquote.com" } }), deps)).status, 200);
  assertEquals((await handle(new Request("https://x.test/f", { method: "GET" }), deps)).status, 405);
});
