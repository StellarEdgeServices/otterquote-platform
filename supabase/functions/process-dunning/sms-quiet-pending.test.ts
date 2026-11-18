// gh-3762 (PR #3774 REVIEW B1): HANDLER-LEVEL proof that quiet hours DEFER the dunning reminder / warning TEXT instead of
// dropping it, with email timing and the state advance unchanged. Drives the real exported handler (CRON mode) with a
// stateful in-memory PostgREST fake, a controllable clock, and fetch + Deno.env stubbed (no network, no Twilio, no Mailgun).
// Contractor: Indiana, timezone America/New_York (the shape of all 16 production contractors): window 09:00-20:00 ET
// (CT candidate zone), i.e. 14:00Z-01:00Z in November. 2026-11-16 is a Monday, EST (UTC-5).
// Run: deno test --allow-read=supabase/functions supabase/functions/process-dunning/sms-quiet-pending.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { handler } from "./index.ts";

// ---- controllable clock (own isolate per test file) ----
let NOW = new Date("2026-11-16T13:00:00Z").getTime();
{
  const RealDate = Date;
  // deno-lint-ignore no-explicit-any
  class ClockDate extends RealDate { constructor(...a: any[]) { if (a.length === 0) super(NOW); else super(...(a as [number])); } static override now() { return NOW; } }
  globalThis.Date = ClockDate as unknown as DateConstructor;
}
const setNow = (iso: string) => { NOW = new Date(iso).getTime(); };

const KEY = "fixture-pending-service-key-0123456789";
const BASE = "https://x.supabase.co/functions/v1/process-dunning";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY, TWILIO_ACCOUNT_SID: "ACfixture",
  TWILIO_AUTH_TOKEN: "fixture-token", TWILIO_MESSAGING_SERVICE_SID: "MGfixture", MAILGUN_API_KEY: "fixture-mailgun",
};
const contractor = { id: "c1", company_name: "Fixture Roofing", email: "c@example.com", notification_emails: [], user_id: null, timezone: "America/New_York", address_state: "IN", is_test: true };
const claim = { id: "cl1", property_address: "1 Main St", status: "payment_failed" };

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
function failure(over: Row): Row {
  return {
    id: "f1", quote_id: "q1234567", contractor_id: "c1", claim_id: "cl1", homeowner_id: "h1", amount_cents: 12345, reminder_count: 0,
    contractor_timezone: "America/New_York", dunning_status: "active", sms_pending_kind: null, sms_pending_since: null,
    contractors: contractor, claims: claim, ...over,
  };
}

interface Sent { at: string; to: string; body: string }
interface World { rows: Row[]; textable: Array<{ number_id: string; phone_e164: string; is_primary: boolean }>; twilio: Sent[]; emails: Array<{ at: string; subject: string }>; logs: string[]; patches: Row[]; quotePaid: boolean; paused: boolean; noMarkerColumns: boolean; twilioFail: boolean; onTwilioFail?: () => void }
const TEXTABLE2 = () => [
  { number_id: "n1", phone_e164: "+13175550101", is_primary: true },
  { number_id: "n2", phone_e164: "+13175550102", is_primary: false },
];
function world(rows: Row[]): World { return { rows, textable: TEXTABLE2(), twilio: [], emails: [], logs: [], patches: [], quotePaid: false, paused: false, noMarkerColumns: false, twilioFail: false }; }

const missingColumn = () => new Response(JSON.stringify({ code: "PGRST204", message: "Could not find the 'sms_pending_kind' column of 'payment_failures' in the schema cache" }), { status: 400, headers: { "Content-Type": "application/json" } });
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });

