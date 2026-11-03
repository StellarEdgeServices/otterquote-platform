/**
 * [gh-3356] The operator alerts for the paid-claim gate (measurement-paid-gate.ts), modelled on create-measurement-order's
 * non-usd-alert.ts: a platform_alerts_log row (the surface an operator watches) AND an admin email through notify-measurement-order
 * (the existing admin email path: same Mailgun account, same recipient, service-role bearer), in a second `alert` mode of that function.
 *
 * Three alerts:
 *   - measurement_paid_without_order: a claim has a succeeded (or processing) measurement payment and NO hover_orders row, so no
 *     report is queued for fulfilment. The refusal of a second purchase leaves that customer with a charge and nothing coming.
 *   - measurement_paid_check_unavailable: the gate could not tell whether the claim had paid (Stripe search or the orders read failed),
 *     so it refused to start a payment. If Stripe search is unusable for the account, no purchase can start until someone acts.
 *   - measurement_paid_cancelled_replay: the keyed create replayed a PaymentIntent that is now cancelled, so this homeowner cannot start
 *     a payment at this price until Stripe drops the idempotency key (a person is stuck; someone should reach out).
 *
 * BOUND (a retry loop must not flood the inbox). Per claim and per alert type: if an alert row for the same claim and type already
 * exists inside the window (24 h for paid-without-order, 1 h for check-unavailable and for cancelled-replay), neither the row nor the email is sent again.
 * A failed lookup alerts for paid-without-order (fail toward telling the operator) and writes the row only for check-unavailable
 * (a database that cannot answer a lookup should not also fan out mail from a retry loop).
 *
 * WHAT IT CARRIES. A claim id, a Stripe PaymentIntent id, the alert kind and the stage: validated shapes, no buyer email, name or
 * address, and no Stripe or database text. notify-measurement-order re-validates every field (measurement-paid-gate-alert-email.ts there).
 *
 * BOUNDED AND NEVER THROWS. The refusal is awaited behind this, so the mail call is aborted at ~5 s and the whole alert has a ~6 s
 * deadline; every channel is contained and a failure is logged with fixed text only. Everything is injected (`PaidAlertDeps`).
 */

/** The `alert` token of the body sent to notify-measurement-order. A parity test pins it to that function's copy. */
export const PAID_GATE_ALERT_TOKEN = "measurement_paid_gate";
export type PaidGateAlertKind = "paid_without_order" | "check_unavailable" | "cancelled_replay";

export const PAID_GATE_ALERT_TYPES: Record<PaidGateAlertKind, string> = {
  paid_without_order: "measurement_paid_without_order",
  check_unavailable: "measurement_paid_check_unavailable",
  cancelled_replay: "measurement_paid_cancelled_replay",
};
export const PAID_GATE_ALERT_WINDOW_MS: Record<PaidGateAlertKind, number> = {
  paid_without_order: 24 * 60 * 60 * 1000,
  check_unavailable: 60 * 60 * 1000,
  cancelled_replay: 60 * 60 * 1000,
};
export const PAID_GATE_ALERT_SEND_TIMEOUT_MS = 5000;
export const PAID_GATE_ALERT_DEADLINE_MS = 6000;

export interface PaidGateAlertRow {
  alert_type: string;
  function_name: "create-payment-intent";
  message: string;
  sent_at: string;
}

export interface PaidGateAlertEmailBody {
  alert: typeof PAID_GATE_ALERT_TOKEN;
  kind: PaidGateAlertKind;
  claim_id: string;
  payment_intent_id: string | null;
  stage: string;
}

export interface PaidAlertDeps {
  /** true if a row of this alert_type naming this claim exists with sent_at >= sinceIso. May throw. */
  recentlyAlerted(alertType: string, claimId: string, sinceIso: string): Promise<boolean>;
  insertAlert(row: PaidGateAlertRow): PromiseLike<{ error?: unknown } | null | void>;
  sendAdminEmail(body: PaidGateAlertEmailBody): Promise<void>;
  log(message: string): void;
}

const CLAIM_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const PI_ID_RE = /^pi_[A-Za-z0-9_]{1,80}$/;
const STAGE_RE = /^[a-z_ ]{1,40}$/;

