// gh-3356: the two operator alerts of the paid-claim gate reach a person (a platform_alerts_log row AND an admin email through
// notify-measurement-order), bounded per claim so a retry loop cannot flood it; the table columns are checked against the migrations.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildPaidGateAlertRow,
  makePaidAlertDbDeps,
  PAID_GATE_ALERT_TOKEN,
  PAID_GATE_ALERT_TYPES,
  PAID_GATE_ALERT_WINDOW_MS,
  type PaidAlertDeps,
  type PaidGateAlertEmailBody,
  type PaidGateAlertKind,
  postPaidGateAlertEmail,
  raisePaidGateAlert,
} from "./measurement-paid-alert.ts";
import { buildPaidGateAlertEmail } from "../notify-measurement-order/measurement-paid-gate-alert-email.ts";
import { fakeSupabase, type Row, tableColumns } from "./paid-gate-test-support.ts";

const CLAIM = "c0ffee00-0000-4000-8000-000000000001";
const CLAIM_2 = "c0ffee00-0000-4000-8000-000000000002";
const SCHEMA = { platform_alerts_log: await tableColumns("platform_alerts_log") };
const T0 = new Date("2026-11-03T12:00:00Z");

function world(over: { lookupThrows?: boolean; emailFails?: boolean } = {}) {
  const tables: Record<string, Row[]> = { platform_alerts_log: [] };
  const sb = fakeSupabase(SCHEMA, tables);
  const emails: PaidGateAlertEmailBody[] = [];
  const logs: string[] = [];
  const db = makePaidAlertDbDeps(sb);
  const deps: PaidAlertDeps = {
    recentlyAlerted: over.lookupThrows ? () => Promise.reject(new Error("db down")) : db.recentlyAlerted,
    insertAlert: db.insertAlert,
    sendAdminEmail: async (b) => { if (over.emailFails) throw new Error("mail down"); emails.push(b); },
    log: (m) => logs.push(m),
  };
  return { tables, emails, logs, deps, rows: () => tables.platform_alerts_log };
}
const A = (kind: PaidGateAlertKind, claimId = CLAIM) => ({ kind, claimId, paymentIntentId: "pi_3Abc", stage: "before create", reason: "Stripe search answered HTTP 500" });

Deno.test("alert: paid_without_order writes ONE row and sends ONE admin email", async () => {
  const w = world();
  assertEquals(await raisePaidGateAlert(w.deps, A("paid_without_order"), () => T0), true);
  assertEquals(w.rows().length, 1);
  assertEquals(w.rows()[0].alert_type, "measurement_paid_without_order");
  assertEquals(w.rows()[0].function_name, "create-payment-intent");
  assert(String(w.rows()[0].message).includes(CLAIM) && String(w.rows()[0].message).includes("pi_3Abc"));
  assertEquals(w.emails, [{ alert: PAID_GATE_ALERT_TOKEN, kind: "paid_without_order", claim_id: CLAIM, payment_intent_id: "pi_3Abc", stage: "before create" }]);
});

Deno.test("alert: BOUNDED per claim: 50 retries inside the window send one row and one email; another claim, another alert type and a later window each alert again", async () => {
  const w = world();
  for (let i = 0; i < 50; i++) await raisePaidGateAlert(w.deps, A("check_unavailable"), () => new Date(T0.getTime() + i * 1000));
  assertEquals([w.rows().length, w.emails.length], [1, 1]);
  await raisePaidGateAlert(w.deps, A("check_unavailable", CLAIM_2), () => T0);
  assertEquals(w.emails.length, 2, "a different claim is its own bound");
  await raisePaidGateAlert(w.deps, A("paid_without_order"), () => T0);
  assertEquals(w.emails.length, 3, "a different alert type for the same claim is its own bound");
  const later = new Date(T0.getTime() + PAID_GATE_ALERT_WINDOW_MS.check_unavailable + 60_000);
  await raisePaidGateAlert(w.deps, A("check_unavailable"), () => later);
  assertEquals(w.emails.length, 4, "after the 1 h window the same claim alerts again");
  assertEquals(PAID_GATE_ALERT_WINDOW_MS.paid_without_order, 24 * 3600 * 1000);
});

