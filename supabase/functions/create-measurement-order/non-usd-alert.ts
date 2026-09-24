/**
 * [gh-2107 / D-330] The admin alert for a rejected non-USD payment.
 *
 * Ben's DECIDED (b) on #2078 (5806894411): "A rejected non-USD payment now raises an admin alert. It uses the existing admin email path,
 * in the same PR, not only a server log. Refunds stay manual and are Dustin's call (Tier C)."
 *
 * WHY. create-measurement-order refuses a PaymentIntent that is not in USD (402), but by then the buyer HAS paid, in another currency,
 * and got no report. The 402 tells the buyer to contact support; nothing told the operator. Two artifacts, neither of which may change or
 * break the 402:
 *   1. a platform_alerts_log row (the surface an operator watches; same table the notification-failure path already writes), and
 *   2. an email to the admin through notify-measurement-order (the existing admin email path: same Mailgun account, same recipient,
 *      same service-role machine-to-machine model as the paid-order email), in an `alert` mode of that function.
 *
 * WHAT IT CARRIES. Only the validated shapes from payment-intent-checks.ts (a Stripe PaymentIntent id, a 3-letter currency code, an
 * integer minor-unit amount, each null if it did not match its shape) and the flow. No buyer email address, no name, no address, and
 * no raw Stripe or database text. The operator opens the PaymentIntent in the Stripe dashboard to decide on a refund; that decision is
 * manual and stays Dustin's (Tier C).
 *
 * DEDUPE. A client can retry the same PaymentIntent; one alert per PaymentIntent is enough, so a prior alert row for the same id skips
 * both artifacts. A failed dedupe lookup alerts anyway (fail toward telling the operator).
 *
 * BOUNDED (Ben's follow-up on #2078, 5807572209): the alert is awaited BEFORE the 402 is returned, so it must never hold the response
 * open. The mail call is aborted at ~5 s (postAdminAlertEmail's AbortController), and the WHOLE alert has a deadline just above that
 * (a hung dedupe lookup or row insert is bounded too). Hitting the deadline logs fixed text and the 402 goes out.
 *
 * NEVER THROWS. Each channel is contained on its own so one failing does not stop the other, and a failure is logged with fixed text only.
 * Everything here is injected (`NonUsdAlertDeps`) so it is testable without a database or a network.
 */
import type { NonUsdRejection } from "./payment-intent-checks.ts";

export const NON_USD_ALERT_TYPE = "non_usd_payment_rejected";
export type PaymentFlow = "report" | "upgrade";

export interface NonUsdAlertRow {
  alert_type: typeof NON_USD_ALERT_TYPE;
  function_name: "create-measurement-order";
  message: string;
  sent_at: string;
}

/** The request body notify-measurement-order's alert mode reads (its own copy of this contract lives in non-usd-alert-email.ts). */
export interface NonUsdAlertEmailBody {
  alert: typeof NON_USD_ALERT_TYPE;
  flow: PaymentFlow;
  payment_intent_id: string | null;
  currency: string | null;
  amount_minor: number | null;
}

export interface NonUsdAlertDeps {
  /** true if an alert row for this PaymentIntent id already exists */
  alreadyAlerted(paymentIntentId: string): Promise<boolean>;
  insertAlert(row: NonUsdAlertRow): PromiseLike<{ error?: unknown } | null | void>;
  sendAdminEmail(body: NonUsdAlertEmailBody): Promise<void>;
  /** fixed-text log lines only */
  log(message: string): void;
}

const UNRECOGNIZED = "unrecognized";

/** The mail call to notify-measurement-order is aborted after this long. */
export const NON_USD_ALERT_SEND_TIMEOUT_MS = 5000;
/** The whole alert (lookup, row, mail) gives up after this long, so the 402 is never held open by it. */
export const NON_USD_ALERT_DEADLINE_MS = 6000;

/**
 * POST the alert body to notify-measurement-order (service-role bearer, the existing admin email path) with an AbortController.
 * Rejects on a non-ok response or when the timeout aborts a hung call. The message is fixed text (no upstream text).
 */
export async function postAdminAlertEmail(opts: {
  fetchImpl: typeof fetch;
  supabaseUrl: string;
  serviceKey: string;
  body: NonUsdAlertEmailBody;
  timeoutMs: number;
}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetchImpl(`${opts.supabaseUrl}/functions/v1/notify-measurement-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.serviceKey}` },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`notify-measurement-order returned ${res.status}`);
  } catch (e) {
    if (controller.signal.aborted) throw new Error("notify-measurement-order did not answer in time");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function buildNonUsdAlertRow(n: NonUsdRejection, flow: PaymentFlow, now: () => Date = () => new Date()): NonUsdAlertRow {
  return {
    alert_type: NON_USD_ALERT_TYPE,
    function_name: "create-measurement-order",
    message:
      `Non-USD payment rejected (${flow} purchase): payment_intent ${n.paymentIntentId ?? UNRECOGNIZED}, ` +
      `currency ${n.currency ?? UNRECOGNIZED}, amount ${n.amountCents ?? UNRECOGNIZED} (minor units). ` +
      `The buyer paid and was not given a report. Refund is a manual decision.`,
    sent_at: now().toISOString(),
  };
}

export async function raiseNonUsdPaymentAlert(
  deps: NonUsdAlertDeps,
  n: NonUsdRejection,
  flow: PaymentFlow,
  now: () => Date = () => new Date(),
  deadlineMs: number = NON_USD_ALERT_DEADLINE_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => { timer = setTimeout(() => resolve("deadline"), deadlineMs); });
  try {
    const outcome = await Promise.race([alertWork(deps, n, flow, now), deadline]);
    if (outcome === "deadline") {
      try { deps.log(`[create-measurement-order] non-usd alert hit its deadline; the response goes out without waiting`); } catch { /* never throw */ }
    }
  } catch {
    // a logger that throws must not turn a 402 into a 500
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function alertWork(
  deps: NonUsdAlertDeps,
  n: NonUsdRejection,
  flow: PaymentFlow,
  now: () => Date,
): Promise<void> {
  try {
    if (n.paymentIntentId) {
      let already = false;
      try {
        already = await deps.alreadyAlerted(n.paymentIntentId);
      } catch {
        already = false; // cannot tell: alert
      }
      if (already) return;
    }

    try {
      const res = await deps.insertAlert(buildNonUsdAlertRow(n, flow, now));
      if (res && (res as { error?: unknown }).error) deps.log(`[create-measurement-order] non-usd alert row insert failed`);
    } catch {
      deps.log(`[create-measurement-order] non-usd alert row insert failed`);
    }

    try {
      await deps.sendAdminEmail({
        alert: NON_USD_ALERT_TYPE,
        flow,
        payment_intent_id: n.paymentIntentId,
        currency: n.currency,
        amount_minor: n.amountCents,
      });
    } catch {
      deps.log(`[create-measurement-order] non-usd admin alert email failed`);
    }
  } catch {
    // a logger that throws must not turn a 402 into a 500
  }
}
