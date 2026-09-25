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
