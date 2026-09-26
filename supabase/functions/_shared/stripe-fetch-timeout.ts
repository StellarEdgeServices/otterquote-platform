// gh-2121 (HO-3) / PR #2226 REVIEW D14: a byte-identical copy of
// create-payment-intent/stripe-fetch.ts's fetchStripeWithTimeout (and its
// timeout constant and error class), placed in _shared/ because this repo's
// Edge Functions do not import across function directories -- only _shared/
// is shared (see stripe-fetch.ts's own note). The HO-3 functions that call
// Stripe (create-lead-payment-intent, create-lead-measurement-order) import it
// from here. stripe-fetch-timeout.test.ts fails if this copy and the original
// ever drift apart.
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
