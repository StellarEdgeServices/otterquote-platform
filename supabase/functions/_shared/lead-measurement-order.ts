// gh-2121 (HO-3, #2121 row 3.2) -- shared, pure logic for the no-account,
// lead-keyed $15 measurement purchase. Used by THREE callers so the rules
// cannot drift between them (PR #2226 REVIEW D5/D7/D10):
//   - create-lead-payment-intent  (price, Stripe mode/key, already-ordered check)
//   - create-lead-measurement-order (browser path: verify the PI, record the order)
//   - stripe-webhook               (payment_intent.succeeded: record the order
//                                   even when the browser never calls back)
//
// No Supabase client, no fetch, no Deno.env here -- every side effect is
// injected, so this module is unit-tested directly
// (lead-measurement-order.test.ts).

export const LEAD_MEASUREMENT_PI_TYPE = "lead_measurement_order";
export const LEAD_PRODUCT_CODE = "roof_basic";
/** The SAME platform_settings key create-payment-intent charges from (D-181/D-291). */
export const HOVER_PRICE_SETTING_KEY = "hover_measurement_price";
/** platform_alerts_log.alert_type for "a card was charged and no order row exists". */
export const LEAD_ORDER_UNRECORDED_ALERT = "lead_order_payment_captured_unrecorded";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Stripe mode (D7) ──────────────────────────────────────────────────────────
// The Stripe key and the accepted PaymentIntent mode come from SERVER config
// (the STRIPE_MODE secret), never from the request's Origin header. Anything
// other than the exact string "test" means live -- the safe default for the
// production project. Only a deliberately non-production project sets
// STRIPE_MODE=test.
export type StripeMode = "live" | "test";

export function resolveStripeMode(raw: string | null | undefined): StripeMode {
  return typeof raw === "string" && raw.trim().toLowerCase() === "test" ? "test" : "live";
}

/** No fallback between modes: live mode never reads the test key and vice versa. */
export function stripeSecretKeyForMode(
  mode: StripeMode,
  getEnv: (name: string) => string | undefined,
): string | undefined {
  return mode === "test" ? getEnv("STRIPE_SECRET_KEY_TEST") : getEnv("STRIPE_SECRET_KEY");
}

// ── Price (D-181, L3) ─────────────────────────────────────────────────────────
export class PlatformSettingMissingError extends Error {
  readonly settingKey: string;
  constructor(settingKey: string, detail?: string) {
    super(`platform_setting_missing: ${settingKey}${detail ? ` — ${detail}` : ""}`);
    this.name = "PlatformSettingMissingError";
    this.settingKey = settingKey;
  }
}

/** Same failure discipline as create-payment-intent's price-setting.ts: a missing or invalid price throws; there is no hard-coded fallback. */
export function resolveRequiredPriceCents(
  settingKey: string,
  row: { value: unknown } | null | undefined,
  readError: { message?: string } | null | undefined,
): number {
  if (readError) throw new PlatformSettingMissingError(settingKey, readError.message);
  if (row == null || row.value === null || row.value === undefined) {
    throw new PlatformSettingMissingError(settingKey, "no row");
  }
  const resolved = typeof row.value === "number" ? row.value : Number(row.value);
  if (!Number.isFinite(resolved) || resolved <= 0 || !Number.isInteger(resolved)) {
    throw new PlatformSettingMissingError(settingKey, `value is not a valid positive integer (cents): ${JSON.stringify(row.value)}`);
  }
  return resolved;
}

// ── Already-ordered (D10) ─────────────────────────────────────────────────────
/** An order in any status other than cancelled/refunded means the lead has already bought the report. */
export function isBlockingOrderStatus(status: unknown): boolean {
  return typeof status === "string" && status !== "cancelled" && status !== "refunded";
}

// ── PaymentIntent verification (D7, shared by the browser path and the webhook) ─
// deno-lint-ignore no-explicit-any
export type PaymentIntentLike = any;

export type PaymentCheckResult =
  | { ok: true; leadId: string; amount: number; currency: "usd"; stripeChargeId: string | null; isSyntheticMeta: boolean }
  | { ok: false; status: number; reason: string; error: string };

/**
 * A PaymentIntent is accepted as a paid HO-3 order only when ALL hold:
 *   - its livemode matches the server's Stripe mode (D7: in live mode a
 *     test-mode PI -- e.g. one confirmed with card 4242 -- is refused);
 *   - status succeeded, currency usd, amount === the server price;
 *   - metadata.type is this feature's type and metadata.lead_id is a UUID
 *     (and equals ctx.leadId when the caller already knows the lead).
 */