Deno.test("NEGATIVE CONTROL (alert bound): with the per-claim lookup removed the same 50 retries send 50 emails", async () => {
  const w = world();
  const unbounded: PaidAlertDeps = { ...w.deps, recentlyAlerted: async () => false };
  for (let i = 0; i < 50; i++) await raisePaidGateAlert(unbounded, A("check_unavailable"), () => new Date(T0.getTime() + i * 1000));
  assertEquals(w.emails.length, 50);
});

Deno.test("alert: a failed bound lookup alerts (row + email) for paid_without_order, and writes the row only for check_unavailable", async () => {
  const a = world({ lookupThrows: true });
  await raisePaidGateAlert(a.deps, A("paid_without_order"), () => T0);
  assertEquals([a.rows().length, a.emails.length], [1, 1]);
  const b = world({ lookupThrows: true });
  await raisePaidGateAlert(b.deps, A("check_unavailable"), () => T0);
  assertEquals([b.rows().length, b.emails.length], [1, 0]);
});

Deno.test("alert: a failing email never throws and the row is still there; a hung email is cut by the deadline", async () => {
  const w = world({ emailFails: true });
  assertEquals(await raisePaidGateAlert(w.deps, A("paid_without_order"), () => T0), true);
  assertEquals(w.rows().length, 1);
  assert(w.logs.some((l) => l.includes("email failed")) && w.logs.every((l) => !l.includes("mail down")), "fixed text only");
  const hung = world();
  const slow: PaidAlertDeps = { ...hung.deps, sendAdminEmail: () => new Promise(() => {}) };
  const t0 = Date.now();
  assertEquals(await raisePaidGateAlert(slow, A("paid_without_order"), () => T0, 40), false);
  assert(Date.now() - t0 < 500);
});

