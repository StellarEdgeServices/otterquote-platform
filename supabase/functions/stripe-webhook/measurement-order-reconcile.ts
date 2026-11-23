// gh-3857 (Refs #3857, residual of #3356): a measurement PaymentIntent that SUCCEEDED always ends with a recorded order or an alert that names it.
//
// WHY. The homeowner's $22.63 measurement charge is two browser requests: Stripe confirms the card, then the browser calls
// create-measurement-order to write the hover_orders row. If the second request never arrives or fails, a paid PaymentIntent has
// no order row and nothing is queued for fulfilment (and, before this, nothing told anyone). This runs on Stripe's own
// payment_intent.succeeded event, which does not depend on the browser.
//
// WHAT IT DOES (reconcile, not re-create). It looks for a hover_orders row carrying the PaymentIntent id
// (homeowner_stripe_payment_intent_id), waiting a bounded few seconds because on a normal purchase the browser's order request lands
// moments after the event. Found: nothing to do (so a normal success writes nothing and creates no second row). Not found: one
// internal alert naming the PaymentIntent and the claim, through the two channels already used for the paid-claim gate (#3356):
// a platform_alerts_log row (alert_type measurement_paid_without_order) and the admin email through notify-measurement-order's `alert`
// mode. It writes no order itself: the order row carries the guarantee clock, the covered-state, the buyer role and the fee
// bookkeeping that create-measurement-order decides, hover_orders has no unique key on the PaymentIntent id (a webhook writer
// racing the browser could make a second row), and a person decides each case. It moves no money and changes no charge, refund or
// customer-visible text.
//
// BOUNDED. One alert per PaymentIntent per 24 h (a Stripe redelivery cannot flood the inbox; the event ledger in index.ts also
// dedupes by event id). The wait is capped (RECONCILE_WAIT_MS, about 9 s).
//
// OFF THE RESPONSE PATH (review 7102099914, findings 1 and 2). The wait above is NOT spent before Stripe gets its 2xx: index.ts calls
// scheduleOffResponsePath(), which hands the whole reconcile to EdgeRuntime.waitUntil and answers 200 at once. Where waitUntil does not
// exist (deno test, a non-Edge runtime) the task is awaited, which is safe there. An alert-channel failure (row insert AND email both
// fail, outcome "error") is logged loudly and NEVER becomes a non-2xx: the ledger row stays and Stripe is not asked to redeliver.
// Residual risk, stated plainly: if the Edge isolate is killed before the background task finishes, that one alert is lost; there is
// no sweep of succeeded measurement PaymentIntents in platform-health-check today (a follow-up, not built here).
//
// DARK BEHIND A FLAG (#3857 rail). Nothing runs unless the env var MEASUREMENT_CHARGE_ENABLED is exactly "true" (the P23 flag, same
// name as hand-off-after-fulfilment). Default off: no hover_orders read, no alert, no wait.
//
// WHAT IT CARRIES. A PaymentIntent id and a claim id (validated shapes), a fixed stage. No buyer email, name, address or Stripe text.
// The email body is the one notify-measurement-order already accepts (token "measurement_paid_gate", kind "paid_without_order");
// this file keeps its own copy of those keys because Edge Functions deploy without cross-function imports, and a parity test pins them.
// Kept out of index.ts because index.ts starts a server at import time.
import { MEASUREMENT_ORDER_PI_TYPES } from "./meta-capi.ts";

