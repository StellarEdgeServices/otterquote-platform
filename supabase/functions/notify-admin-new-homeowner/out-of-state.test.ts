// gh-2421 (D-344) tests: out-of-state claim alert.
// Run: deno test --allow-read=supabase/functions supabase/functions/notify-admin-new-homeowner/out-of-state.test.ts
import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { handleOutOfStateClaim } from "./out-of-state.ts";
import {
  buildOutOfStateClaimEmail,
  DEFAULT_BLOCKED_STATES,
  isAlertableOutOfState,
  isOutOfStateClaimAuthorized,
  normalizeBody,
  parseBlockedStates,
} from "./notify-helpers.ts";

// ---- minimal in-memory stand-in for the supabase-js query builder ---------
type Row = Record<string, any>;
function makeSb(tables: Record<string, Row[]>, opts: { settingsError?: boolean } = {}) {
  const writes: { table: string; op: string; values?: Row }[] = [];
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let mode: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    const filters: ((r: Row) => boolean)[] = [];
    let returning = false;
    const b: any = {
      select(_cols?: string) { if (mode === "update") returning = true; return b; },
      update(p: Row) { mode = "update"; patch = p; return b; },
      insert(r: Row) { mode = "insert"; writes.push({ table, op: "insert", values: r }); rows.push({ ...r }); return Promise.resolve({ error: null }); },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not(c: string, op: string, v: unknown) { if (op === "is") filters.push((r) => (r[c] ?? null) !== v); return b; },
      maybeSingle() {
        if (table === "platform_settings" && opts.settingsError) return Promise.resolve({ data: null, error: { message: "boom" } });
        const hit = rows.filter((r) => filters.every((f) => f(r)))[0] ?? null;
        return Promise.resolve({ data: hit ? { ...hit } : null, error: null });
      },
      then(resolve: (v: unknown) => void) {
        const hits = rows.filter((r) => filters.every((f) => f(r)));
        if (mode === "update") {
          for (const h of hits) Object.assign(h, patch);
          writes.push({ table, op: "update", values: patch });
          resolve({ data: returning ? hits.map((h) => ({ ...h })) : null, error: null });
        } else resolve({ data: hits, error: null });
      },
    };
    return b;
  }
  return { from, writes, tables };
}

const REAL_USER = { id: "u1", email: "homeowner@gmail.com", is_test: false };
function fixture(over: Row = {}, extra: { blockedValue?: unknown; noSetting?: boolean } = {}) {
  const claim = { id: "c1", user_id: "u1", trades: ["roofing"], property_state: "WA", is_test: false, out_of_state_alerted_at: null, claim_number: null, ...over };
  const tables: Record<string, Row[]> = {
    claims: [claim],
    profiles: [{ ...REAL_USER }],
    platform_settings: extra.noSetting ? [] : [{ key: "homeowner_blocked_states", value: extra.blockedValue ?? ["FL", "LA", "TX"] }],
    notifications: [],
  };
  return { sb: makeSb(tables), tables };
}
function mailer() {
  const sent: { subject: string; text: string }[] = [];
  return { sent, sendMail: (subject: string, text: string) => { sent.push({ subject, text }); return Promise.resolve({ id: "mg-1" }); } };
}

Deno.test("WA claim -> exactly one alert naming state, trade and claim id", async () => {
  const { sb } = fixture();
  const m = mailer();
  const r = await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(r.status, 200);
  assertEquals(m.sent.length, 1);
  assertEquals(m.sent[0].subject, "Out-of-state claim: WA — roofing — c1");
  assertMatch(m.sent[0].text, /State: WA/);
  assertMatch(m.sent[0].text, /Trade\(s\): roofing/);
  assertMatch(m.sent[0].text, /Claim ID: c1/);
});

Deno.test("IN claim -> no alert (and no stamp)", async () => {
  const { sb, tables } = fixture({ property_state: "IN" });
  const m = mailer();
  const r = await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(r.body.reason, "in_state");
  assertEquals(m.sent.length, 0);
  assertEquals(tables.claims[0].out_of_state_alerted_at, null);
});

