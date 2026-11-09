/**
 * [gh-3447] A paid measurement order must never be lost because buyer_role was missing or unknown.
 *
 * gh-3229 (#3236) made a missing or unrecognised `buyer_role` a 400. That check ran BEFORE the Stripe lookup, so a client that did
 * not send the field (a stale or new caller; every caller on main does send it) paid and got no order.
 *
 * WHAT THIS DOES. An unrecognised role no longer stops the request. The request carries on to the normal checks (catalog, price, Stripe
 * PaymentIntent). If the payment is NOT confirmed it is refused exactly as any unpaid request is (the 402 from the payment checks).
 * If the payment IS confirmed, the order is recorded (role 'homeowner' where resolvePaidRole can show it, else 'unspecified' plus an operator alert), so an admin
 * sees the order in admin-measurements.html (role column reads "unspecified") and in platform_alerts_log.
 *
 * ROLE VALUE AND THE $5 PARTNER FEE (gh-3229). Where the PaymentIntent and claim ownership show a homeowner bought it (resolvePaidRole), the role
 * is 'homeowner' and the fee accrues normally. Otherwise 'unspecified' is not 'homeowner' and not 'contractor'. The accrual trigger
 * partner_fee_accrue_on_order fires only WHEN NEW.requested_by_role = 'homeowner' (and re-checks IS DISTINCT FROM 'homeowner'), so an
 * 'unspecified' order accrues no fee AT INSERT: the $5 is ON HOLD for review, not forfeited (Partner Agreement v4 A4.1: earned when a
 * Referred Homeowner buys). #3229's "no silent default" stands. The trigger is not changed. If an admin establishes the buyer was the referred homeowner the fee may be owed; the trigger is insert-only,
 * so releasing it is #3460's job.
 *
 * Other than the shown-homeowner case, the role is NOT guessed: a contractor_id alone does not prove who paid. The detailed-measurement
 * upgrade is contractor-only by D-317 and is handled in index.ts.
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

/**
 * [gh-3447, CEO/Tier A ruling] Resolve a missing/unknown role for a CONFIRMED payment. 'homeowner' only when it can be shown: the verified
 * PaymentIntent is a hover_measurement, its own metadata claim_id is this claim, and the claim is owned by the caller. (create-payment-intent
 * issues a hover_measurement charge only to the claim's owner and stores no user id on the intent, so caller == claim owner, on the
 * intent's own claim, is the checkable form of "issued to the homeowner who owns the claim".) Anything else, including an intent with no
 * claim_id metadata or an unreadable owner, is 'unspecified'. There is no other default.
 */
export function resolvePaidRole(ctx: {
  piType: string | null;
  piClaimId: string | null;
  claimId: string;
  claimOwnerId: string | null;
  callerId: string;
}): "homeowner" | typeof UNSPECIFIED_ROLE {
  const shown = ctx.piType === "hover_measurement" &&
    !!ctx.piClaimId && ctx.piClaimId === ctx.claimId &&
    !!ctx.claimOwnerId && ctx.claimOwnerId === ctx.callerId;
  return shown ? "homeowner" : UNSPECIFIED_ROLE;
}

/**
 * [gh-3459] The role to RECORD for a confirmed payment, for every non-contractor request: a missing/unknown role (gh-3447) AND an explicit
 * client-sent 'homeowner'. buyer_role is client text, so 'homeowner' is only honoured when resolvePaidRole shows it from server-side facts
 * (the verified PaymentIntent, the claim owner read from the database, the caller from the verified JWT). A caller who does not own the claim
 * and sends "homeowner" is recorded as 'unspecified' (no $5 accrual at insert, operator alert), never 'homeowner'. The buyer has already
 * paid, so the order is still recorded: a downgrade is never a refusal. An explicit 'contractor' is left alone (no lookup).
 * The owner lookup is contained: a throw or an empty result resolves to 'unspecified'.
 */
export async function decidePaidRole(ctx: {
  requestedRole: "homeowner" | "contractor" | typeof UNSPECIFIED_ROLE;
  piType: string | null;
  piClaimId: string | null;
  claimId: string;
  callerId: string;
  lookupClaimOwner: () => PromiseLike<string | null>;
  log?: (m: string) => void;
}): Promise<{ role: "homeowner" | "contractor" | typeof UNSPECIFIED_ROLE; clientHomeownerNotShown: boolean }> {
  if (ctx.requestedRole === "contractor") return { role: "contractor", clientHomeownerNotShown: false };
  let claimOwnerId: string | null = null;
  try {
    claimOwnerId = (await ctx.lookupClaimOwner()) ?? null;
  } catch {
    try { (ctx.log ?? (() => {}))("[create-measurement-order] claim owner lookup failed"); } catch { /* never throw */ }
  }
  const role = resolvePaidRole({
    piType: ctx.piType,
    piClaimId: ctx.piClaimId,
    claimId: ctx.claimId,
    claimOwnerId,
    callerId: ctx.callerId,
  });
  return { role, clientHomeownerNotShown: ctx.requestedRole === "homeowner" && role === UNSPECIFIED_ROLE };
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
      `requested_by_role was set to '${UNSPECIFIED_ROLE}', so any $5 partner fee is ON HOLD (held pending review). An admin should confirm who bought it before the report is delivered (the ready email to the buyer is suppressed for this role until it is settled). ` +
      `The $5 may be owed if the buyer proves to be the referred homeowner; the release path is #3460.`,
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
