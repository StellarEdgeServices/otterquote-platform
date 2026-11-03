/**
 * [gh-3356] Refuse a SECOND hover_measurement PaymentIntent on a claim that has already paid for its report.
 *
 * THE DEFECT. The only thing that stopped a second $22.63 charge on a paid claim was Stripe's idempotency key (Stripe may remove a key once it is at least 24 hours old; the removal time is not exact)
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
 *     legitimate. Today's behaviour is that a new intent can be created once Stripe has removed the key, so that is kept: a
 *     PaymentIntent whose charge is fully refunded and which has no rebate_paid_at is NOT counted as paid. FLAGGED in the PR for a
 *     decision. A PARTIAL refund still counts as paid (the report was bought and not wholly returned).
 *   - The refund test needs the charge, so every Stripe read here expands latest_charge. If it cannot be read as an object, the
 *     payment counts as paid (fails toward refusing).
 *
 * FAILURE POLICY (fails CLOSED, deliberately). If the order lookup or the Stripe lookup errors, times out or is not understood, no
 * PaymentIntent is created: the caller gets a 503 with a retry message and nothing has been charged. A silent "allow" would turn
 * a Stripe or database blip into the very double charge this closes. It costs a first-time buyer nothing extra during a Stripe
 * outage, because creating the PaymentIntent needs the same Stripe API. The one real cost is if Stripe's SEARCH endpoint alone
 * is unavailable or rejects the account: purchases are then blocked until it is fixed. That is why the refusal raises an alert
 * (measurement-paid-alert.ts: a platform_alerts_log row and an admin email, bounded per claim) and why the PR asks the CEO whether
 * to accept that trade.
 *
 * RESIDUAL (not closed here, stated so nobody calls #3356 fully closed by this alone): Stripe search is eventually consistent, normally
 * under a minute and up to about an hour in an outage. A payment that succeeded moments ago, with NO order row yet, and whose
 * idempotency key has already expired (an intent created long before, paid now from a stale tab), is invisible to the
 * pre-create check, so a reload in that window can still be given a new intent. While the key is still held the replay re-read
 * (assertCreatedIntentNotPaid) covers it. Closing the rest needs a payment record written at confirm time, which is a separate change.
 *
 * OLDER UNPAID INTENTS (cancelSupersededIntents). A stale tab holds the client_secret of an older, unpaid intent that stays payable
 * after a newer one succeeds. Once this request has its intent (the one the keyed create returned, possibly a replay), the OTHER unpaid
 * intents the search returned for this claim are cancelled, best effort: only those still in requires_payment_method or
 * requires_confirmation when re-read just before the cancel, never one in requires_action (a 3-D Secure step may be open in another
 * tab) or processing. A cancel that fails never stops the purchase. If Stripe answers a cancel by saying the intent has since
 * succeeded or is processing (a confirm in another tab won the race), that is a paid claim and the new intent is NOT handed back.
 * The residual of this step: an intent not yet indexed by search is not seen, and at most MAX_CANCELS are tried per request.
 *
 * Pure of the Supabase client and of `fetch`: both are injected so the harness in idempotent-retry.test.ts drives the real code
 * against a fake Stripe.
 */
import { fetchStripeJsonWithTimeout } from "./stripe-fetch.ts";
import { UPGRADE_PRODUCT_CODE } from "./measurement-upgrade-gate.ts";

export const ALREADY_PAID_CODE = "MEASUREMENT_ALREADY_PAID";
export const PAID_CHECK_UNAVAILABLE_CODE = "MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE";
export const CANCELLED_REPLAY_CODE = "MEASUREMENT_PAYMENT_CANNOT_START";

/** Technical text for logs and the `error` field. The customer-facing sentences live in help-measurements.html, keyed by `code`. */
export const ALREADY_PAID_ERROR = "A report has already been paid for on this claim; no new payment was created.";
export const PAID_CHECK_UNAVAILABLE_ERROR = "Could not confirm whether this claim has already paid for its report; no payment was created. Retry shortly.";
export const CANCELLED_REPLAY_ERROR = "The payment for this report that the idempotency key returns has been cancelled; no new payment was created.";

/** Replayed creates older than this are re-read from Stripe (a replay returns the FIRST response, whose status can be stale). */
export const REPLAY_AGE_SECONDS = 60;
export const PAID_CHECK_TIMEOUT_MS = 8000;