export function buildPaidGateAlertRow(
  a: { kind: PaidGateAlertKind; claimId: string; paymentIntentId: string | null; stage: string; reason?: string },
  now: () => Date = () => new Date(),
): PaidGateAlertRow {
  const pi = a.paymentIntentId && PI_ID_RE.test(a.paymentIntentId) ? a.paymentIntentId : "unrecognized";
  const message = a.kind === "paid_without_order"
    ? `[gh-3356] claim ${a.claimId} has a succeeded or processing measurement payment (${pi}) and NO hover_orders row (${a.stage}). A second purchase was refused. If the charge is only minutes old the order step may still be in progress: check the hover_orders row before acting.`
    : a.kind === "cancelled_replay"
    ? `[gh-3356] claim ${a.claimId}: the measurement PaymentIntent (${pi}) that the idempotency key returns is cancelled (${a.stage}), so the homeowner cannot start a payment at this price until Stripe drops the key. Nothing was charged by this request. A person should reach out.`
    : `[gh-3356] hover_measurement refused (${a.stage}): could not confirm whether claim ${a.claimId} has already paid (${a.reason ?? "lookup failed"}). Nothing was charged; the buyer was asked to retry.`;
  return { alert_type: PAID_GATE_ALERT_TYPES[a.kind], function_name: "create-payment-intent", message, sent_at: now().toISOString() };
}

/** Never throws. Returns whether an alert was raised (false: bounded away, invalid input, or deadline). */
export async function raisePaidGateAlert(
  deps: PaidAlertDeps,
  a: { kind: PaidGateAlertKind; claimId: string; paymentIntentId: string | null; stage: string; reason?: string },
  now: () => Date = () => new Date(),
  deadlineMs: number = PAID_GATE_ALERT_DEADLINE_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => { timer = setTimeout(() => resolve("deadline"), deadlineMs); });
  try {
    const outcome = await Promise.race([alertWork(deps, a, now), deadline]);
    if (outcome === "deadline") {
      try { deps.log("[create-payment-intent] gh-3356: paid-gate alert hit its deadline; the response goes out without waiting"); } catch { /* never throw */ }
      return false;
    }
    return outcome;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function alertWork(
  deps: PaidAlertDeps,
  a: { kind: PaidGateAlertKind; claimId: string; paymentIntentId: string | null; stage: string; reason?: string },
  now: () => Date,
): Promise<boolean> {
  try {
    if (!CLAIM_ID_RE.test(a.claimId)) return false;
    const alertType = PAID_GATE_ALERT_TYPES[a.kind];
    const since = new Date(now().getTime() - PAID_GATE_ALERT_WINDOW_MS[a.kind]).toISOString();
    let sendEmail = true;
    try {
      if (await deps.recentlyAlerted(alertType, a.claimId, since)) return false; // bounded: one per claim per window
    } catch {
      if (a.kind === "check_unavailable") sendEmail = false; // row only: see the header
    }
    try {
      const res = await deps.insertAlert(buildPaidGateAlertRow(a, now));
      if (res && (res as { error?: unknown }).error) deps.log("[create-payment-intent] gh-3356: paid-gate alert row insert failed");
    } catch {
      deps.log("[create-payment-intent] gh-3356: paid-gate alert row insert failed");
    }
    if (sendEmail) {
      try {
        await deps.sendAdminEmail({
          alert: PAID_GATE_ALERT_TOKEN,
          kind: a.kind,
          claim_id: a.claimId,
          payment_intent_id: a.paymentIntentId && PI_ID_RE.test(a.paymentIntentId) ? a.paymentIntentId : null,
          stage: STAGE_RE.test(a.stage) ? a.stage : "unrecognized",
        });
      } catch {
        deps.log("[create-payment-intent] gh-3356: paid-gate admin alert email failed");
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** The database half of PaidAlertDeps over the service-role Supabase client. Column names are checked against the migrations by a test. */
export function makePaidAlertDbDeps(
  // deno-lint-ignore no-explicit-any
  sb: any,
): Pick<PaidAlertDeps, "recentlyAlerted" | "insertAlert"> {
  return {
    async recentlyAlerted(alertType, claimId, sinceIso) {
      const { data, error } = await sb
        .from("platform_alerts_log")
        .select("id")
        .eq("alert_type", alertType)
        .ilike("message", `%${claimId}%`)
        .gte("sent_at", sinceIso)
        .limit(1);
      if (error) throw new Error("lookup failed");
      return Array.isArray(data) && data.length > 0;
    },
    insertAlert: (row) => sb.from("platform_alerts_log").insert(row),
  };
}

/** POST the alert body to notify-measurement-order (service-role bearer), aborted after timeoutMs. Rejects on a non-ok answer or a hang. */
export async function postPaidGateAlertEmail(opts: {
  fetchImpl: typeof fetch;
  supabaseUrl: string;
  serviceKey: string;
  body: PaidGateAlertEmailBody;
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
