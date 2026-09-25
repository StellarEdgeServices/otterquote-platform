// gh-1886: bounded timeout wrapper for the live Stripe fetch() calls in index.ts
// (platform_fee off-session create, its best-effort cancel, and the standard-flow
// create). None of the three previously carried a `signal:`, so a slow or hung
// connection to api.stripe.com held the Edge Function open with no bound -- see
// the #1886 thread (CEO57 triage comment, 2026-09-21) for the live-code confirmation.
//
// AbortController is used directly rather than the shorthand AbortSignal.timeout()
// so a test can drive the abort deterministically (a short ms budget) instead of
// waiting out a real multi-second timer, and so the resulting rejection is always
// a plain Error subclass -- never a raw DOMException -- for callers to match on.
export const STRIPE_FETCH_TIMEOUT_MS = 20_000; // Kevin's proposed default (#1886 comment, 2026-09-08): well under a typical
// 30s client timeout, far above Stripe's p99 response time.

export class StripeFetchTimeoutError extends Error {
  constructor(ms: number) {
    super(`Stripe request timed out after ${ms}ms`);
    this.name = "StripeFetchTimeoutError";
  }
}

/**
 * Runs fetchFn(url, init) with an AbortSignal that fires after timeoutMs, mapping an
 * abort to a StripeFetchTimeoutError (a normal Error) rather than letting the raw
 * AbortError/DOMException surface. Success behaviour (the resolved Response, its
 * status, its body) is completely unchanged -- this only bounds how long a caller
 * can be left waiting when Stripe (or the network) does not answer.
 */
export async function fetchStripeWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = STRIPE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new StripeFetchTimeoutError(timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// gh-1886 B1 (independent review on #2198, 2026-09-25): worst-case wall time across the off-session
// multi-method loop. Bounds the WHOLE loop (not just each call) so a claim with several payment methods
// on file cannot run past Supabase's ~150s Edge Function wall-clock limit and end in a raw 504 instead of
// this function's own clean 500. 100s leaves headroom for the DB reads/writes around the loop.
export const OFF_SESSION_LOOP_BUDGET_MS = 100_000;

export class AmbiguousChargeOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousChargeOutcomeError";
  }
}

/**
 * gh-1886 B1 (independent review on #2198, 2026-09-25): fetchStripeWithTimeout is safe for a call whose
 * timing out changes nothing at Stripe (the standard-flow create, the best-effort cancel). It is NOT safe,
 * on its own, for a CONFIRMED charge (off_session=true, confirm=true): a 20s abort here does not cancel
 * anything at Stripe, it only stops this function waiting for the answer, so a "timeout" can mean Stripe
 * already charged the card or bank account. Falling through to a DIFFERENT payment method after that
 * (the pre-fix behaviour) can double-charge, because the two methods' Idempotency-Keys never collide.
 *
 * This wraps exactly one idempotent CREATE call: on a first timeout it retries the SAME request (same
 * Idempotency-Key, same body, same headers) ONCE. Stripe's documented idempotent replay then returns the
 * ORIGINAL response if the first attempt actually completed -- so a slow-but-successful create is
 * recovered as a normal response, not lost. If the retry ALSO times out, the outcome is unknowable from
 * here (charged once? twice? not at all?), and this throws AmbiguousChargeOutcomeError so the CALLER stops
 * instead of trying another payment method. A genuine Stripe answer (an HTTP error response, a decline, a
 * requires_action) is unambiguous -- Stripe DID respond -- and is returned exactly as fetchStripeWithTimeout
 * would return it, so that path is byte-for-byte unchanged.
 */
export async function fetchStripeCreateWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = STRIPE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchStripeWithTimeout(fetchFn, url, init, timeoutMs);
  } catch (e) {
    if (!(e instanceof StripeFetchTimeoutError)) throw e;
    try {
      // Same Idempotency-Key, same body: a documented Stripe idempotent replay, not a second charge attempt.
      return await fetchStripeWithTimeout(fetchFn, url, init, timeoutMs);
    } catch (e2) {
      if (e2 instanceof StripeFetchTimeoutError) {
        throw new AmbiguousChargeOutcomeError(
          "Stripe request timed out twice in a row for the same payment method (the Idempotency-Key retry " +
            "also timed out). The charge outcome for this method is unknown, so no other payment method will " +
            "be attempted.",
        );
      }
      throw e2;
    }
  }
}
