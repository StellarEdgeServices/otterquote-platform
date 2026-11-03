/**
 * [gh-3356] Refuse a SECOND hover_measurement PaymentIntent on a claim that has already paid for its report.
 *
 * THE DEFECT. The only thing that stopped a second $22.63 charge on a paid claim was Stripe's 24-hour idempotency key
 * (`hover_measurement-<claim>-<amount>`): inside the window a reload gets the first PaymentIntent back, after it a reload gets a
 * new, chargeable one. index.ts checked claim ownership only; it never looked at hover_orders, payment status or Stripe.
 *
 * WHAT RECORDS A SUCCESSFUL MEASUREMENT PAYMENT (read from the code, not assumed):
 *   - claims.hover_paid / hover_order_id / hover_status are NOT written by any Edge Function, migration or page (the columns exist
 *     with defaults and are only SELECTed). They say nothing and are not used here.
 *   - hover_orders.homeowner_stripe_payment_intent_id is written by create-measurement-order, and only AFTER it has fetched the
 *     PaymentIntent from Stripe and seen status === "succeeded". So an order row with a PaymentIntent id is proof of payment.
 *   - But that insert happens in a SECOND request, made by the browser after the card confirms. If it fails (the function errors,
 *     the tab closes), the card is charged and there is NO order row. That is the likeliest duplicate, and only Stripe knows about it.
 *     So Stripe is searched too: PaymentIntents carrying this claim's id and metadata[type]=hover_measurement.
 *
 * REFUNDED PAYMENTS (decision, with evidence):
 *   - A REBATED order stays "paid". process-hover-rebate refunds the fee when the claim's job is marked complete (D-181 / D-205 /
 *     D-291) and sets hover_orders.rebate_paid_at; the report was delivered and the rebate is the product's own pricing model, not
 *     a cancellation. A homeowner who completed the job and was rebated must not be sold a second report. rebate_paid_at set => paid.
 *   - A payment fully refunded BY ANY OTHER ROUTE (a support refund, Tier C) has no code behind it that says whether a repurchase is
 *     legitimate. Today's behaviour is that a new intent can be created once the 24-hour key has expired, so that is kept: a
 *     PaymentIntent whose charge is fully refunded and which has no rebate_paid_at is NOT counted as paid. FLAGGED in the PR for a
 *     decision. A PARTIAL refund still counts as paid (the report was bought and not wholly returned).
 *   - The refund test needs the charge, so every Stripe read here expands latest_charge. If it cannot be read as an object, the
 *     payment counts as paid (fails toward refusing).
 *
 * FAILURE POLICY (fails CLOSED, deliberately). If the order lookup or the Stripe lookup errors, times out or is not understood, no
 * PaymentIntent is created: the caller gets a 503 with a retry message and nothing has been charged. A silent "allow" would turn
 * a Stripe or database blip into the very double charge this closes. It costs a first-time buyer nothing extra during a Stripe
 * outage, because creating the PaymentIntent needs the same Stripe API. The one real cost is if Stripe's SEARCH endpoint alone
 * is unavailable or rejects the account: purchases are then blocked until it is fixed. That is why the refusal writes a
 * platform_alerts_log row (index.ts) and why the PR asks the CEO whether to accept that trade.
 *
 * Pure of the Supabase client and of `fetch`: both are injected so the harness in idempotent-retry.test.ts drives the real code
 * against a fake Stripe.
 */
import { fetchStripeWithTimeout } from "./stripe-fetch.ts";
import { UPGRADE_PRODUCT_CODE } from "./measurement-upgrade-gate.ts";

export const ALREADY_PAID_CODE = "MEASUREMENT_ALREADY_PAID";
export const PAID_CHECK_UNAVAILABLE_CODE = "MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE";

/** Technical text for logs and the `error` field. The customer-facing sentences live in help-measurements.html, keyed by `code`. */
export const ALREADY_PAID_ERROR = "A report has already been paid for on this claim; no new payment was created.";
export const PAID_CHECK_UNAVAILABLE_ERROR = "Could not confirm whether this claim has already paid for its report; no payment was created. Retry shortly.";

/** Replayed creates older than this are re-read from Stripe (a replay returns the FIRST response, whose status can be stale). */
export const REPLAY_AGE_SECONDS = 60;
export const PAID_CHECK_TIMEOUT_MS = 8000;

