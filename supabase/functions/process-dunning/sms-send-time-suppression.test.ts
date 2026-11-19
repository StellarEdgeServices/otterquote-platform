// gh-3773 (SMS hardening follow-up to the #3772 review, item 4): process-dunning checks the suppression list AT SEND TIME, with
// the same shared guard send-sms uses (_shared/sms-suppression.ts), not only when the recipient list is built. A number that is
// on contractor_textable_numbers() when the list is read but suppressed by the time of the Twilio call is not texted.
// Drives the real exported handler (CRON mode): stateful PostgREST fake, controllable clock, fetch + Deno.env stubbed.
// Harness copied from sms-quiet-pending.test.ts (2026-11-16 is a Monday, EST).
// Run: deno test --allow-read=supabase/functions supabase/functions/process-dunning/sms-send-time-suppression.test.ts
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
interface World { rows: Row[]; textable: Array<{ number_id: string; phone_e164: string; is_primary: boolean }>; twilio: Sent[]; emails: Array<{ at: string; subject: string }>; logs: string[]; patches: Row[]; quotePaid: boolean; paused: boolean; suppressed: string[]; suppressionError: boolean; noMarkerColumns: boolean; twilioFail: boolean; onTwilioFail?: () => void }
const TEXTABLE2 = () => [
  { number_id: "n1", phone_e164: "+13175550101", is_primary: true },
  { number_id: "n2", phone_e164: "+13175550102", is_primary: false },
];
function world(rows: Row[]): World { return { rows, textable: TEXTABLE2(), twilio: [], emails: [], logs: [], patches: [], quotePaid: false, paused: false, suppressed: [], suppressionError: false, noMarkerColumns: false, twilioFail: false }; }

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
    if (table === "sms_suppression_list" && req.method === "GET") {
      // gh-3773: the send-time guard keys on the E.164 number with released_at null. Answer an open row for a suppressed number.
      if (w.suppressionError) return new Response(JSON.stringify({ code: "XX000", message: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } });
      const ph = (q.get("phone_e164") ?? "").replace("eq.", "");
      return json(w.suppressed.includes(ph) && q.get("released_at") === "is.null" ? [{ id: "sup1" }] : []);
    }
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
// 10:00 ET = 15:00Z: window open, the 8 AM warning text goes out immediately to every textable number.
const WARNING_OPEN = () => failure({ warning_at: "2026-11-16T15:00:00Z", next_reminder_at: "2026-11-16T14:00:00Z", homeowner_notify_at: "2026-11-16T17:00:00Z" });
const RUN_AT = "2026-11-16T15:00:00Z";

Deno.test("NEGATIVE CONTROL: a number suppressed after the textable list was read is NOT texted; the other number still is; the refusal is logged with last 4 only", async () => {
  const w = world([WARNING_OPEN()]);
  w.suppressed = ["+13175550101"]; // still returned by contractor_textable_numbers() in this fixture (list read earlier), but now has an open suppression row
  await runAt(w, RUN_AT);
  assertEquals(w.twilio.map((t) => t.to), ["+13175550102"], "only the unsuppressed number is texted");
  assert(BRAND_OK(w.twilio));
  const refused = w.logs.filter((l) => l.includes("number_suppressed"));
  assertEquals(refused.length, 1);
  assert(refused[0].includes("process-dunning") && refused[0].includes("to_last4=0101"), refused[0]);
  assert(!w.logs.some((l) => l.includes("+13175550101") || l.includes("13175550101") || l.includes("3175550101")), "no full number in any log line");
});

Deno.test("NEGATIVE CONTROL: when EVERY textable number is suppressed at send time, zero Twilio calls", async () => {
  const w = world([WARNING_OPEN()]);
  w.suppressed = ["+13175550101", "+13175550102"];
  await runAt(w, RUN_AT);
  assertEquals(w.twilio.length, 0);
  assertEquals(w.logs.filter((l) => l.includes("number_suppressed")).length, 2);
});

Deno.test("fail closed: a suppression-list lookup error refuses the send (suppression_lookup_failed), zero Twilio calls", async () => {
  const w = world([WARNING_OPEN()]);
  w.suppressionError = true;
  await runAt(w, RUN_AT);
  assertEquals(w.twilio.length, 0);
  assert(w.logs.some((l) => l.includes("suppression_lookup_failed")));
});

Deno.test("no regression: with nobody suppressed both verified numbers are texted exactly as before", async () => {
  const w = world([WARNING_OPEN()]);
  await runAt(w, RUN_AT);
  assertEquals(w.twilio.map((t) => t.to).sort(), ["+13175550101", "+13175550102"]);
  assertEquals(w.logs.filter((l) => l.includes("number_suppressed")).length, 0);
});

Deno.test("process-dunning/index.ts calls the SHARED guard (smsSuppressionRefusal from _shared/sms-suppression.ts) after the pause check and before the Twilio POST; no local copy of the lookup", async () => {
  const s = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(s.includes('import { smsSuppressionRefusal } from "../_shared/sms-suppression.ts"'));
  const pause = s.indexOf("await isSmsPaused(guardClient, to)");
  const supp = s.indexOf("await smsSuppressionRefusal(guardClient, to");
  const post = s.indexOf("https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json");
  assert(pause > 0 && supp > pause && post > supp, "order: pause < suppression < Twilio POST");
  assert(!s.includes('from("sms_suppression_list")'), "the lookup lives only in the shared helper");
});