const cronRequest = () => new Request(BASE, { method: "POST", headers: { Authorization: `Bearer ${KEY}` } });
/** One CRON run at `iso`. */
async function runAt(w: World, iso: string): Promise<void> {
  await withStubs(w, iso, async () => {
    const res = await handler(cronRequest(), (n) => ENV[n]);
    assertEquals(res.status, 200);
  });
}
/** `n` CRON runs overlapping in one isolate (same stubs, same fake database). */
async function runOverlapping(w: World, iso: string, n: number): Promise<void> {
  await withStubs(w, iso, async () => {
    const rs = await Promise.all(Array.from({ length: n }, () => handler(cronRequest(), (e) => ENV[e])));
    for (const r of rs) assertEquals(r.status, 200);
  });
}
async function withStubs(w: World, iso: string, fn: () => Promise<void>): Promise<void> {
  setNow(iso);
  const realFetch = globalThis.fetch, realEnv = Deno.env, rw = console.warn, rl = console.log, re = console.error;
  const cap = (...a: unknown[]) => { w.logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  console.warn = cap; console.log = cap; console.error = cap;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.twilio.com") {
      const p = new URLSearchParams(await req.text());
      w.twilio.push({ at: iso, to: p.get("To") ?? "", body: p.get("Body") ?? "" });
      if (w.twilioFail) { w.onTwilioFail?.(); return new Response("boom", { status: 500 }); }
      return json({ sid: "SMfixture" });
    }
    if (url.hostname === "api.mailgun.net") {
      const p = new URLSearchParams(await req.text());
      w.emails.push({ at: iso, subject: p.get("subject") ?? "" });
      return json({ id: "mg" });
    }
    if (!url.pathname.startsWith("/rest/v1/")) return json({});
    const table = url.pathname.split("/").pop();
    const single = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    const q = url.searchParams;
    if (table === "contractor_textable_numbers") return json(w.textable);
    if (table === "quotes" && req.method === "GET") return json(w.quotePaid ? [{ id: w.rows[0]?.quote_id, payment_status: "succeeded" }] : []);
    if (table === "sms_optout_review" && req.method === "GET") return json(w.paused ? [{ id: "rev1" }] : []);
    if (table === "payment_failures") {
      if (req.method === "GET") {
        if (q.has("retry_unknown_at")) return json([]);
        let out = w.rows;
        const ds = q.get("dunning_status"); if (ds?.startsWith("eq.")) out = out.filter((r) => r.dunning_status === ds.slice(3));
        const nr = q.get("next_reminder_at"); if (nr?.startsWith("lte.")) out = out.filter((r) => r.next_reminder_at && new Date(r.next_reminder_at) <= new Date(nr.slice(4)));
        const hn = q.get("homeowner_notify_at"); if (hn?.startsWith("lte.")) out = out.filter((r) => r.homeowner_notify_at && new Date(r.homeowner_notify_at) <= new Date(hn.slice(4)));
        if (w.noMarkerColumns && (q.get("select") ?? "").includes("sms_pending")) return missingColumn();
        if (q.get("sms_pending_kind") === "not.is.null") out = out.filter((r) => r.sms_pending_kind != null);
        return json(single ? (out[0] ?? null) : out);
      }
      if (req.method === "PATCH") {
        const id = q.get("id")?.replace("eq.", "");
        const body = JSON.parse(await req.text());
        if (w.noMarkerColumns && Object.keys(body).some((k) => k.startsWith("sms_pending"))) return missingColumn();
        w.patches.push({ id, ...body });
        // honour the conditional filters the claim / clear / re-mark use (atomic: no await between match and assign)
        const kindF = q.get("sms_pending_kind"), sinceF = q.get("sms_pending_since");
        const row = w.rows.find((r) => r.id === id
          && (kindF === null || (kindF === "is.null" ? r.sms_pending_kind == null : r.sms_pending_kind === kindF.replace("eq.", "")))
          && (sinceF === null || r.sms_pending_since === sinceF.replace("eq.", "")));
        if (row) Object.assign(row, body);
        return json(row ? [{ id }] : []);
      }
    }
    return json(single ? { id: "x" } : req.method === "GET" ? [] : [{ id: "x" }]);
  }) as typeof fetch;
  Object.defineProperty(Deno, "env", { value: { get: (n: string) => ENV[n] }, configurable: true });
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch; Object.defineProperty(Deno, "env", { value: realEnv, configurable: true });
    console.warn = rw; console.log = rl; console.error = re;
  }
}
const BRAND_OK = (s: Sent[]) => s.every((x) => x.body.startsWith("Otter Quotes"));
const events = (w: World, ev: string) => w.logs.filter((l) => l.includes(`"event":"${ev}"`));

// 08:00 ET = 13:00Z, 09:00 ET = 14:00Z, 10:00 ET = 15:00Z (EST).
const WARNING_DUE = () => failure({ warning_at: "2026-11-16T13:00:00Z", next_reminder_at: "2026-11-16T12:00:00Z", homeowner_notify_at: "2026-11-16T15:00:00Z", reminder_count: 2 });