Deno.test("lowercase / padded 'in' is still Indiana -> no alert", async () => {
  const { sb } = fixture({ property_state: " in " });
  const m = mailer();
  await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(m.sent.length, 0);
});

Deno.test("FL (blocked) claim -> no alert", async () => {
  const { sb } = fixture({ property_state: "FL" });
  const m = mailer();
  const r = await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(r.body.reason, "blocked_state");
  assertEquals(m.sent.length, 0);
});

Deno.test("blocked list is read from platform_settings: removing FL from config makes FL alert", async () => {
  const { sb } = fixture({ property_state: "FL" }, { blockedValue: ["LA", "TX"] });
  const m = mailer();
  await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(m.sent.length, 1);
});

Deno.test("blocked list: adding WA to config suppresses the WA alert", async () => {
  const { sb } = fixture({}, { blockedValue: ["FL", "LA", "TX", "WA"] });
  const m = mailer();
  await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(m.sent.length, 0);
});

Deno.test("platform_settings row missing -> falls back to FL/LA/TX (FL silent, WA alerts)", async () => {
  const fl = fixture({ property_state: "FL" }, { noSetting: true });
  const m1 = mailer();
  await handleOutOfStateClaim({ sb: fl.sb, sendMail: m1.sendMail }, { id: "c1" });
  assertEquals(m1.sent.length, 0);
  const wa = fixture({}, { noSetting: true });
  const m2 = mailer();
  await handleOutOfStateClaim({ sb: wa.sb, sendMail: m2.sendMail }, { id: "c1" });
  assertEquals(m2.sent.length, 1);
});

Deno.test("platform_settings read error or malformed value -> falls back to FL/LA/TX", async () => {
  const tables = { claims: [{ id: "c1", user_id: "u1", trades: ["siding"], property_state: "TX", is_test: false, out_of_state_alerted_at: null }], profiles: [{ ...REAL_USER }], platform_settings: [], notifications: [] };
  const m = mailer();
  await handleOutOfStateClaim({ sb: makeSb(tables, { settingsError: true }), sendMail: m.sendMail }, { id: "c1" });
  assertEquals(m.sent.length, 0);
  assertEquals(parseBlockedStates("FL"), [...DEFAULT_BLOCKED_STATES]);
  assertEquals(parseBlockedStates({ a: 1 }), [...DEFAULT_BLOCKED_STATES]);
  assertEquals(parseBlockedStates([1, 2]), [...DEFAULT_BLOCKED_STATES]);
  assertEquals(parseBlockedStates([]), []);
  assertEquals(parseBlockedStates([" fl ", "tx"]), ["FL", "TX"]);
});

Deno.test("claim.is_test -> no alert", async () => {
  const { sb } = fixture({ is_test: true });
  const m = mailer();
  const r = await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(r.body.reason, "test_account");
  assertEquals(m.sent.length, 0);
});

Deno.test("test profile / internal email -> no alert", async () => {
  for (const profile of [{ id: "u1", email: "x@gmail.com", is_test: true }, { id: "u1", email: "qa@otterquote.com", is_test: false }, { id: "u1", email: "dustin+test@gmail.com", is_test: false }]) {
    const f = fixture();
    f.tables.profiles = [profile];
    const m = mailer();
    await handleOutOfStateClaim({ sb: f.sb, sendMail: m.sendMail }, { id: "c1" });
    assertEquals(m.sent.length, 0, profile.email);
  }
});

Deno.test("second call for the same claim -> no second send", async () => {
  const { sb, tables } = fixture();
  const m = mailer();
  await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assert(tables.claims[0].out_of_state_alerted_at);
  const r2 = await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(r2.body.reason, "already_alerted");
  assertEquals(m.sent.length, 1);
});