export const PAID_WITHOUT_ORDER_ALERT_TYPE = "measurement_paid_without_order"; // the type create-payment-intent's gate already writes
export const PAID_GATE_ALERT_TOKEN = "measurement_paid_gate"; // notify-measurement-order's `alert` token
export const RECONCILE_STAGE = "stripe webhook reconcile"; // matches notify-measurement-order's /^[a-z_ ]{1,40}$/
export const RECONCILE_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pauses before each re-read of hover_orders after the first read (about 9 s in all, well inside the function's limit). */
export const RECONCILE_WAIT_MS: readonly number[] = [2500, 3000, 3500];
export const RECONCILE_EMAIL_TIMEOUT_MS = 5000;

export const MEASUREMENT_CHARGE_FLAG_ENV = "MEASUREMENT_CHARGE_ENABLED";
/** The P23 flag: on only when the env var is exactly "true". */
export function measurementChargeEnabled(getEnv: (k: string) => string | undefined): boolean {
  return getEnv(MEASUREMENT_CHARGE_FLAG_ENV) === "true";
}

export interface WaitUntilHost { waitUntil?: (p: Promise<unknown>) => void }

/**
 * Runs `task` so the HTTP response does not wait for it. With a host that has waitUntil (Supabase's EdgeRuntime) it is registered and
 * this returns at once; without one the task is awaited (tests, non-Edge runtimes). Never throws: a failed task is logged.
 */
export async function scheduleOffResponsePath(task: () => Promise<unknown>, host: WaitUntilHost | undefined, log: (m: string) => void): Promise<"background" | "inline"> {
  const safe = (async () => {
    try { await task(); } catch (e) { log(`OPS: gh-3857 reconcile task threw (${e instanceof Error ? e.name : "unknown"}); no alert was written by it`); }
  })();
  if (host && typeof host.waitUntil === "function") {
    try { host.waitUntil(safe); return "background"; } catch { /* fall through to inline */ }
  }
  await safe;
  return "inline";
}

const PI_ID_RE = /^pi_[A-Za-z0-9_]{1,80}$/;
const CLAIM_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export interface ReconcilePaymentIntent {
  id: string;
  status?: string;
  metadata?: Record<string, string> | null;
}

export interface ReconcileDeps {
  /** true if a hover_orders row carries this PaymentIntent id. Throws on a database error. */
  orderExists(paymentIntentId: string): Promise<boolean>;
  /** true if an alert of this type naming this PaymentIntent was written since sinceIso. Throws on a database error. */
  recentlyAlerted(alertType: string, paymentIntentId: string, sinceIso: string): Promise<boolean>;
  insertAlert(row: { alert_type: string; function_name: string; message: string; sent_at: string }): Promise<{ error?: unknown } | null | void>;
  sendAdminEmail(body: { alert: string; kind: "paid_without_order"; claim_id: string; payment_intent_id: string; stage: string }): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(message: string): void;
}

export type ReconcileOutcome = "recorded" | "alerted" | "duplicate" | "ignored" | "error";

export function buildReconcileAlertMessage(claimId: string, paymentIntentId: string): string {
  return `[gh-3857] claim ${claimId} has a succeeded measurement payment (${paymentIntentId}) and NO hover_orders row (${RECONCILE_STAGE}). ` +
    `The order step after the card payment did not record an order. If the charge is only minutes old the order may still be in progress: check the hover_orders row before acting. ` +
    `No report is queued until an order exists; whether to refund is a manual decision.`;
}

/**
 * Never throws. Scope: a payment_intent.succeeded for a measurement-order PaymentIntent (metadata.type in MEASUREMENT_ORDER_PI_TYPES).
 * "error" means neither the alert row nor the email could be written: the caller logs it (it must never turn the webhook response into a non-2xx).
 */
export async function reconcileMeasurementPaymentOrder(
  pi: ReconcilePaymentIntent,
  deps: ReconcileDeps,
  fnName: string,
): Promise<ReconcileOutcome> {
  try {
    const type = pi?.metadata?.type;
    if (!type || !MEASUREMENT_ORDER_PI_TYPES.has(type)) return "ignored"; // not a measurement purchase
    if (!pi.id || !PI_ID_RE.test(pi.id)) return "ignored"; // cannot name it, cannot look it up
    if (pi.status && pi.status !== "succeeded") return "ignored";
    const claimRaw = pi.metadata?.claim_id ?? "";
    const claimId = CLAIM_ID_RE.test(claimRaw) ? claimRaw : "unrecognized";

    // 1. Is there an order? Read now, then re-read after short pauses: the browser's own order request normally lands within seconds.
    //    A failed read is NOT "no order": it is retried, and if it never answers the alert below is raised anyway (fail toward telling).
    let readFailed = false;
    const waits: readonly number[] = [0, ...RECONCILE_WAIT_MS];
    for (const wait of waits) {
      if (wait > 0) await deps.sleep(wait);
      try {
        if (await deps.orderExists(pi.id)) return "recorded";
        readFailed = false;
      } catch {
        readFailed = true;
      }
    }
    if (readFailed) deps.log(`[${fnName}] gh-3857: hover_orders read failed for ${pi.id}; alerting without a confirmed absence`);

    // 2. No order: one alert per PaymentIntent per window.
    const since = new Date(deps.now().getTime() - RECONCILE_ALERT_WINDOW_MS).toISOString();
    try {
      if (await deps.recentlyAlerted(PAID_WITHOUT_ORDER_ALERT_TYPE, pi.id, since)) return "duplicate";
    } catch {
      // fail toward telling the operator
    }

    deps.log(`[${fnName}] OPS: gh-3857 measurement PaymentIntent ${pi.id} succeeded with NO hover_orders row (claim ${claimId})`);
    let rowOk = false;
    try {
      const res = await deps.insertAlert({
        alert_type: PAID_WITHOUT_ORDER_ALERT_TYPE,
        function_name: fnName,
        message: buildReconcileAlertMessage(claimId, pi.id),
        sent_at: deps.now().toISOString(),
      });
      rowOk = !(res && (res as { error?: unknown }).error);
    } catch {
      rowOk = false;
    }
    if (!rowOk) deps.log(`[${fnName}] gh-3857: paid-without-order alert row insert failed for ${pi.id}`);

    let emailOk = false;
    if (claimId !== "unrecognized") { // the email builder needs a valid claim id; the row above already names the PaymentIntent
      try {
        await deps.sendAdminEmail({ alert: PAID_GATE_ALERT_TOKEN, kind: "paid_without_order", claim_id: claimId, payment_intent_id: pi.id, stage: RECONCILE_STAGE });
        emailOk = true;
      } catch {
        deps.log(`[${fnName}] gh-3857: paid-without-order admin email failed for ${pi.id}`);
      }
    }
    return rowOk || emailOk ? "alerted" : "error";
  } catch {
    return "error";
  }
}

// deno-lint-ignore no-explicit-any
type Sb = any;

/** The production deps over the service-role client. The email goes to notify-measurement-order (service-role bearer), aborted after RECONCILE_EMAIL_TIMEOUT_MS. */
export function makeReconcileDeps(sb: Sb, supabaseUrl: string, serviceKey: string, fetchImpl: typeof fetch = fetch): ReconcileDeps {
  return {
    async orderExists(paymentIntentId) {
      const { data, error } = await sb.from("hover_orders").select("id").eq("homeowner_stripe_payment_intent_id", paymentIntentId).limit(1);
      if (error) throw new Error("hover_orders read failed");
      return Array.isArray(data) && data.length > 0;
    },
    async recentlyAlerted(alertType, paymentIntentId, sinceIso) {
      const { data, error } = await sb
        .from("platform_alerts_log")
        .select("id")
        .eq("alert_type", alertType)
        .ilike("message", `%${paymentIntentId}%`)
        .gte("sent_at", sinceIso)
        .limit(1);
      if (error) throw new Error("alert lookup failed");
      return Array.isArray(data) && data.length > 0;
    },
    insertAlert: (row) => sb.from("platform_alerts_log").insert(row),
    async sendAdminEmail(body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RECONCILE_EMAIL_TIMEOUT_MS);
      try {
        const res = await fetchImpl(`${supabaseUrl}/functions/v1/notify-measurement-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`notify-measurement-order returned ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    log: (m) => console.error(m),
  };
}
