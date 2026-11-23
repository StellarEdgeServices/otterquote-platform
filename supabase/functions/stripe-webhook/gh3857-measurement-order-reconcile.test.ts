// gh-3857: unit tests for reconcileMeasurementPaymentOrder (no network; every dependency is injected) and a parity pin to
// notify-measurement-order's alert email builder (this file keeps its own copy of the token and body keys).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  PAID_GATE_ALERT_TOKEN,
  RECONCILE_STAGE,
  RECONCILE_WAIT_MS,
  measurementChargeEnabled,
  reconcileMeasurementPaymentOrder,
  scheduleOffResponsePath,
  type ReconcileDeps,
} from "./measurement-order-reconcile.ts";
import { buildPaidGateAlertEmail, PAID_GATE_ALERT_TOKEN as NOTIFY_TOKEN } from "../notify-measurement-order/measurement-paid-gate-alert-email.ts";

const PI = "pi_3Unit3857";
const CLAIM = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const pi = (over: Record<string, unknown> = {}) => ({ id: PI, status: "succeeded", metadata: { type: "hover_measurement", claim_id: CLAIM }, ...over });

function deps(over: Partial<ReconcileDeps> & { orderAppearsOnRead?: number } = {}) {
  const calls = { reads: 0, sleeps: [] as number[], rows: [] as unknown[], emails: [] as unknown[] };
  const d: ReconcileDeps = {
    orderExists: async () => { calls.reads++; return over.orderAppearsOnRead !== undefined && calls.reads >= over.orderAppearsOnRead; },
    recentlyAlerted: async () => false,
    insertAlert: async (row) => { calls.rows.push(row); },
    sendAdminEmail: async (b) => { calls.emails.push(b); },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    now: () => new Date("2026-11-23T00:00:00Z"),
    log: () => {},
    ...over,
  };
  return { d, calls };
}

Deno.test("an order that appears on a later read inside the wait is recorded: no alert", async () => {
  const { d, calls } = deps({ orderAppearsOnRead: 3 });
  assertEquals(await reconcileMeasurementPaymentOrder(pi(), d, "stripe-webhook"), "recorded");
  assertEquals(calls.reads, 3);
  assertEquals(calls.rows, []);
  assertEquals(calls.emails, []);
});

Deno.test("no order after the whole wait: one alert row naming the PaymentIntent and one email; the wait is bounded", async () => {
  const { d, calls } = deps();
  assertEquals(await reconcileMeasurementPaymentOrder(pi(), d, "stripe-webhook"), "alerted");
  assertEquals(calls.sleeps, [...RECONCILE_WAIT_MS]);
  assert(RECONCILE_WAIT_MS.reduce((a, b) => a + b, 0) <= 10_000);
  assertEquals(calls.rows.length, 1);
  assert(String((calls.rows[0] as { message: string }).message).includes(PI));
  assertEquals(calls.emails, [{ alert: PAID_GATE_ALERT_TOKEN, kind: "paid_without_order", claim_id: CLAIM, payment_intent_id: PI, stage: RECONCILE_STAGE }]);
});

Deno.test("an order read that keeps failing is not treated as a found order: it alerts (fail toward telling)", async () => {
  const { d, calls } = deps({ orderExists: async () => { throw new Error("db down"); } });
  assertEquals(await reconcileMeasurementPaymentOrder(pi(), d, "stripe-webhook"), "alerted");
  assertEquals(calls.rows.length, 1);
});

Deno.test("already alerted inside the window: duplicate, nothing written", async () => {
  const { d, calls } = deps({ recentlyAlerted: async () => true });
  assertEquals(await reconcileMeasurementPaymentOrder(pi(), d, "stripe-webhook"), "duplicate");
  assertEquals(calls.rows, []);
  assertEquals(calls.emails, []);
});

Deno.test("out of scope: another PaymentIntent type, an unsucceeded status or an unreadable id is ignored with no database read", async () => {
  for (const p of [pi({ metadata: { type: "platform_fee", claim_id: CLAIM } }), pi({ status: "processing" }), pi({ id: "not-a-pi" }), pi({ metadata: null })]) {
    const { d, calls } = deps();
    assertEquals(await reconcileMeasurementPaymentOrder(p, d, "stripe-webhook"), "ignored");
    assertEquals(calls.reads, 0);
  }
});

Deno.test("an unreadable claim id still alerts by row (the row names the PaymentIntent) and skips only the email", async () => {
  const { d, calls } = deps();
  assertEquals(await reconcileMeasurementPaymentOrder(pi({ metadata: { type: "hover_measurement", claim_id: "x" } }), d, "stripe-webhook"), "alerted");
  assertEquals(calls.rows.length, 1);
  assertEquals(calls.emails, []);
});

Deno.test("parity: the token, kind and stage are the ones notify-measurement-order accepts, and its email builds", () => {
  assertEquals(PAID_GATE_ALERT_TOKEN, NOTIFY_TOKEN);
  const email = buildPaidGateAlertEmail({ alert: PAID_GATE_ALERT_TOKEN, kind: "paid_without_order", claim_id: CLAIM, payment_intent_id: PI, stage: RECONCILE_STAGE });
  assert(email !== null);
  assert(email!.text.includes(PI) && email!.text.includes(RECONCILE_STAGE));
});

Deno.test("flag: MEASUREMENT_CHARGE_ENABLED is on only when exactly \"true\"", () => {
  const on = (v: string | undefined) => measurementChargeEnabled((k) => (k === "MEASUREMENT_CHARGE_ENABLED" ? v : undefined));
  assertEquals(on("true"), true);
  for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) assertEquals(on(v), false, String(v));
});

Deno.test("scheduleOffResponsePath: with waitUntil it returns before the task finishes and hands the task to waitUntil", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let finished = false;
  const registered: Promise<unknown>[] = [];
  const mode = await scheduleOffResponsePath(async () => { await gate; finished = true; }, { waitUntil: (p) => { registered.push(p); } }, () => {});
  assertEquals(mode, "background");
  assertEquals(finished, false, "the caller must not wait for the task");
  assertEquals(registered.length, 1);
  release();
  await registered[0];
  assertEquals(finished, true);
});

Deno.test("scheduleOffResponsePath: without waitUntil the task is awaited; a throwing task is logged and never rejects", async () => {
  let ran = false;
  assertEquals(await scheduleOffResponsePath(async () => { ran = true; }, undefined, () => {}), "inline");
  assertEquals(ran, true);
  const logs: string[] = [];
  assertEquals(await scheduleOffResponsePath(async () => { throw new Error("boom"); }, undefined, (m) => logs.push(m)), "inline");
  assert(logs.length === 1 && logs[0].includes("gh-3857"));
  const bgLogs: string[] = [];
  let reg!: Promise<unknown>;
  await scheduleOffResponsePath(async () => { throw new Error("boom"); }, { waitUntil: (p) => { reg = p; } }, (m) => bgLogs.push(m));
  await reg; // resolves, does not reject
  assertEquals(bgLogs.length, 1);
});