Deno.test("concurrent calls -> exactly one send (atomic stamp)", async () => {
  const { sb } = fixture();
  const m = mailer();
  await Promise.all([1, 2, 3].map(() => handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" })));
  assertEquals(m.sent.length, 1);
});

Deno.test("state set later (NULL at insert, then WA): NULL -> no alert, later WA -> alert once", async () => {
  const { sb, tables } = fixture({ property_state: null });
  const m = mailer();
  const r1 = await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(r1.body.reason, "no_state");
  assertEquals(m.sent.length, 0);
  tables.claims[0].property_state = "WA"; // the later UPDATE OF property_state
  await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(m.sent.length, 1);
});

Deno.test("mailgun failure reverts the stamp so a retry can send", async () => {
  const { sb, tables } = fixture();
  const r1 = await handleOutOfStateClaim({ sb, sendMail: () => Promise.reject(new Error("mg down")) }, { id: "c1" });
  assertEquals(r1.status, 500);
  assertEquals(tables.claims[0].out_of_state_alerted_at, null);
  const m = mailer();
  await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1" });
  assertEquals(m.sent.length, 1);
});

Deno.test("forged request body fields are ignored: email comes from the DB row", async () => {
  const { sb } = fixture();
  const m = mailer();
  await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "c1", property_state: "ZZ", trades: ["evil\r\nBcc: x@y.z"], is_test: true });
  assertEquals(m.sent.length, 1);
  assertEquals(m.sent[0].subject, "Out-of-state claim: WA — roofing — c1");
});

Deno.test("missing record.id -> 400; unknown claim -> skipped", async () => {
  const { sb } = fixture();
  const m = mailer();
  assertEquals((await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, {})).status, 400);
  assertEquals((await handleOutOfStateClaim({ sb, sendMail: m.sendMail }, { id: "nope" })).body.reason, "not_eligible");
  assertEquals(m.sent.length, 0);
});

Deno.test("auth: anon key rejected for out_of_state_claim; service-role accepted", () => {
  assertEquals(isOutOfStateClaimAuthorized("anon-key", "service-key"), false);
  assertEquals(isOutOfStateClaimAuthorized("", "service-key"), false);
  assertEquals(isOutOfStateClaimAuthorized("service-key", "service-key"), true);
});

Deno.test("normalizeBody recognises out_of_state_claim and rejects a record-less payload", () => {
  assertEquals(normalizeBody({ event_type: "out_of_state_claim", record: { id: "c1" } })?.eventType, "out_of_state_claim");
  assertEquals(normalizeBody({ event_type: "out_of_state_claim" }), null);
});

Deno.test("isAlertableOutOfState truth table", () => {
  const b = ["FL", "LA", "TX"];
  assertEquals(isAlertableOutOfState("WA", b), true);
  assertEquals(isAlertableOutOfState("OH", b), true);
  assertEquals(isAlertableOutOfState("IN", b), false);
  assertEquals(isAlertableOutOfState("fl", b), false);
  assertEquals(isAlertableOutOfState("", b), false);
  assertEquals(isAlertableOutOfState(null, b), false);
});

Deno.test("email: multiple trades listed, CRLF stripped, HTML escaped", () => {
  const e = buildOutOfStateClaimEmail({ id: "c9", property_state: "wa", trades: ["roofing", "siding"] });
  assertEquals(e.subject, "Out-of-state claim: WA — roofing, siding — c9");
  const bad = buildOutOfStateClaimEmail({ id: "c9", property_state: "WA", trades: ["a\r\nBcc: x"], claim_number: "<b>" });
  assert(!/[\r\n]/.test(bad.subject));
  assertEquals(bad.htmlRows.find((r) => r[0] === "Claim number")?.[1], "&lt;b&gt;");
});

// ---- source-level wiring (index.ts calls serve() at import, so read as text) ----
async function indexSource(): Promise<string> {
  const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}
Deno.test("index.ts wiring: out_of_state_claim is gated on the service-role-only check before the handler runs", async () => {
  const src = await indexSource();
  assertMatch(src, /eventType === "out_of_state_claim"[\s\S]*?isOutOfStateClaimAuthorized\(bearerToken, serviceRoleKey\)[\s\S]*?handleOutOfStateClaim\(/);
});
Deno.test("index.ts wiring: out-of-state HTML is built by templates.ts", async () => {
  assertMatch(await indexSource(), /outOfStateClaimHtml\(htmlRows, extraHtml\)/);
});
