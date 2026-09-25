// gh-2107 / D-330 -- Ben's follow-up on #2078 (5807572209, item restated in wave 6, 5807951735): "add a ~5 s AbortController on the
// notify-measurement-order call in the usdOnly() 402 path, with a hung-fetch test that still returns 402. Required before the deploy gate
// opens." The alert is awaited BEFORE the 402 is returned (an edge function can be stopped once it responds), so a hung mail call must not
// hold the buyer's response open indefinitely. Two bounds: the fetch itself aborts at 5 s, and the whole alert has a deadline just above it.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  NON_USD_ALERT_DEADLINE_MS,
  NON_USD_ALERT_SEND_TIMEOUT_MS,
  postAdminAlertEmail,
  raiseNonUsdPaymentAlert,
  type NonUsdAlertDeps,
} from "./non-usd-alert.ts";
import type { NonUsdRejection } from "./payment-intent-checks.ts";

const N: NonUsdRejection = { paymentIntentId: "pi_3Abc123", currency: "jpy", amountCents: 1500 };
const BODY = { alert: "non_usd_payment_rejected" as const, flow: "report" as const, payment_intent_id: "pi_3Abc123", currency: "jpy", amount_minor: 1500 };

Deno.test("timeout: the send timeout is about 5 s and the overall deadline is just above it", () => {
  assertEquals(NON_USD_ALERT_SEND_TIMEOUT_MS, 5000);
  assert(NON_USD_ALERT_DEADLINE_MS > NON_USD_ALERT_SEND_TIMEOUT_MS && NON_USD_ALERT_DEADLINE_MS <= 8000);
});

// -- postAdminAlertEmail: the AbortController ---------------------------------------------------------------
Deno.test("post: the request is sent with the service-role bearer, a JSON body, and an AbortSignal", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = ((url: string, init: RequestInit) => { seen = { url, init }; return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
  await postAdminAlertEmail({ fetchImpl, supabaseUrl: "https://x.supabase.co", serviceKey: "SVC", body: BODY, timeoutMs: 50 });
  assert(seen !== null);
  const s = seen as { url: string; init: RequestInit };
  assertEquals(s.url, "https://x.supabase.co/functions/v1/notify-measurement-order");
  assertEquals((s.init.headers as Record<string, string>).Authorization, "Bearer SVC");
  assertEquals(JSON.parse(String(s.init.body)), BODY);
  assert(s.init.signal instanceof AbortSignal, "an AbortSignal is passed to fetch");
});

Deno.test("post: a HUNG fetch is aborted at the timeout and rejects (fixed message, no raw text)", async () => {
  let aborted = false;
  const hung = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
    (init.signal as AbortSignal).addEventListener("abort", () => { aborted = true; rej(new DOMException("SECRET abort detail", "AbortError")); });
  })) as unknown as typeof fetch;
  const t0 = Date.now();
  let msg = "";
  try {
    await postAdminAlertEmail({ fetchImpl: hung, supabaseUrl: "https://x.supabase.co", serviceKey: "SVC", body: BODY, timeoutMs: 40 });
  } catch (e) { msg = String((e as Error).message); }
  assert(aborted, "the signal fired");
  assert(Date.now() - t0 < 1000, "returned promptly after the timeout");
  assert(msg.length > 0 && !msg.includes("SECRET"), "rejects with a fixed message: " + msg);
});

