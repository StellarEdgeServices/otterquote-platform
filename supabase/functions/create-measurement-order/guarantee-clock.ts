/**
 * [gh-3471, P23 / #3427] The 100-hour clock, stored when a real measurement payment succeeds. The clock only; what it promises is not decided here.
 *
 * WHAT IS STORED. On the hover_orders row create-measurement-order writes after it verifies the PaymentIntent:
 *   guarantee_started_at   = the time the payment succeeded (see paymentSucceededAt)
 *   guarantee_deadline_at  = guarantee_started_at + exactly 100 hours (GUARANTEE_HOURS * 3600 s; hours, never days, so no daylight-saving drift)
 * Both are written in the same INSERT as the order, so the clock and the order cannot disagree and no second write can fail after the money moved.
 *
 * WHY THE ROW AND NOT A NEW TABLE. The order row is the one durable "payment reached succeeded" fact (there is no payments table for hover_measurement,
 * Kevin's note on #3428, comment 6667297771). A side table would need a second write after the money moved, which can fail and leave a paid order with no
 * clock; a column in the existing INSERT cannot. A later refund job reads one row, not a join. Additive nullable columns only (migration draft in migrations_drafts).
 *
 * PAYMENT TIME. Stripe has no "succeeded_at" on a PaymentIntent. The time a card payment succeeded is the created time of its (succeeded, paid) charge,
 * which is read from the PaymentIntent fetched with latest_charge expanded. It is NOT page load, account creation, PaymentIntent creation or the time
 * this function runs (a buyer's browser may call it late). If that time cannot be read, NO clock is stored and the operator is alerted; a clock is never invented.
 *
 * TEST ORDERS GET NEITHER. Same filter as the owner-alert sweep (#3428 / PR #3439): claims.is_test, profiles.is_test of the claim owner and of the buyer, the
 * staff e-mail rule. hover_orders has no is_test column. A Stripe test-mode PaymentIntent (livemode === false) is also a test. A lookup that FAILS is treated as
 * "real": a real customer must never lose a clock because a read failed (the same posture as recordOrderCreated's is_test lookup).
 */

export const GUARANTEE_HOURS = 100;
export const GUARANTEE_CLOCK_ALERT_TYPE = "guarantee_clock_not_stored";
/** Staff domains of the #3428 predicate (owner_alert_is_internal): is_internal_test_email's four plus otterquote.com. */
export const INTERNAL_EMAIL_DOMAINS = ["otterquote.com", "stellaredgeservices.com", "tryotterquote.com", "stohlerroof.com", "otterquote-internal.test"];
/** gmail.com staff base address (plus-addressing ignored), as in is_internal_test_email. The second staff base is read from the database (isInternalEmail). */
export const INTERNAL_GMAIL_BASES = ["dustinstohler1"];

const MS_PER_HOUR = 3_600_000;
/** A charge time further ahead of now than this is a bad read, not a payment. */
const FUTURE_SKEW_MS = 5 * 60_000;

export interface GuaranteeClockFields {
  guarantee_started_at: string;
  guarantee_deadline_at: string;
}

/** start = the payment time; deadline = start + exactly 100 hours. ISO-8601 UTC strings (Postgres timestamptz input). */
export function buildGuaranteeClock(paidAt: Date): GuaranteeClockFields {
  return {
    guarantee_started_at: paidAt.toISOString(),
    guarantee_deadline_at: new Date(paidAt.getTime() + GUARANTEE_HOURS * MS_PER_HOUR).toISOString(),
  };
}

/**
 * The payment-succeeded time of a PaymentIntent fetched with latest_charge expanded: the charge's `created` (unix seconds), only when the charge
 * itself shows paid and succeeded and the PaymentIntent is succeeded. Anything else is null.
 */
// deno-lint-ignore no-explicit-any
export function paymentSucceededAt(pi: any, now: Date = new Date()): Date | null {
  const charge = pi?.latest_charge;
  if (!charge || typeof charge !== "object") return null;
  if (pi.status !== "succeeded" || charge.status !== "succeeded" || charge.paid !== true) return null;
  if (!Number.isInteger(charge.created) || charge.created <= 0) return null;
  const at = new Date(charge.created * 1000);
  if (at.getTime() > now.getTime() + FUTURE_SKEW_MS) return null;
  return at;
}

/** The charge id as a string whether latest_charge came back expanded (object) or not (string). */
// deno-lint-ignore no-explicit-any
export function chargeIdOf(latestCharge: any): string | null {
  if (typeof latestCharge === "string") return latestCharge;
  if (latestCharge && typeof latestCharge === "object" && typeof latestCharge.id === "string") return latestCharge.id;
  return null;
}

export interface ProfileRow { is_test?: boolean | null; email?: string | null }