export interface HoverOrderRow {
  homeowner_stripe_payment_intent_id: string | null;
  product_code: string | null;
  rebate_paid_at: string | null;
}

export type PaidReason = "rebated_order" | "succeeded" | "processing";

export type PaidVerdict =
  | { kind: "not_paid" }
  | { kind: "paid"; reason: PaidReason; paymentIntentId: string | null; hasOrderRow: boolean }
  | { kind: "unavailable"; why: string };

export interface PaidGateDeps {
  fetchFn: typeof fetch;
  /** e.g. https://api.stripe.com/v1 */
  apiBase: string;
  /** Base64 of `<secret key>:` for HTTP Basic auth: the SAME key the create will use (test claim => test key). */
  basicAuth: string;
  claimId: string;
  /** hover_orders rows for the claim; `error` non-null means the read failed. */
  loadOrders: () => Promise<{ rows: HoverOrderRow[] | null; error: unknown }>;
  timeoutMs?: number;
  log?: (message: string) => void;
}

// deno-lint-ignore no-explicit-any
type Pi = any;

/** Is this PaymentIntent a completed (or completing) payment that still stands? */
export function evaluatePaymentIntent(pi: Pi): "paid_succeeded" | "paid_processing" | "refunded" | "unpaid" {
  if (!pi || typeof pi !== "object") return "unpaid";
  if (pi.status === "processing") return "paid_processing";
  if (pi.status !== "succeeded") return "unpaid"; // requires_payment_method / requires_action / requires_confirmation / canceled
  const charge = pi.latest_charge;
  if (charge && typeof charge === "object" && charge.refunded === true) return "refunded"; // fully refunded, not by the rebate
  return "paid_succeeded"; // includes a partial refund, and a charge we could not read
}

const UUID_LIKE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * The pre-create check. Never throws: every failure becomes {kind: "unavailable"}.
 * Order: (1) hover_orders (a rebated order is decisive, no Stripe needed); (2) Stripe, for every PaymentIntent the orders name
 * and every PaymentIntent Stripe's search finds for the claim.
 */
export async function checkClaimHasNotPaid(deps: PaidGateDeps): Promise<PaidVerdict> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const timeout = deps.timeoutMs ?? PAID_CHECK_TIMEOUT_MS;
  try {
    if (!UUID_LIKE.test(deps.claimId)) return { kind: "unavailable", why: "claim id has an unexpected shape" };

    const { rows, error } = await deps.loadOrders();
    if (error || !Array.isArray(rows)) return { kind: "unavailable", why: "hover_orders read failed" };

    // The contractor detailed-measurement upgrade is a different product bought by a different person; it never counts.
    const homeownerOrders = rows.filter(
      (r) => r.product_code !== UPGRADE_PRODUCT_CODE && typeof r.homeowner_stripe_payment_intent_id === "string" && r.homeowner_stripe_payment_intent_id !== "",
    );
    const rebated = homeownerOrders.find((r) => r.rebate_paid_at);
    if (rebated) {
      return { kind: "paid", reason: "rebated_order", paymentIntentId: rebated.homeowner_stripe_payment_intent_id, hasOrderRow: true };
    }
    const orderPiIds = new Set(homeownerOrders.map((r) => r.homeowner_stripe_payment_intent_id as string));

    const headers = { Authorization: `Basic ${deps.basicAuth}` };

    // Stripe search: paid-with-no-order is found here. Eventually consistent (a payment a few seconds old may not be indexed yet):
    // that gap is closed for the 24-hour replay case by assertCreatedIntentNotPaid, and a payment is always indexed long before its
    // 24-hour key expires.
    const query = `metadata['claim_id']:'${deps.claimId}' AND metadata['type']:'hover_measurement'`;
    const searchUrl = `${deps.apiBase}/payment_intents/search?query=${encodeURIComponent(query)}&limit=100&expand[]=data.latest_charge`;
    const sr = await fetchStripeWithTimeout(deps.fetchFn, searchUrl, { method: "GET", headers }, timeout);
    if (!sr.ok) return { kind: "unavailable", why: `Stripe search answered HTTP ${sr.status}` };
    const found = await sr.json();
    if (!found || !Array.isArray(found.data)) return { kind: "unavailable", why: "Stripe search answer not understood" };

    const seen = new Map<string, Pi>();
    for (const pi of found.data) if (pi && typeof pi.id === "string") seen.set(pi.id, pi);

    // An order's PaymentIntent that search did not return (lag, or a PaymentIntent created without the metadata): read it directly.
    for (const id of orderPiIds) {
      if (seen.has(id)) continue;
      if (!/^pi_[A-Za-z0-9_]{1,80}$/.test(id)) return { kind: "unavailable", why: "an order carries an unexpected PaymentIntent id" };
      const r = await fetchStripeWithTimeout(deps.fetchFn, `${deps.apiBase}/payment_intents/${id}?expand[]=latest_charge`, { method: "GET", headers }, timeout);
      if (!r.ok) return { kind: "unavailable", why: `Stripe retrieve answered HTTP ${r.status}` };
      seen.set(id, await r.json());
    }

    // More than one page of intents for one claim is not a case this check can see all of: do not guess.
    const unpaged = found.has_more === true;

    for (const [id, pi] of seen) {
      const v = evaluatePaymentIntent(pi);
      if (v === "paid_succeeded" || v === "paid_processing") {
        return {
          kind: "paid",
          reason: v === "paid_processing" ? "processing" : "succeeded",
          paymentIntentId: id,
          hasOrderRow: orderPiIds.has(id),
        };
      }
    }
    if (unpaged) return { kind: "unavailable", why: "Stripe search returned more than one page" };
    return { kind: "not_paid" };
  } catch (e) {
    // The thrown text can carry a URL or Stripe's wording: log the class only.
    log(`[create-payment-intent] gh-3356: paid-claim check failed (${e instanceof Error ? e.name : typeof e})`);
    return { kind: "unavailable", why: "paid-claim check threw" };
  }
}