export interface HoverOrderRow {
  homeowner_stripe_payment_intent_id: string | null;
  product_code: string | null;
  rebate_paid_at: string | null;
}

/** order_row: an order names a PaymentIntent Stripe says does not exist (404). The order row is proof of payment (see the header), so it counts. */
export type PaidReason = "rebated_order" | "succeeded" | "processing" | "order_row";

export type PaidVerdict =
  /** `cancelable`: unpaid intents of this claim the search returned (candidates for cancelSupersededIntents). */
  | { kind: "not_paid"; cancelable?: string[] }
  /** `hasOrderRow` false means "raise the paid-without-order alert". It is always determined from the claim's hover_orders rows (never assumed), including for an older intent found paid while superseding (supersededPaidVerdict). */
  | { kind: "paid"; reason: PaidReason; paymentIntentId: string | null; hasOrderRow: boolean }
  | { kind: "unavailable"; why: string }
  /**
   * The keyed create REPLAYED an intent that Stripe now reports as cancelled (a price that went A -> B -> A inside the key's life, or
   * a person cancelling it in the Stripe dashboard). Its client_secret is dead and the same key replays it again, so this buyer
   * cannot start a payment at this price until Stripe drops the key. Not a failed lookup: it has its own code, sentence and alert.
   */
  | { kind: "cancelled_replay"; paymentIntentId: string };

/** The columns create-payment-intent reads from hover_orders. A test checks each against the migrations: a wrong name here is a 503 for every buyer. */
export const HOVER_ORDER_SELECT = "homeowner_stripe_payment_intent_id, product_code, rebate_paid_at";

/** Reads the claim's hover_orders rows that name a PaymentIntent. `sb` is the service-role Supabase client. */
export async function loadHoverOrders(
  // deno-lint-ignore no-explicit-any
  sb: any,
  claimId: string,
): Promise<{ rows: HoverOrderRow[] | null; error: unknown }> {
  const { data, error } = await sb
    .from("hover_orders")
    .select(HOVER_ORDER_SELECT)
    .eq("claim_id", claimId)
    .not("homeowner_stripe_payment_intent_id", "is", null);
  return { rows: data ?? null, error };
}

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

    // Stripe search: paid-with-no-order is found here. Eventually consistent: see RESIDUAL in the header.
    const query = `metadata['claim_id']:'${deps.claimId}' AND metadata['type']:'hover_measurement'`;
    const searchUrl = `${deps.apiBase}/payment_intents/search?query=${encodeURIComponent(query)}&limit=100&expand[]=data.latest_charge`;
    const sr = await fetchStripeJsonWithTimeout(deps.fetchFn, searchUrl, { method: "GET", headers }, timeout);
    if (!sr.response.ok) return { kind: "unavailable", why: `Stripe search answered HTTP ${sr.response.status}` };
    const found = sr.body;
    if (!found || !Array.isArray(found.data)) return { kind: "unavailable", why: "Stripe search answer not understood" };

    const seen = new Map<string, Pi>();
    for (const pi of found.data) if (pi && typeof pi.id === "string") seen.set(pi.id, pi);

    // An order's PaymentIntent that search did not return (lag, or a PaymentIntent created without the metadata): read it directly.
    for (const id of orderPiIds) {
      if (seen.has(id)) continue;
      if (!/^pi_[A-Za-z0-9_]{1,80}$/.test(id)) return { kind: "unavailable", why: "an order carries an unexpected PaymentIntent id" };
      const r = await fetchStripeJsonWithTimeout(deps.fetchFn, `${deps.apiBase}/payment_intents/${id}?expand[]=latest_charge`, { method: "GET", headers }, timeout);
      if (r.response.status === 404) {
        // The order row is proof of payment (it was written only after a succeeded PaymentIntent was seen). Stripe not knowing the id
        // (another mode or account, a deleted test object) must not become a permanent 503 for this claim.
        return { kind: "paid", reason: "order_row", paymentIntentId: id, hasOrderRow: true };
      }
      if (!r.response.ok) return { kind: "unavailable", why: `Stripe retrieve answered HTTP ${r.response.status}` };
      seen.set(id, r.body);
    }

    // More than one page of intents for one claim is not a case this check can see all of: do not guess.
    const unpaged = found.has_more === true;

    const cancelable: string[] = [];
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
      if ((pi.status === "requires_payment_method" || pi.status === "requires_confirmation") &&
          pi.metadata?.claim_id === deps.claimId && pi.metadata?.type === "hover_measurement") {
        cancelable.push(id);
      }
    }
    if (unpaged) return { kind: "unavailable", why: "Stripe search returned more than one page" };
    return { kind: "not_paid", cancelable };
  } catch (e) {
    // The thrown text can carry a URL or Stripe's wording: log the class only.
    log(`[create-payment-intent] gh-3356: paid-claim check failed (${e instanceof Error ? e.name : typeof e})`);
    return { kind: "unavailable", why: "paid-claim check threw" };
  }
}