Deno.test("B1 Indiana: the 08:00 ET warning TEXT is refused, then sent on the 09:00 ET run; the EMAIL still goes at 08:00 and the state advances as before", async () => {
  const w = world([WARNING_DUE()]);
  await runAt(w, "2026-11-16T13:00:00Z"); // 08:00 ET: CT candidate zone is still 07:00
  assertEquals(w.twilio.length, 0, "no text inside quiet hours");
  assertEquals(w.emails.filter((e) => e.at === "2026-11-16T13:00:00Z").length, 1, "the warning email goes out at 08:00 exactly as today");
  assertEquals(w.rows[0].dunning_status, "warning_sent");
  assertEquals(w.rows[0].next_reminder_at, null);
  assertEquals(w.rows[0].sms_pending_kind, "warning");
  assertEquals(w.rows[0].sms_pending_since, "2026-11-16T13:00:00.000Z");

  await runAt(w, "2026-11-16T13:30:00Z"); // 08:30 ET: still closed
  assertEquals(w.twilio.length, 0);
  assertEquals(w.rows[0].sms_pending_kind, "warning", "stays pending while the window is closed");

  const emailsBefore = w.emails.length;
  await runAt(w, "2026-11-16T14:00:00Z"); // 09:00 ET: window opens
  assertEquals(w.twilio.map((t) => t.to).sort(), ["+13175550101", "+13175550102"], "one text per verified number");
  assert(BRAND_OK(w.twilio) && w.twilio[0].body.includes("10 a.m. today"));
  assertEquals(w.rows[0].sms_pending_kind, null, "marker cleared after the send");
  assertEquals(w.rows[0].sms_pending_since, null);
  assertEquals(w.emails.length, emailsBefore, "the late text adds no email");
  assertEquals(events(w, "sms_quiet_hours_sent_late").length, 1);

  await runAt(w, "2026-11-16T14:30:00Z"); // nothing left to send
  assertEquals(w.twilio.length, 2, "sent exactly once");
});

Deno.test("B1 06:00 ET reminder: email and schedule as today; the text is marked pending, and goes out once the window opens when no later step has fired", async () => {
  // Hourly reminder due 06:00 ET (11:00Z); warning is a day away in this fixture, so no later step fires before 09:00 ET.
  const w = world([failure({ warning_at: "2026-11-17T13:00:00Z", next_reminder_at: "2026-11-16T11:00:00Z", homeowner_notify_at: "2026-11-17T15:00:00Z" })]);
  await runAt(w, "2026-11-16T11:00:00Z");
  assertEquals(w.twilio.length, 0);
  assertEquals(w.emails.length, 1, "reminder email at 06:00 unchanged");
  assertEquals(w.rows[0].reminder_count, 1);
  assertEquals(w.rows[0].next_reminder_at, "2026-11-16T12:00:00.000Z", "D-130 next reminder time unchanged");
  assertEquals(w.rows[0].dunning_status, "active");
  assertEquals(w.rows[0].sms_pending_kind, "reminder");
  assertEquals(w.rows[0].sms_pending_since, "2026-11-16T11:00:00.000Z");

  // The schedule keeps running; push the next reminder past 09:00 ET so only the drain decides (the D-130 hourly would otherwise
  // be the "next step" and send its own text).
  w.rows[0].next_reminder_at = "2026-11-16T14:30:00Z";
  await runAt(w, "2026-11-16T14:00:00Z"); // 09:00 ET
  assertEquals(w.twilio.length, 2);
  assert(BRAND_OK(w.twilio) && w.twilio[0].body.includes("resolve the matter"));
  assertEquals(w.rows[0].sms_pending_kind, null);
  assertEquals(w.emails.length, 1, "no extra email from the drain");
});

Deno.test("B1 a pending reminder is dropped (not sent) once a later step has fired: warning due, or next hourly due", async () => {
  // later step 1: the 8 AM warning is due at the run that would have sent the old reminder
  const a = world([failure({ sms_pending_kind: "reminder", sms_pending_since: "2026-11-16T11:00:00Z", warning_at: "2026-11-16T13:00:00Z", next_reminder_at: "2026-11-16T13:00:00Z", homeowner_notify_at: "2026-11-16T15:00:00Z" })]);
  await runAt(a, "2026-11-16T14:00:00Z"); // 09:00 ET
  assertEquals(events(a, "sms_quiet_hours_expired").length, 1);
  assert(events(a, "sms_quiet_hours_expired")[0].includes('"reason":"next_step"'));
  // the warning step itself (PASS 1, window open) sends the WARNING text, and no stale reminder text precedes it
  assertEquals(a.twilio.length, 2);
  assert(a.twilio.every((t) => t.body.includes("10 a.m. today")), "only the warning text, never the stale reminder");
  // later step 2: next hourly reminder due: it sends its own single text, not two
  const b = world([failure({ sms_pending_kind: "reminder", sms_pending_since: "2026-11-16T11:00:00Z", warning_at: "2026-11-17T13:00:00Z", next_reminder_at: "2026-11-16T12:00:00Z" })]);
  await runAt(b, "2026-11-16T14:00:00Z");
  assertEquals(b.twilio.length, 2, "one reminder text per number, not a stale one plus a fresh one");
  assertEquals(events(b, "sms_quiet_hours_expired").length, 1);
});