/** Runs `fn` while tracking timers created and not cleared through the global setTimeout / clearTimeout. Returns the count still pending. */
async function pendingTimersAfter(fn: () => Promise<unknown>): Promise<number> {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  globalThis.setTimeout = ((h: () => void, ms?: number) => {
    const id = realSet(() => { live.delete(id); h(); }, ms);
    live.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => { live.delete(id); realClear(id); }) as typeof clearTimeout;
  try {
    await fn();
    return live.size;
  } finally {
    for (const id of live) realClear(id as number);
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

Deno.test("timers: a fast fetch leaves NO timer pending (the abort timer is cleared)", async () => {
  const fetchImpl = (() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;
  const pending = await pendingTimersAfter(() => postAdminAlertEmail({ fetchImpl, supabaseUrl: "https://x.supabase.co", serviceKey: "SVC", body: BODY, timeoutMs: 60_000 }));
  assertEquals(pending, 0);
});

Deno.test("timers: a fast alert leaves NO timer pending (the deadline timer is cleared)", async () => {
  const { d } = deps();
  const pending = await pendingTimersAfter(() => raiseNonUsdPaymentAlert(d, N, "report", () => new Date(), 60_000));
  assertEquals(pending, 0);
});

Deno.test("post: a fast fetch is NOT aborted and its timer is cleared (no leak)", async () => {
  const fetchImpl = (() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;
  await postAdminAlertEmail({ fetchImpl, supabaseUrl: "https://x.supabase.co", serviceKey: "SVC", body: BODY, timeoutMs: 60_000 });
  // Deno's test sanitizer fails this test if the 60 s timer were left running.
});

Deno.test("post: a non-ok response rejects (unchanged behaviour)", async () => {
  const fetchImpl = (() => Promise.resolve(new Response("nope", { status: 502 }))) as unknown as typeof fetch;
  let threw = false;
  try { await postAdminAlertEmail({ fetchImpl, supabaseUrl: "https://x.supabase.co", serviceKey: "SVC", body: BODY, timeoutMs: 50 }); } catch { threw = true; }
  assert(threw);
});

// -- raiseNonUsdPaymentAlert: the overall deadline ----------------------------------------------------------
function deps(over: Partial<NonUsdAlertDeps> = {}) {
  const rows: unknown[] = [];
  const logs: string[] = [];
  const d: NonUsdAlertDeps = {
    alreadyAlerted: async () => false,
    insertAlert: async (row) => { rows.push(row); return { error: null }; },
    sendAdminEmail: async () => {},
    log: (m) => logs.push(m),
    ...over,
  };
  return { d, rows, logs };
}
const NEVER = () => new Promise<never>(() => {});

Deno.test("deadline: a mail call that never returns does NOT hold the caller open past the deadline, and the row was still written", async () => {
  const { d, rows, logs } = deps({ sendAdminEmail: NEVER });
  const t0 = Date.now();
  await raiseNonUsdPaymentAlert(d, N, "report", () => new Date(), 60);
  assert(Date.now() - t0 < 1000, "returned at the deadline, not never");
  assertEquals(rows.length, 1, "the alert row is written before the mail call");
  assert(logs.some((l) => l.includes("deadline")), "a fixed log line says the deadline was hit");
});

Deno.test("deadline: a hung dedupe lookup or row insert is bounded too, and never throws", async () => {
  for (const over of [{ alreadyAlerted: NEVER }, { insertAlert: NEVER }] as Partial<NonUsdAlertDeps>[]) {
    const { d } = deps(over);
    const t0 = Date.now();
    await raiseNonUsdPaymentAlert(d, N, "upgrade", () => new Date(), 60);
    assert(Date.now() - t0 < 1000);
  }
});

Deno.test("deadline: NEGATIVE CONTROL -- a fast alert completes normally, sends the email once, and logs no deadline", async () => {
  const sent: unknown[] = [];
  const { d, rows, logs } = deps({ sendAdminEmail: async (b) => { sent.push(b); } });
  await raiseNonUsdPaymentAlert(d, N, "report", () => new Date(), 60_000);
  assertEquals(rows.length, 1);
  assertEquals(sent.length, 1);
  assert(!logs.some((l) => l.includes("deadline")));
});

Deno.test("deadline: the deadline log carries fixed text only (no PaymentIntent, currency or amount)", async () => {
  const { d, logs } = deps({ sendAdminEmail: NEVER });
  await raiseNonUsdPaymentAlert(d, N, "report", () => new Date(), 40);
  for (const l of logs) assert(!/pi_|jpy|1500|@/.test(l), l);
});

// -- the 402: a caller awaiting the alert still gets its answer -----------------------------------------------
Deno.test("402 path: awaiting the alert with a hung mail call still lets the caller return its 402 within the deadline", async () => {
  const { d } = deps({ sendAdminEmail: NEVER });
  const respond = async () => {
    await raiseNonUsdPaymentAlert(d, N, "report", () => new Date(), 60);
    return { status: 402 };
  };
  const t0 = Date.now();
  const res = await respond();
  assertEquals(res.status, 402);
  assert(Date.now() - t0 < 1000);
});

// -- structure: index.ts uses the bounded sender and the default deadline ---------------------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("index.ts: the real sendAdminEmail goes through postAdminAlertEmail with the send timeout (no bare fetch to notify-measurement-order in the alert path)", () => {
  const at = index.indexOf("sendAdminEmail: (body) =>");
  assert(at > 0);
  const block = index.slice(at, index.indexOf("log: (m) => console.error(m)", at));
  assert(block.includes("postAdminAlertEmail("), "uses the bounded sender: " + block);
  assert(!block.includes("await fetch("), "no bare fetch");
  assert(/timeoutMs:\s*NON_USD_ALERT_SEND_TIMEOUT_MS/.test(block), "the 5 s constant");
});

Deno.test("index.ts: both alert call sites still await raiseNonUsdPaymentAlert before returning the 402 (unchanged)", () => {
  assertEquals(index.split("await raiseNonUsdPaymentAlert(").length - 1, 2);
});