export const MAX_CANCELS = 3;
export const CANCEL_TIMEOUT_MS = 3000;
export const CANCEL_BUDGET_MS = 6000;

export interface CancelOutcome {
  cancelled: string[];
  /** left alone: requires_action, already canceled, or the intent being handed to the buyer */
  skipped: number;
  /** a read or cancel that failed; the purchase goes ahead */
  failed: number;
  /** set when Stripe says an older intent has since succeeded or is processing: the caller must refuse */
  paid: { id: string } | null;
}

/**
 * Best-effort cancel of the claim's OTHER unpaid intents (see OLDER UNPAID INTENTS in the header). Never throws.
 * `keepId` is the intent this request is handing to the buyer (the keyed create's answer, a replay or a new one): never cancelled.
 */
export async function cancelSupersededIntents(
  deps: Pick<PaidGateDeps, "fetchFn" | "apiBase" | "basicAuth" | "log">,
  candidates: string[],
  keepId: string,
  now: () => number = () => Date.now(),
): Promise<CancelOutcome> {
  const out: CancelOutcome = { cancelled: [], skipped: 0, failed: 0, paid: null };
  const log = deps.log ?? ((m: string) => console.error(m));
  const started = now();
  const ids = [...new Set(candidates)].filter((id) => id !== keepId).slice(0, MAX_CANCELS);
  for (const id of ids) {
    if (now() - started > CANCEL_BUDGET_MS) { out.failed++; continue; }
    try {
      if (!/^pi_[A-Za-z0-9_]{1,80}$/.test(id)) { out.failed++; continue; }
      const auth = { Authorization: `Basic ${deps.basicAuth}` };
      // Re-read just before the cancel: the search result may be stale (a confirm may have started since).
      const cur = await fetchStripeJsonWithTimeout(deps.fetchFn, `${deps.apiBase}/payment_intents/${id}?expand[]=latest_charge`, { method: "GET", headers: auth }, CANCEL_TIMEOUT_MS);
      if (!cur.response.ok) { out.failed++; continue; }
      const verdict = evaluatePaymentIntent(cur.body);
      if (verdict === "paid_succeeded" || verdict === "paid_processing") { out.paid = { id }; return out; }
      if (cur.body?.status !== "requires_payment_method" && cur.body?.status !== "requires_confirmation") { out.skipped++; continue; }
      const c = await fetchStripeJsonWithTimeout(
        deps.fetchFn,
        `${deps.apiBase}/payment_intents/${id}/cancel`,
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `hover-supersede-${id}` },
          body: "cancellation_reason=abandoned",
        },
        CANCEL_TIMEOUT_MS,
      );
      if (c.response.ok) { out.cancelled.push(id); continue; }
      const st = c.body?.error?.payment_intent?.status;
      if (st === "succeeded" || st === "processing") { out.paid = { id }; return out; } // a confirm in another tab won the race
      out.failed++;
    } catch (e) {
      out.failed++;
      log(`[create-payment-intent] gh-3356: superseded-intent cancel failed (${e instanceof Error ? e.name : typeof e})`);
    }
  }
  return out;
}

