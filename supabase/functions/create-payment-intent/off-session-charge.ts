/**
 * [gh-1886 B1/B2, independent review on #2198, 2026-09-25] The off-session contractor platform-fee
 * multi-method charge loop, extracted for testability -- the same reasoning live-charge-guard.ts and
 * measurement-upgrade-gate.ts give for themselves: money-path logic should be drivable with a fake Stripe
 * and no network, database or Supabase Edge runtime, so the property that matters can actually be pinned
 * with a test rather than argued about in a PR description.
 *
 * B1: a timeout on a CONFIRMED create (off_session=true, confirm=true) does not mean Stripe did not charge
 * the card or bank account -- it only means this function stopped waiting for the answer. The pre-fix loop
 * treated a timeout exactly like a genuine decline and moved on to the NEXT payment method, which is a
 * double-charge vector: the two methods' Idempotency-Keys never collide, so nothing dedupes "method A,
 * unanswered" against "method B, answered".
 *
 * [gh-1886 re-review #2, independent review on #2198, 2026-09-25T22:02:35Z] The FIRST rework (head
 * ba263c4e) only classified a DOUBLE TIMEOUT as ambiguous; a 409 idempotency_error on the same-key retry
 * (Stripe still processing the first attempt), a 429, any 5xx, or a thrown network error after the request
 * was sent all still fell through `!r.ok -> continue` / `catch -> continue` to the NEXT method -- three
 * more double-charge routes, reproduced in off-session-charge.test.ts. Every one of those cases is now
 * classified as ambiguous by fetchStripeCreateWithRetry (see stripe-fetch.ts), so this module's own
 * `!r.ok -> continue` path is reached ONLY for a decisive Stripe answer -- unchanged from before this
 * rework -- and an ambiguous outcome always propagates out of the WHOLE loop as
 * AmbiguousChargeOutcomeError instead.
 *
 * [gh-1886 re-review #2, N1] The overall wall-clock budget (OFF_SESSION_LOOP_BUDGET_MS) is now a genuine
 * HARD ceiling: the create's own timeout, its internal same-key retry, and the best-effort cancel are each
 * capped to whatever time is actually left before the deadline, recomputed live -- not a fixed per-call
 * budget regardless of how close to the deadline the method started.
 */
import {
  AmbiguousChargeOutcomeError,
  fetchStripeCreateWithRetry,
  fetchStripeWithTimeout,
  OFF_SESSION_LOOP_BUDGET_MS,
  STRIPE_FETCH_TIMEOUT_MS,
} from "./stripe-fetch.ts";

export { AmbiguousChargeOutcomeError };

export interface PaymentMethodAttempt {
  stripe_payment_method_id: string;
  payment_type: string;
  id: string | null;
}