/** True for a staff / test e-mail by the #3428 rule. */
export function isInternalEmail(email: string | null | undefined): boolean {
  if (typeof email !== "string") return false;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return false;
  const domain = e.slice(at + 1);
  if (INTERNAL_EMAIL_DOMAINS.includes(domain)) return true;
  if (domain === "gmail.com") return INTERNAL_GMAIL_BASES.includes(e.slice(0, at).split("+")[0]);
  return false;
}

export interface ClockDeps {
  /** PaymentIntent.livemode; false = Stripe test mode. */
  livemode?: boolean | null;
  paidAt: Date | null;
  lookupClaim: () => Promise<{ is_test?: boolean | null; user_id?: string | null } | null>;
  lookupProfile: (userId: string) => Promise<ProfileRow | null>;
  buyerId: string;
  /** Optional database rule (public.is_internal_test_email): catches the staff address the code does not list. Failure = false. */
  dbSaysInternal?: (email: string) => Promise<boolean>;
  log: (m: string) => void;
}

export type ClockDecision =
  | { stored: true; fields: GuaranteeClockFields }
  | { stored: false; reason: "is_test" | "no_payment_time"; fields: Record<string, never> };

async function profileIsTest(deps: ClockDeps, id: string | null | undefined): Promise<boolean> {
  if (!id) return false;
  try {
    const p = await deps.lookupProfile(id);
    if (!p) return false;
    if (p.is_test === true) return true;
    if (isInternalEmail(p.email)) return true;
    if (deps.dbSaysInternal && typeof p.email === "string" && p.email) {
      try { if (await deps.dbSaysInternal(p.email)) return true; } catch { /* a failed read is "real" */ }
    }
    return false;
  } catch {
    deps.log("[create-measurement-order] guarantee clock: profile test-flag lookup failed (treated as real)");
    return false;
  }
}

/** Decide the clock for one confirmed payment. Never throws. A test order gets neither field; so does a payment whose time cannot be read. */
export async function decideGuaranteeClock(deps: ClockDeps): Promise<ClockDecision> {
  if (deps.livemode === false) return { stored: false, reason: "is_test", fields: {} };
  let claim: { is_test?: boolean | null; user_id?: string | null } | null = null;
  try {
    claim = await deps.lookupClaim();
  } catch {
    deps.log("[create-measurement-order] guarantee clock: claim is_test lookup failed (treated as real)");
  }
  if (claim?.is_test === true) return { stored: false, reason: "is_test", fields: {} };
  if (await profileIsTest(deps, claim?.user_id) || await profileIsTest(deps, deps.buyerId)) {
    return { stored: false, reason: "is_test", fields: {} };
  }
  if (!deps.paidAt) return { stored: false, reason: "no_payment_time", fields: {} };
  return { stored: true, fields: buildGuaranteeClock(deps.paidAt) };
}

export interface ClockAlertRow {
  alert_type: typeof GUARANTEE_CLOCK_ALERT_TYPE;
  function_name: "create-measurement-order";
  message: string;
  sent_at: string;
}

/** Validated shapes only (ids cut to a UUID / pi_ pattern). Says what is missing; promises nothing. */
export function buildClockAlertRow(
  ctx: { reason: "no_payment_time" | "column_missing"; orderId: string | null; paymentIntentId: string | null; claimId: string | null },
  now: () => Date = () => new Date(),
): ClockAlertRow {
  const pi = ctx.paymentIntentId && /^pi_[A-Za-z0-9_]{1,80}$/.test(ctx.paymentIntentId) ? ctx.paymentIntentId : "unrecognized";
  const claim = ctx.claimId && /^[0-9a-f-]{36}$/i.test(ctx.claimId) ? ctx.claimId : "unrecognized";
  const order = ctx.orderId && /^[0-9a-f-]{36}$/i.test(ctx.orderId) ? ctx.orderId : "none";
  const why = ctx.reason === "column_missing"
    ? "the clock columns are not in this database yet (migration gh3471 not applied)"
    : "Stripe did not show when the payment succeeded";
  return {
    alert_type: GUARANTEE_CLOCK_ALERT_TYPE,
    function_name: "create-measurement-order",
    message:
      `Paid measurement order recorded WITHOUT its timing clock (gh-3471): order ${order}, payment_intent ${pi}, claim ${claim}, because ${why}. ` +
      `The order itself stands. The start time is the payment's Stripe charge time; an admin sets it from the Stripe dashboard if this order needs a clock.`,
    sent_at: now().toISOString(),
  };
}

/** Never throws; a failed alert is logged with fixed text. */
export async function raiseClockAlert(
  insertAlert: (row: ClockAlertRow) => PromiseLike<{ error?: unknown } | null | void>,
  log: (m: string) => void,
  row: ClockAlertRow,
): Promise<void> {
  try {
    const res = await insertAlert(row);
    if (res && (res as { error?: unknown }).error) log("[create-measurement-order] guarantee-clock alert row insert failed");
  } catch {
    try { log("[create-measurement-order] guarantee-clock alert row insert failed"); } catch { /* never throw */ }
  }
}