/**
 * The post-create check, for the window while Stripe still holds the key. A reused Idempotency-Key returns the FIRST response, so a PaymentIntent
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
    const r = await fetchStripeJsonWithTimeout(
      deps.fetchFn,
      `${deps.apiBase}/payment_intents/${created.id}?expand[]=latest_charge`,
      { method: "GET", headers: { Authorization: `Basic ${deps.basicAuth}` } },
      deps.timeoutMs ?? PAID_CHECK_TIMEOUT_MS,
    );
    if (!r.response.ok) return { kind: "unavailable", why: `Stripe retrieve answered HTTP ${r.response.status}` };
    const v = evaluatePaymentIntent(r.body);
    if (v === "paid_succeeded" || v === "paid_processing") {
      return { kind: "paid", reason: v === "paid_processing" ? "processing" : "succeeded", paymentIntentId: created.id, hasOrderRow: false };
    }
    // A replayed intent that has been CANCELLED is dead: Stripe will refuse the buyer's card on it. This happens when the price goes
    // A -> B -> A inside the key's life (the key carries the amount): the create for A replays the first A intent, which the B request
    // superseded. Do not hand it back, and do not let the caller run its cancels (the only LIVE intent is the B one).
    if (r.body?.status === "canceled") return { kind: "cancelled_replay", paymentIntentId: created.id };
    // A replayed intent that SUCCEEDED but is fully refunded (evaluatePaymentIntent: "refunded", not paid for the gate's purposes) must not
    // be handed back either, whatever its refund state: its secret cannot be paid again, and the page's recovery of a succeeded intent
    // would record an order for a refunded charge. Refuse with the retry path (503, "could not check ... try again"; the attempt charged
    // nothing). A buyer whose payment was refunded outside the rebate flow can buy again once Stripe has removed the key.
    if (r.body?.status === "succeeded") return { kind: "unavailable", why: REPLAY_REFUNDED_WHY };
    return { kind: "not_paid" };
  } catch (e) {
    log(`[create-payment-intent] gh-3356: replay re-read failed (${e instanceof Error ? e.name : typeof e})`);
    return { kind: "unavailable", why: "replay re-read threw" };
  }
}

/**
 * Which operator alert a refusal raises, if any. NO grace period: the first refused request alerts, whatever the charge's age (the
 * email tells the operator that a very recent charge may still be waiting for its order row, so they check the row before acting).
 * Bounded per claim and kind in measurement-paid-alert.ts.
 */
export function alertKindFor(v: PaidVerdict): "paid_without_order" | "check_unavailable" | "cancelled_replay" | null {
  if (v.kind === "unavailable") return "check_unavailable";
  if (v.kind === "cancelled_replay") return "cancelled_replay"; // a homeowner is stuck: a person must know
  if (v.kind === "paid" && !v.hasOrderRow) return "paid_without_order";
  return null;
}

/** `why` of the unavailable verdict for a replayed intent that succeeded and was fully refunded (see assertCreatedIntentNotPaid). */
export const REPLAY_REFUNDED_WHY = "replayed intent succeeded and was refunded";

/**
 * The verdict for an OLDER intent that cancelSupersededIntents found paid (a confirm in another tab won the race). Whether an order row
 * exists for THAT intent is read from the claim's hover_orders rows, not assumed: a paid homeowner with no order row must alert on this
 * refusal too (alertKindFor). If the orders read fails, hasOrderRow is false (fail toward telling the operator; the alert is bounded).
 */
export async function supersededPaidVerdict(
  deps: Pick<PaidGateDeps, "loadOrders" | "log">,
  paidIntentId: string,
): Promise<PaidVerdict> {
  let hasOrderRow = false;
  try {
    const { rows, error } = await deps.loadOrders();
    if (!error && Array.isArray(rows)) hasOrderRow = rows.some((r) => r.homeowner_stripe_payment_intent_id === paidIntentId && r.product_code !== UPGRADE_PRODUCT_CODE);
  } catch (_e) {
    (deps.log ?? ((m: string) => console.error(m)))("[create-payment-intent] gh-3356: orders read for a superseded paid intent threw");
  }
  return { kind: "paid", reason: "processing", paymentIntentId: paidIntentId, hasOrderRow };
}

/** The refusal's HTTP shape. 409 for "already paid" (a conflict, not a malformed request), 503 for "could not check" and for a cancelled replay (its own code). */
export function refusalFor(verdict: PaidVerdict): { status: number; body: { error: string; code: string } } | null {
  if (verdict.kind === "paid") return { status: 409, body: { error: ALREADY_PAID_ERROR, code: ALREADY_PAID_CODE } };
  if (verdict.kind === "unavailable") return { status: 503, body: { error: PAID_CHECK_UNAVAILABLE_ERROR, code: PAID_CHECK_UNAVAILABLE_CODE } };
  if (verdict.kind === "cancelled_replay") return { status: 503, body: { error: CANCELLED_REPLAY_ERROR, code: CANCELLED_REPLAY_CODE } };
  return null;
}