Deno.test("B1 expiry: a pending text older than 4 hours is dropped and logged sms_quiet_hours_expired, never sent", async () => {
  const w = world([failure({ dunning_status: "warning_sent", next_reminder_at: null, sms_pending_kind: "warning", sms_pending_since: "2026-11-16T10:00:00Z", warning_at: "2026-11-16T10:00:00Z", homeowner_notify_at: "2026-11-16T15:00:00Z" })]);
  await runAt(w, "2026-11-16T14:00:00Z"); // exactly 4h later, window open
  assertEquals(w.twilio.length, 0);
  assertEquals(events(w, "sms_quiet_hours_expired").length, 1);
  assert(events(w, "sms_quiet_hours_expired")[0].includes('"reason":"stale_4h"'));
  assertEquals(w.rows[0].sms_pending_kind, null);
  assertEquals(w.rows[0].sms_pending_since, null);
});

Deno.test("B1 expiry: a pending warning is dropped when the homeowner notice step is due", async () => {
  const w = world([failure({ dunning_status: "warning_sent", next_reminder_at: null, sms_pending_kind: "warning", sms_pending_since: "2026-11-16T13:00:00Z", warning_at: "2026-11-16T13:00:00Z", homeowner_notify_at: "2026-11-16T14:00:00Z", homeowner_id: null })]);
  await runAt(w, "2026-11-16T14:00:00Z");
  assertEquals(w.twilio.length, 0);
  assert(events(w, "sms_quiet_hours_expired")[0].includes('"reason":"next_step"'));
});

Deno.test("B1 opt-out overnight: a pending text to a number suppressed since is NOT sent; the other verified number still gets it", async () => {
  const w = world([WARNING_DUE()]);
  await runAt(w, "2026-11-16T13:00:00Z");
  assertEquals(w.rows[0].sms_pending_kind, "warning");
  // overnight (before the window opens) number n1 replies STOP: contractor_textable_numbers no longer returns it
  w.textable = w.textable.filter((t) => t.number_id !== "n1");
  await runAt(w, "2026-11-16T14:00:00Z");
  assertEquals(w.twilio.map((t) => t.to), ["+13175550102"], "only the still-textable number");
  // and when EVERY number is gone: nothing sent, marker cleared, dropped (not retried)
  const w2 = world([WARNING_DUE()]);
  await runAt(w2, "2026-11-16T13:00:00Z");
  w2.textable = [];
  await runAt(w2, "2026-11-16T14:00:00Z");
  assertEquals(w2.twilio.length, 0);
  assertEquals(w2.rows[0].sms_pending_kind, null);
  assertEquals(events(w2, "sms_quiet_hours_dropped").length, 1);
});

Deno.test("B1 a contractor with NO textable number never gets a marker (nothing to defer), and the email is unaffected", async () => {
  const w = world([WARNING_DUE()]);
  w.textable = [];
  await runAt(w, "2026-11-16T13:00:00Z");
  assertEquals(w.twilio.length, 0);
  assertEquals(w.emails.length, 1);
  assertEquals(w.rows[0].sms_pending_kind, null);
  assert(!w.patches.some((p) => "sms_pending_kind" in p), "no marker write at all");
});

Deno.test("B1 inside the window nothing is marked: a 10:00 ET warning sends immediately exactly as before", async () => {
  const w = world([failure({ warning_at: "2026-11-16T15:00:00Z", next_reminder_at: "2026-11-16T14:00:00Z", homeowner_notify_at: "2026-11-16T17:00:00Z" })]);
  await runAt(w, "2026-11-16T15:00:00Z");
  assertEquals(w.twilio.length, 2);
  assertEquals(w.rows[0].sms_pending_kind ?? null, null);
  assert(!w.patches.some((p) => "sms_pending_kind" in p), "no marker columns touched when the text goes out");
});

