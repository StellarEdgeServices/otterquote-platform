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
 * unanswered" against "method B, answered". This module's contract is the fix: a create timeout is retried
 * on the SAME method once, under the SAME Idempotency-Key (see fetchStripeCreateWithRetry in
 * stripe-fetch.ts) -- Stripe's documented idempotent replay then returns the original outcome if the first
 * attempt actually completed. If the retry ALSO times out, the whole attempt stops (throwing
 * AmbiguousChargeOutcomeError) rather than trying method B.
 *
 * A genuine Stripe answer -- an HTTP error response, or a requires_action/requires_payment_method result --
 * is unambiguous (Stripe DID respond) and behaves exactly as before: try the next method. That is the
 * property "Keep genuine declines behaving exactly as before" from the review, and it is why this module
 * still returns/continues on those paths precisely as the original inline loop did.
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
  /** Per-call Stripe timeout budget, ms. Defaults to STRIPE_FETCH_TIMEOUT_MS. */
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
 * AmbiguousChargeOutcomeError (gh-1886 B1) rather than trying another method when a method's create times
 * out twice in a row; throws a plain Error ("All N payment methods failed...") if every method was tried
 * and every one gave a genuine decline; throws a plain Error ("... loop deadline ...") if the overall wall
 * clock budget (gh-1886 N1) is exhausted before every method could be tried.
 */
export async function runOffSessionPlatformFeeCharge(a: OffSessionChargeArgs): Promise<OffSessionChargeResult> {
  const timeoutMs = a.timeoutMs ?? STRIPE_FETCH_TIMEOUT_MS;
  const loopBudgetMs = a.loopBudgetMs ?? OFF_SESSION_LOOP_BUDGET_MS;
  const now = a.now ?? Date.now;
  const deadlineAt = now() + loopBudgetMs;

  let lastError = "";
  for (const method of a.methodsToTry) {
    // gh-1886 N1: stop trying MORE methods once the overall budget is spent, rather than risk the whole
    // request running past Supabase's wall-clock limit. A method already in flight is not interrupted by
    // this check; it only gates starting the NEXT one.
    if (now() >= deadlineAt) {
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
      // gh-1886 B1: retry-same-key-once on timeout; never a different method on an ambiguous outcome.
      const r = await fetchStripeCreateWithRetry(a.fetchFn, `${a.apiBase}/payment_intents`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${a.basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": offSessionKey,
        },
        body: form.toString(),
      }, timeoutMs);
      const rd = await r.json();
      if (!r.ok) { lastError = rd?.error?.message || `HTTP ${r.status}`; continue; }
      if (rd.status === "requires_action" || rd.status === "requires_payment_method") {
        lastError = `Payment ${rd.status} for method ${method.stripe_payment_method_id}`;
        try {
          // Best-effort cancel: a genuine (unambiguous) requires_action/requires_payment_method result, not
          // a timeout, so falling through to the next method here is unchanged from before this PR.
          await fetchStripeWithTimeout(a.fetchFn, `${a.apiBase}/payment_intents/${rd.id}/cancel`, {
            method: "POST",
            headers: { Authorization: `Basic ${a.basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
          }, timeoutMs);
        } catch { /* best-effort: swallowed, exactly as before */ }
        continue;
      }
      return { paymentIntentData: rd, usedMethod: method, chargedAmount: thisChargeAmount, cardFeeCents: thisCardFee };
    } catch (e) {
      // gh-1886 B1: an ambiguous (twice-timed-out) outcome must NOT fall through to another method --
      // propagate it out of the whole loop instead of treating it like a decline.
      if (e instanceof AmbiguousChargeOutcomeError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
  }
  throw new Error(`All ${a.methodsToTry.length} payment methods failed. Last error: ${lastError}`);
}