export interface OffSessionChargeArgs {
  fetchFn: typeof fetch;
  apiBase: string;
  basicAuth: string;
  claimId: string;
  contractorId: string;
  stripeCustomerId: string;
  currency: string;
  description?: string | null;
  /** The platform fee in cents, before any card surcharge. */
  amount: number;
  methodsToTry: PaymentMethodAttempt[];
  calculateCardChargeAmount: (platformFeeCents: number) => number;
  /** Per-call Stripe timeout budget, ms. Defaults to STRIPE_FETCH_TIMEOUT_MS. Every individual call
   *  (create, its retry, the cancel) is additionally capped to whatever remains of loopBudgetMs. */
  timeoutMs?: number;
  /** Overall wall-clock budget for the WHOLE loop, ms. Defaults to OFF_SESSION_LOOP_BUDGET_MS (gh-1886 N1). */
  loopBudgetMs?: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface OffSessionChargeResult {
  // deno-lint-ignore no-explicit-any
  paymentIntentData: any;
  usedMethod: PaymentMethodAttempt;
  chargedAmount: number;
  cardFeeCents: number;
}

/**
 * Try each payment method in order until one produces a CONFIRMED PaymentIntent. Throws
 * AmbiguousChargeOutcomeError (gh-1886 B1) rather than trying another method when a method's create
 * outcome is ambiguous (a timeout, a 409/429/5xx, or a thrown network error) twice in a row; throws a
 * plain Error ("All N payment methods failed...") if every method was tried and every one gave a decisive
 * decline; throws a plain Error ("... loop deadline ...") if the overall wall clock budget (gh-1886 N1) is
 * exhausted before every method could be tried.
 */
export async function runOffSessionPlatformFeeCharge(a: OffSessionChargeArgs): Promise<OffSessionChargeResult> {
  const timeoutMs = a.timeoutMs ?? STRIPE_FETCH_TIMEOUT_MS;
  const loopBudgetMs = a.loopBudgetMs ?? OFF_SESSION_LOOP_BUDGET_MS;
  const now = a.now ?? Date.now;
  const deadlineAt = now() + loopBudgetMs;
  // gh-1886 re-review #2 (N1): polled live, not computed once -- every capped timeout below reflects
  // exactly how much of the overall budget is left AT THAT MOMENT, not at loop start.
  const remaining = () => deadlineAt - now();

  let lastError = "";
  for (const method of a.methodsToTry) {
    // gh-1886 N1: stop trying MORE methods once the overall budget is spent, rather than risk the whole
    // request running past Supabase's wall-clock limit. A method already in flight is not interrupted by
    // this check; it only gates starting the NEXT one.
    if (remaining() <= 0) {
      lastError = `Off-session charge loop deadline (${loopBudgetMs}ms) reached before every payment method could be tried.`;
      break;
    }

    let thisChargeAmount = a.amount;
    let thisCardFee = 0;
    if (method.payment_type === "card") {
      thisChargeAmount = a.calculateCardChargeAmount(a.amount);
      thisCardFee = thisChargeAmount - a.amount;
    }
    const form = new URLSearchParams();
    form.append("amount", String(thisChargeAmount));
    form.append("currency", a.currency);
    form.append("customer", a.stripeCustomerId);
    form.append("payment_method", method.stripe_payment_method_id);
    form.append("off_session", "true");
    form.append("confirm", "true");
    form.append("description", a.description || "");
    form.append("metadata[claim_id]", a.claimId);
    form.append("metadata[type]", "platform_fee");
    form.append("metadata[contractor_id]", a.contractorId);
    form.append("metadata[payment_type]", method.payment_type);
    form.append("metadata[platform_fee_cents]", String(a.amount));
    if (thisCardFee > 0) form.append("metadata[card_fee_cents]", String(thisCardFee));
    form.append("payment_method_types[]", method.payment_type === "us_bank_account" ? "us_bank_account" : "card");

    const offSessionKey = `plat-fee-${a.claimId}-${a.contractorId}-${method.stripe_payment_method_id}`;
    try {
      // gh-1886 B1 + re-review #2 (N1): fetchStripeCreateWithRetry now classifies 409/429/5xx/network-error
      // outcomes as ambiguous alongside a timeout, and caps its own timeout AND its internal same-key
      // retry to whatever remains of the overall deadline (via `remaining`, polled live).
      const { response: r, body: rd } = await fetchStripeCreateWithRetry(a.fetchFn, `${a.apiBase}/payment_intents`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${a.basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": offSessionKey,
        },
        body: form.toString(),
      }, timeoutMs, remaining);
      // Only a DECISIVE outcome reaches this line -- see the classification in stripe-fetch.ts. An
      // ambiguous one is thrown out of the `try` below instead, never returned as a normal response.
      if (!r.ok) { lastError = rd?.error?.message || `HTTP ${r.status}`; continue; }
      if (rd.status === "requires_action" || rd.status === "requires_payment_method") {
        lastError = `Payment ${rd.status} for method ${method.stripe_payment_method_id}`;
        // gh-1886 re-review #2 (N1): the cancel's own timeout is likewise capped to what remains before
        // the overall deadline. If nothing is left, skip the cancel outright rather than spend past the
        // deadline on a call that was already best-effort -- an un-cancelled requires_action PaymentIntent
        // simply expires on Stripe's side untouched, exactly as if this best-effort call had failed for
        // any other reason.
        const cancelBudget = Math.min(timeoutMs, Math.max(0, remaining()));
        if (cancelBudget > 0) {
          try {
            await fetchStripeWithTimeout(a.fetchFn, `${a.apiBase}/payment_intents/${rd.id}/cancel`, {
              method: "POST",
              headers: { Authorization: `Basic ${a.basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
            }, cancelBudget);
          } catch { /* best-effort: swallowed, exactly as before */ }
        }
        continue;
      }
      return { paymentIntentData: rd, usedMethod: method, chargedAmount: thisChargeAmount, cardFeeCents: thisCardFee };
    } catch (e) {
      // gh-1886 B1: an ambiguous outcome must NOT fall through to another method -- propagate it out of
      // the whole loop instead of treating it like a decline. fetchStripeCreateWithRetry is now the only
      // source of a thrown error on this path, and the only error type it ever throws is
      // AmbiguousChargeOutcomeError -- the explicit instanceof check is kept regardless, so any future,
      // genuinely non-ambiguous exception from this call still falls through to the NEXT method (fails
      // closed on the loop continuing, not on silently mis-treating an unrelated bug as ambiguous).
      if (e instanceof AmbiguousChargeOutcomeError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
  }
  throw new Error(`All ${a.methodsToTry.length} payment methods failed. Last error: ${lastError}`);
}