/**
 * The post-create check, for the 24-hour replay window. A reused Idempotency-Key returns the FIRST response, so a PaymentIntent
 * that has since succeeded still reads `requires_payment_method` here. When the create looks like a replay (Stripe's
 * `Idempotent-Replayed: true` header, or a PaymentIntent created more than REPLAY_AGE_SECONDS ago) it is re-read from Stripe, and
 * if it has been paid the caller must NOT hand its client_secret back. A first-time buyer's brand-new PaymentIntent is not re-read.
 */
export async function assertCreatedIntentNotPaid(
  deps: Pick<PaidGateDeps, "fetchFn" | "apiBase" | "basicAuth" | "timeoutMs" | "log">,
  created: { id: string; status?: string; created?: number },
  createResponse: Response,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<PaidVerdict> {
  const replayed = createResponse.headers.get("Idempotent-Replayed") === "true";
  const old = typeof created.created === "number" && nowSeconds - created.created > REPLAY_AGE_SECONDS;
  if (!replayed && !old) return { kind: "not_paid" };
  const log = deps.log ?? ((m: string) => console.error(m));
  try {
    if (!/^pi_[A-Za-z0-9_]{1,80}$/.test(created.id)) return { kind: "unavailable", why: "unexpected PaymentIntent id" };
    const r = await fetchStripeWithTimeout(
      deps.fetchFn,
      `${deps.apiBase}/payment_intents/${created.id}?expand[]=latest_charge`,
      { method: "GET", headers: { Authorization: `Basic ${deps.basicAuth}` } },
      deps.timeoutMs ?? PAID_CHECK_TIMEOUT_MS,
    );
    if (!r.ok) return { kind: "unavailable", why: `Stripe retrieve answered HTTP ${r.status}` };
    const v = evaluatePaymentIntent(await r.json());
    if (v === "paid_succeeded" || v === "paid_processing") {
      return { kind: "paid", reason: v === "paid_processing" ? "processing" : "succeeded", paymentIntentId: created.id, hasOrderRow: false };
    }
    return { kind: "not_paid" };
  } catch (e) {
    log(`[create-payment-intent] gh-3356: replay re-read failed (${e instanceof Error ? e.name : typeof e})`);
    return { kind: "unavailable", why: "replay re-read threw" };
  }
}

/** The refusal's HTTP shape. 409 for "already paid" (a conflict, not a malformed request), 503 for "could not check". */
export function refusalFor(verdict: PaidVerdict): { status: number; body: { error: string; code: string } } | null {
  if (verdict.kind === "paid") return { status: 409, body: { error: ALREADY_PAID_ERROR, code: ALREADY_PAID_CODE } };
  if (verdict.kind === "unavailable") return { status: 503, body: { error: PAID_CHECK_UNAVAILABLE_ERROR, code: PAID_CHECK_UNAVAILABLE_CODE } };
  return null;
}