Deno.test("B1 the drain re-runs the payment gate: a quote paid overnight expires the pending text (never sent)", async () => {
  const w = world([WARNING_DUE()]);
  await runAt(w, "2026-11-16T13:00:00Z");
  assertEquals(w.rows[0].sms_pending_kind, "warning");
  w.quotePaid = true; // payment resolved overnight
  await runAt(w, "2026-11-16T14:00:00Z");
  assertEquals(w.twilio.length, 0);
  assert(events(w, "sms_quiet_hours_expired")[0].includes('"reason":"quote_paid_or_in_flight"'));
  assertEquals(w.rows[0].sms_pending_kind, null);
});

Deno.test("B1 the drain re-runs the pause gate: a number paused for an opt-out review gets nothing; the text stays pending until it expires", async () => {
  const w = world([WARNING_DUE()]);
  await runAt(w, "2026-11-16T13:00:00Z");
  w.paused = true; // free-text opt-out flagged overnight
  await runAt(w, "2026-11-16T14:00:00Z");
  assertEquals(w.twilio.length, 0, "the pause check in the send helper refuses every number");
  assertEquals(w.rows[0].sms_pending_kind, "warning", "not delivered, not cleared: it can only go if the pause is lifted before expiry");
  await runAt(w, "2026-11-16T15:00:00Z"); // homeowner step due (10:00 ET): the stale warning must now expire
  assertEquals(w.twilio.length, 0);
  assertEquals(w.rows[0].sms_pending_kind, null);
  assert(events(w, "sms_quiet_hours_expired").length >= 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// REVISION 3: fail-safe when the marker columns are absent; claim-before-send in the drain.
// ---------------------------------------------------------------------------------------------------------------------

Deno.test("R3 fail-safe: marker columns MISSING -> the warning state advance is retried without the marker, state advances, email never loops", async () => {
  const w = world([WARNING_DUE()]);
  w.noMarkerColumns = true;
  await runAt(w, "2026-11-16T13:00:00Z"); // 08:00 ET: text held, marker write rejected (column missing)
  assertEquals(w.rows[0].dunning_status, "warning_sent", "state MUST still advance");
  assertEquals(w.rows[0].next_reminder_at, null);
  assertEquals(w.rows[0].sms_pending_kind ?? null, null);
  assertEquals(events(w, "sms_pending_marker_unavailable").length, 1);
  assertEquals(w.emails.length, 1);
  assertEquals(w.twilio.length, 0);
  await runAt(w, "2026-11-16T13:30:00Z"); // next tick: the row is no longer 'active', so no second warning email
  await runAt(w, "2026-11-16T14:00:00Z");
  assertEquals(w.emails.length, 1, "no gh-2105 loop: the warning email is sent once");
  assertEquals(w.twilio.length, 0, "without the marker the held text is not deferred (the logged cost of a missing migration)");
});

Deno.test("R3 fail-safe: marker columns MISSING -> the hourly reminder still advances reminder_count and next_reminder_at", async () => {
  const w = world([failure({ warning_at: "2026-11-17T13:00:00Z", next_reminder_at: "2026-11-16T11:00:00Z", homeowner_notify_at: "2026-11-17T15:00:00Z" })]);
  w.noMarkerColumns = true;
  await runAt(w, "2026-11-16T11:00:00Z");
  assertEquals(w.rows[0].reminder_count, 1);
  assertEquals(w.rows[0].next_reminder_at, "2026-11-16T12:00:00.000Z");
  assertEquals(events(w, "sms_pending_marker_unavailable").length, 1);
  await runAt(w, "2026-11-16T11:30:00Z"); // not due again: no second email
  assertEquals(w.emails.length, 1);
});

Deno.test("R3 fail-safe: with the columns present the marker is written once and the unavailable path is never taken", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(/function isMissingMarkerColumn[\s\S]*?sms_pending/.test(src));
  const w = world([WARNING_DUE()]); // marker columns present: normal path writes the marker once, no unavailable log
  await runAt(w, "2026-11-16T13:00:00Z");
  assertEquals(events(w, "sms_pending_marker_unavailable").length, 0);
  assertEquals(w.rows[0].sms_pending_kind, "warning");
});

Deno.test("R3 claim-before-send: two OVERLAPPING drains send exactly once (one text per number), the loser logs sms_pending_claim_lost", async () => {
  const w = world([failure({ dunning_status: "warning_sent", next_reminder_at: null, sms_pending_kind: "warning", sms_pending_since: "2026-11-16T13:00:00.000Z", warning_at: "2026-11-16T13:00:00Z", homeowner_notify_at: "2026-11-16T15:00:00Z" })]);
  await runOverlapping(w, "2026-11-16T14:00:00Z", 2);
  assertEquals(w.twilio.map((t) => t.to).sort(), ["+13175550101", "+13175550102"], "exactly one text per number across both runs");
  assertEquals(events(w, "sms_pending_claim_lost").length, 1, "the second run reached the claim and lost it");
  assertEquals(w.rows[0].sms_pending_kind, null);
  // three-way overlap: still exactly once
  const w3 = world([failure({ dunning_status: "warning_sent", next_reminder_at: null, sms_pending_kind: "warning", sms_pending_since: "2026-11-16T13:00:00.000Z", warning_at: "2026-11-16T13:00:00Z", homeowner_notify_at: "2026-11-16T15:00:00Z" })]);
  await runOverlapping(w3, "2026-11-16T14:00:00Z", 3);
  assertEquals(w3.twilio.length, 2);
  assertEquals(events(w3, "sms_pending_claim_lost").length, 2);
});

Deno.test("R3 failed send: the claimed text is re-marked exactly once (original timestamp), then sent by a later run", async () => {
  const w = world([failure({ dunning_status: "warning_sent", next_reminder_at: null, sms_pending_kind: "warning", sms_pending_since: "2026-11-16T13:00:00.000Z", warning_at: "2026-11-16T13:00:00Z", homeowner_notify_at: "2026-11-16T15:00:00Z" })]);
  w.twilioFail = true;
  await runAt(w, "2026-11-16T14:00:00Z");
  assertEquals(w.twilio.length, 2, "both numbers attempted, both failed");
  assertEquals(events(w, "sms_pending_remarked").length, 1, "exactly one re-mark");
  assertEquals(w.rows[0].sms_pending_kind, "warning");
  assertEquals(w.rows[0].sms_pending_since, "2026-11-16T13:00:00.000Z", "the 4-hour clock is not extended");
  assertEquals(w.patches.filter((p) => p.sms_pending_kind === "warning").length, 1);
  w.twilioFail = false; w.twilio.length = 0;
  await runAt(w, "2026-11-16T14:30:00Z");
  assertEquals(w.twilio.length, 2, "the next run delivers it");
  assertEquals(w.rows[0].sms_pending_kind, null);
});

Deno.test("R3 failed send past expiry: NOT re-marked; dropped and logged sms_quiet_hours_expired (send_failed_stale_4h)", async () => {
  // pending since 10:03Z: at the 14:00Z run it is 3h57m old (alive); the send fails and takes the clock to 14:04Z (4h01m): too old to re-mark.
  const w = world([failure({ dunning_status: "warning_sent", next_reminder_at: null, sms_pending_kind: "warning", sms_pending_since: "2026-11-16T10:03:00.000Z", warning_at: "2026-11-16T10:03:00Z", homeowner_notify_at: "2026-11-16T15:00:00Z" })]);
  w.twilioFail = true;
  w.onTwilioFail = () => { setNow("2026-11-16T14:04:00Z"); };
  await runAt(w, "2026-11-16T14:00:00Z");
  assertEquals(w.rows[0].sms_pending_kind, null);
  assertEquals(events(w, "sms_pending_remarked").length, 0);
  const ex = events(w, "sms_quiet_hours_expired");
  assertEquals(ex.length, 1);
  assert(ex[0].includes('"reason":"send_failed_stale_4h"'));
});

Deno.test("R3 the claim is conditional on the marker seen: a newer marker set meanwhile is never clobbered by the clear/re-mark", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const raw = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const drain = raw.slice(raw.indexOf("async function drainPendingDunningSms"), raw.indexOf("// MESSAGE TEXT"));
  assertEquals((drain.match(/\.eq\("sms_pending_kind", seenKind\)\s*\.eq\("sms_pending_since", seenSince\)/g) ?? []).length, 2, "clear and claim are both conditional on kind + since");
  assert(/\.is\("sms_pending_kind", null\)/.test(drain), "the re-mark only fills an empty marker");
  assert(drain.indexOf("sms_pending_claim_lost") < drain.indexOf("sendSMSToAll("), "the claim is won BEFORE any send");
});
