/**
 * [gh-3447] A paid measurement order must never be lost because buyer_role was missing or unknown.
 *
 * gh-3229 (#3236) made a missing or unrecognised `buyer_role` a 400. That check ran BEFORE the Stripe lookup, so a client that did
 * not send the field (a stale or new caller; every caller on main does send it) paid and got no order.
 *
 * WHAT THIS DOES. An unrecognised role no longer stops the request. The request carries on to the normal checks (catalog, price, Stripe
 * PaymentIntent). If the payment is NOT confirmed it is refused exactly as any unpaid request is (the 402 from the payment checks).
 * If the payment IS confirmed, the order is recorded with requested_by_role = 'unspecified' and an operator alert is raised, so an admin
 * sees the order in admin-measurements.html (role column reads "unspecified") and in platform_alerts_log.
 *
 * ROLE VALUE AND THE $5 PARTNER FEE (gh-3229). 'unspecified' is not 'homeowner' and not 'contractor'. The accrual trigger
 * partner_fee_accrue_on_order fires only WHEN NEW.requested_by_role = 'homeowner' (and re-checks IS DISTINCT FROM 'homeowner'), so an
 * 'unspecified' order accrues NO partner fee. That is the point of #3229's "no silent default": a role nobody stated never earns a
 * referrer $5. The trigger is not changed. If an admin establishes the buyer was a homeowner, setting requested_by_role to
 * 'homeowner' by hand is a separate, deliberate act (an UPDATE, which the insert-only trigger does not backfill; accrual would be
 * an operator decision, not a side effect).
 *
 * The role is deliberately NOT guessed from the caller's data: a PaymentIntent carries no buyer role, and a contractor_id alone does
 * not prove who paid. Only the one case with a fixed answer is derived: the detailed-measurement upgrade is contractor-only by
 * D-317 and is handled in index.ts.
 */

export const UNSPECIFIED_ROLE = "unspecified";
export const BUYER_ROLE_ALERT_TYPE = "buyer_role_unresolved";

export interface ResolvedRole {
  role: "homeowner" | "contractor" | typeof UNSPECIFIED_ROLE;
  /** true when the client sent nothing recognisable */
  unresolved: boolean;
}

export function resolveBuyerRole(raw: unknown): ResolvedRole {
  if (raw === "homeowner" || raw === "contractor") return { role: raw, unresolved: false };
  return { role: UNSPECIFIED_ROLE, unresolved: true };
}

export interface BuyerRoleAlertRow {
  alert_type: typeof BUYER_ROLE_ALERT_TYPE;
  function_name: "create-measurement-order";
  message: string;
  sent_at: string;
}

/** Validated shapes only: ids are cut to a UUID / pi_ pattern or shown as "unrecognized". No buyer email, name or address. */
export function buildBuyerRoleAlertRow(
  ctx: { orderId: string | null; paymentIntentId: string | null; claimId: string | null; productCode: string },
  now: () => Date = () => new Date(),
): BuyerRoleAlertRow {
  const pi = ctx.paymentIntentId && /^pi_[A-Za-z0-9_]{1,80}$/.test(ctx.paymentIntentId) ? ctx.paymentIntentId : "unrecognized";
  const claim = ctx.claimId && /^[0-9a-f-]{36}$/i.test(ctx.claimId) ? ctx.claimId : "unrecognized";
  const order = ctx.orderId && /^[0-9a-f-]{36}$/i.test(ctx.orderId) ? ctx.orderId : "none";
  const product = /^[a-z0-9_]{1,60}$/.test(ctx.productCode) ? ctx.productCode : "unrecognized";
  return {
    alert_type: BUYER_ROLE_ALERT_TYPE,
    function_name: "create-measurement-order",
    message:
      `Paid measurement order recorded with no usable buyer_role: order ${order}, payment_intent ${pi}, claim ${claim}, product ${product}. ` +
      `requested_by_role was set to '${UNSPECIFIED_ROLE}' (no $5 partner fee accrues for it). An admin should confirm who bought it before the report is delivered (the ready email assumes a homeowner).`,
    sent_at: now().toISOString(),
  };
}

/** Never throws; a failed alert is logged with fixed text and the buyer's order stands. */
export async function raiseBuyerRoleAlert(
  insertAlert: (row: BuyerRoleAlertRow) => PromiseLike<{ error?: unknown } | null | void>,
  log: (m: string) => void,
  row: BuyerRoleAlertRow,
): Promise<void> {
  try {
    const res = await insertAlert(row);
    if (res && (res as { error?: unknown }).error) log("[create-measurement-order] buyer-role alert row insert failed");
  } catch {
    try { log("[create-measurement-order] buyer-role alert row insert failed"); } catch { /* never throw */ }
  }
}