Deno.test("alert: the mail call to notify-measurement-order is aborted at its timeout and uses the service-role bearer", async () => {
  let seen: { url: string; auth: string | null; body: string } | null = null;
  await postPaidGateAlertEmail({
    fetchImpl: ((url: string, init: RequestInit) => { seen = { url, auth: (init.headers as Record<string, string>).Authorization, body: String(init.body) }; return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch,
    supabaseUrl: "https://x.supabase.co", serviceKey: "SVC", timeoutMs: 50,
    body: { alert: PAID_GATE_ALERT_TOKEN, kind: "paid_without_order", claim_id: CLAIM, payment_intent_id: null, stage: "before create" },
  });
  assertEquals(seen!.url, "https://x.supabase.co/functions/v1/notify-measurement-order");
  assertEquals(seen!.auth, "Bearer SVC");
  let msg = "";
  try {
    await postPaidGateAlertEmail({
      fetchImpl: ((_u: string, init: RequestInit) => new Promise((_r, rej) => (init.signal as AbortSignal).addEventListener("abort", () => rej(new DOMException("a", "AbortError"))))) as unknown as typeof fetch,
      supabaseUrl: "https://x.supabase.co", serviceKey: "SVC", timeoutMs: 20,
      body: { alert: PAID_GATE_ALERT_TOKEN, kind: "check_unavailable", claim_id: CLAIM, payment_intent_id: null, stage: "x" },
    });
  } catch (e) { msg = (e as Error).message; }
  assertEquals(msg, "notify-measurement-order did not answer in time");
});

Deno.test("alert: an invalid claim id raises nothing", async () => {
  const w = world();
  assertEquals(await raisePaidGateAlert(w.deps, { ...A("paid_without_order"), claimId: "x'; drop" }, () => T0), false);
  assertEquals([w.rows().length, w.emails.length], [0, 0]);
});

// ── columns, checked against the migrations ───────────────────────────────────────────────────────────────────────────────────
Deno.test("alert columns: every column the row, the insert and the bound lookup name exists on platform_alerts_log (derived from the migrations)", async () => {
  for (const k of Object.keys(buildPaidGateAlertRow(A("paid_without_order")))) assert(SCHEMA.platform_alerts_log.has(k), `no column ${k}`);
  const w = world();
  await raisePaidGateAlert(w.deps, A("paid_without_order"), () => T0);
  assertEquals(w.rows().length, 1, "the insert and the lookup were accepted by the column-checking client");
  const src = await Deno.readTextFile(new URL("./measurement-paid-alert.ts", import.meta.url));
  for (const m of src.matchAll(/\.(?:eq|ilike|gte)\("([a-z_]+)"/g)) assert(SCHEMA.platform_alerts_log.has(m[1]), `lookup column ${m[1]}`);
  for (const m of src.matchAll(/\.select\("([a-z_, ]+)"\)/g)) for (const c of m[1].split(",")) assert(SCHEMA.platform_alerts_log.has(c.trim()), `select column ${c}`);
});

Deno.test("NEGATIVE CONTROL (alert columns): a misspelled column in the insert or the lookup is an error the client reports (the mutation a reviewer made), so a row would never be written", async () => {
  const sb = fakeSupabase(SCHEMA, { platform_alerts_log: [] });
  const ins = await sb.from("platform_alerts_log").insert({ alert_type: "x", function_name: "y", message: "m", sentat: "2026-01-01" });
  assertEquals((ins as unknown as { error: { code: string } }).error.code, "42703");
  const look = await sb.from("platform_alerts_log").select("id").eq("alert_typ", "x").gte("sent_at", "x").limit(1);
  assertEquals((look as unknown as { error: { code: string } }).error.code, "42703");
  // and through the real helper the insert error is reported, not swallowed silently as success
  const w = world();
  const badDeps: PaidAlertDeps = { ...w.deps, insertAlert: (row) => sb.from("platform_alerts_log").insert({ ...row, sentat: row.sent_at }) as unknown as PromiseLike<{ error?: unknown }> };
  await raisePaidGateAlert(badDeps, A("paid_without_order"), () => T0);
  assert(w.logs.some((l) => l.includes("alert row insert failed")), "the failure is logged");
  assertEquals(sb.calls.filter((c) => c.op === "insert").length >= 1, true);
});

// ── the receiving side and the contract between the two ────────────────────────────────────────────────────────────────────────
Deno.test("parity: the sender's token, kinds and body keys are the ones notify-measurement-order accepts, and the email builds for each kind", async () => {
  const recv = await Deno.readTextFile(new URL("../notify-measurement-order/measurement-paid-gate-alert-email.ts", import.meta.url));
  assert(recv.includes(`PAID_GATE_ALERT_TOKEN = "${PAID_GATE_ALERT_TOKEN}"`));
  for (const kind of Object.keys(PAID_GATE_ALERT_TYPES)) assert(recv.includes(`"${kind}"`), kind);
  for (const key of ["alert", "kind", "claim_id", "payment_intent_id", "stage"]) assert(recv.includes(`body.${key}`) || recv.includes(`"${key}"`), key);
  for (const kind of ["paid_without_order", "check_unavailable"] as const) {
    const body: PaidGateAlertEmailBody = { alert: PAID_GATE_ALERT_TOKEN, kind, claim_id: CLAIM, payment_intent_id: "pi_3Abc", stage: "before create" };
    const e = buildPaidGateAlertEmail(body);
    assert(e && e.subject.length > 10 && e.text.includes(CLAIM), kind);
  }
});

Deno.test("index.ts: both refusal sites raise the alert through raisePaidGateAlert, with the service-role key, and the old direct insert is gone", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes("await logPaidGateRefusal(supabase, supabaseUrl, supabaseKey, paidVerdict,"));
  assert(src.includes("await logPaidGateRefusal(supabase, supabaseUrl, supabaseKey, replayVerdict,"));
  assert(src.includes("await raisePaidGateAlert("));
  assert(src.includes("postPaidGateAlertEmail({ fetchImpl: fetch, supabaseUrl, serviceKey, body, timeoutMs: PAID_GATE_ALERT_SEND_TIMEOUT_MS })"));
  assert(!src.includes('alertType = "measurement_paid_without_order"'), "no second, unbounded insert path");
});