export function checkLeadPaymentIntent(
  pi: PaymentIntentLike,
  ctx: { expectedAmount: number; leadId: string | null; stripeMode: StripeMode },
): PaymentCheckResult {
  if (!pi || typeof pi !== "object") {
    return { ok: false, status: 402, reason: "no_payment_intent", error: "We could not verify your payment. Please contact support." };
  }
  const wantLive = ctx.stripeMode === "live";
  if (pi.livemode !== wantLive) {
    return { ok: false, status: 402, reason: "livemode_mismatch", error: "This payment could not be accepted. Please contact support." };
  }
  if (pi.status !== "succeeded") {
    return { ok: false, status: 402, reason: "not_succeeded", error: "Payment must complete before we can order your report." };
  }
  if (pi.currency !== "usd") {
    return { ok: false, status: 402, reason: "not_usd", error: "This payment could not be accepted because it was not made in US dollars. Please contact support." };
  }
  if (pi.amount !== ctx.expectedAmount) {
    return { ok: false, status: 402, reason: "amount_mismatch", error: "Payment amount does not match the report price. Please contact support." };
  }
  if (pi.metadata?.type !== LEAD_MEASUREMENT_PI_TYPE) {
    return { ok: false, status: 402, reason: "wrong_type", error: "Payment is not a measurement charge. Please contact support." };
  }
  const metaLead = typeof pi.metadata?.lead_id === "string" ? pi.metadata.lead_id : "";
  if (!UUID_RE.test(metaLead)) {
    return { ok: false, status: 402, reason: "no_lead_id", error: "Payment does not belong to this request. Please contact support." };
  }
  if (ctx.leadId !== null && metaLead !== ctx.leadId) {
    return { ok: false, status: 402, reason: "lead_mismatch", error: "Payment does not belong to this request. Please contact support." };
  }
  const charge = pi.latest_charge;
  const stripeChargeId = typeof charge === "string" ? charge : (charge && typeof charge.id === "string" ? charge.id : null);
  return {
    ok: true,
    leadId: metaLead,
    amount: pi.amount,
    currency: "usd",
    stripeChargeId,
    isSyntheticMeta: pi.metadata?.is_synthetic === "1",
  };
}

// ── The order row + idempotent recording (D5) ─────────────────────────────────
export interface LeadOrderRowInput {
  leadId: string;
  paymentIntentId: string;
  amountCents: number;
  stripeChargeId: string | null;
  isTest: boolean;
  recordedBy: "browser" | "webhook";
}

export function buildLeadOrderRow(i: LeadOrderRowInput): Record<string, unknown> {
  return {
    lead_id: i.leadId,
    status: "awaiting_fulfillment",
    product_code: LEAD_PRODUCT_CODE,
    stripe_payment_intent_id: i.paymentIntentId,
    homeowner_charge_amount: i.amountCents,
    currency: "usd",
    stripe_charge_id: i.stripeChargeId,
    // L2: no rebate promise or flag on a lead order (Tier C -- see the migration comment).
    rebate_due: false,
    is_test: i.isTest,
    recorded_by: i.recordedBy,
  };
}

export interface OrderRef {
  id: string;
  status: string;
  lead_id?: string;
}

export interface RecordDeps {
  /** INSERT ... ON CONFLICT (stripe_payment_intent_id) DO NOTHING RETURNING id, status. `row` is null when the conflict fired. */
  insertIgnoringDuplicate: (row: Record<string, unknown>) => Promise<{ row: OrderRef | null; error: { code?: string; message?: string } | null }>;
  findByPaymentIntent: (paymentIntentId: string) => Promise<OrderRef | null>;
  /** Writes a platform_alerts_log row. Must never throw. */
  alert: (alertType: string, message: string) => Promise<void>;
}

export type RecordOutcome =
  | { outcome: "inserted"; order: OrderRef }
  | { outcome: "existing"; order: OrderRef }
  | { outcome: "failed" };

export function isUniqueViolation(err: { code?: string } | null | undefined): boolean {
  return !!err && err.code === "23505";
}

/** Fixed text only: a PaymentIntent id and where it happened, never an email/name/DB error string. */
export function unrecordedAlertMessage(paymentIntentId: string, where: string, reason: string): string {
  return `HO-3 lead order NOT recorded after a successful charge (${where}, ${reason}) for payment_intent ${paymentIntentId}. Record or refund by hand.`;
}

/**
 * Records the order exactly once per PaymentIntent. A duplicate (the browser
 * and the webhook racing, or a retry) returns the existing row; any other
 * failure writes platform_alerts_log (an operator-watched surface) and
 * returns "failed" -- it is never silent.
 */
export async function recordLeadOrder(
  input: LeadOrderRowInput,
  deps: RecordDeps,
): Promise<RecordOutcome> {
  const where = input.recordedBy;
  let res: { row: OrderRef | null; error: { code?: string; message?: string } | null };
  try {
    res = await deps.insertIgnoringDuplicate(buildLeadOrderRow(input));
  } catch {
    res = { row: null, error: { message: "insert threw" } };
  }
  if (res.row && !res.error) return { outcome: "inserted", order: res.row };

  if (!res.error || isUniqueViolation(res.error)) {
    let existing: OrderRef | null = null;
    try {
      existing = await deps.findByPaymentIntent(input.paymentIntentId);
    } catch {
      existing = null;
    }
    if (existing) return { outcome: "existing", order: existing };
    await deps.alert(LEAD_ORDER_UNRECORDED_ALERT, unrecordedAlertMessage(input.paymentIntentId, where, "conflict_but_no_row"));
    return { outcome: "failed" };
  }

  await deps.alert(LEAD_ORDER_UNRECORDED_ALERT, unrecordedAlertMessage(input.paymentIntentId, where, `insert_error_${res.error.code ?? "unknown"}`));
  return { outcome: "failed" };
}
