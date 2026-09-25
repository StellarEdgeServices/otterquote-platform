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

/**
 * [gh-1886 re-review #2 fix, independent review on #2198, 2026-09-25T22:02:35Z -- "N1"] Like
 * fetchStripeWithTimeout, but keeps the SAME abort budget alive through `response.json()`, not just
 * through the headers arriving. fetchStripeWithTimeout on its own clears its timer the instant fetchFn's
 * promise resolves (headers received) -- a stalled BODY stream after that point had no bound at all
 * (flagged as part of N1). Used by fetchStripeCreateWithRetry, whose caller (off-session-charge.ts) needs
 * the parsed body anyway -- this also removes a separate, previously-unbounded `await r.json()` there.
 */
export async function fetchStripeJsonWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = STRIPE_FETCH_TIMEOUT_MS,
  // deno-lint-ignore no-explicit-any
): Promise<{ response: Response; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    const body = await response.json();
    return { response, body };
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
//
// [gh-1886 re-review #2, independent review on #2198, 2026-09-25T22:02:35Z -- "N1"] This is now a genuine
// HARD ceiling on the loop, not just a start-of-method gate: off-session-charge.ts caps every individual
// timeout (create, its same-key retry, and the best-effort cancel) to whatever time is actually left
// before this deadline, recomputed live at the start of each one. Total loop wall time can therefore never
// run past this budget by more than a small scheduling epsilon -- the reviewer's finding (a method
// starting near the deadline could still spend a further create+retry+cancel timeout beyond it, ~160s
// total against Supabase's 150s limit) was structural, not fixable by only shrinking this constant.
export const OFF_SESSION_LOOP_BUDGET_MS = 100_000;

// [gh-1886 re-review #2 fix, independent review on #2198, 2026-09-25T22:02:35Z -- "B1-c"] Mirrored
// VERBATIM as a literal string constant in docusign-webhook/index.ts: Supabase Edge Functions cannot
// import across function directories (see live-charge-guard.ts's byte-identical-copies precedent, and its
// tools/live_charge_guard_parity_check.py, for the same constraint on a different file). MUST be changed
// in both places if it is ever changed.
export const AMBIGUOUS_OUTCOME_CODE = "PLATFORM_FEE_CHARGE_OUTCOME_UNKNOWN";

export class AmbiguousChargeOutcomeError extends Error {
  /** The Idempotency-Key of the payment method whose true outcome is unknown. */
  idempotencyKey: string;
  constructor(message: string, idempotencyKey: string) {
    super(message);
    this.name = "AmbiguousChargeOutcomeError";
    this.idempotencyKey = idempotencyKey;
  }
}

interface CreateAttemptResult {
  response: Response;
  // deno-lint-ignore no-explicit-any
  body: any;
}

type AttemptOutcome =
  | { kind: "decisive"; result: CreateAttemptResult }
  | { kind: "ambiguous"; reason: string };

/**
 * [gh-1886 re-review #2, independent review on #2198, 2026-09-25T22:02:35Z -- "B1-a/B1-b"] A Stripe HTTP
 * status that WAS received (no timeout, no thrown error) is "ambiguous" -- NOT proof of a decline -- when
 * it is:
 *   - 409: Stripe's own idempotency_error for "another request using this Idempotent Key is still in
 *     progress". This means Stripe has not finished processing the FIRST attempt yet -- the opposite of a
 *     decisive answer.
 *   - 429: rate limited. Stripe never actually evaluated this attempt.
 *   - any 5xx: Stripe's own documented "indeterminate outcome" status class.
 * Anything else -- a 402 card_error, or any other 4xx (a malformed/invalid request Stripe rejected before
 * ever attempting to charge it) -- is decisive: Stripe gave a final answer about this specific attempt.
 */
function isAmbiguousStatus(status: number): boolean {
  return status === 409 || status === 429 || status >= 500;
}

/**
 * [gh-1886 re-review #2, independent review on #2198, 2026-09-25T22:02:35Z -- fix for B1-a/B1-b/B1-c]
 * Wraps exactly one idempotent CREATE call under the policy the re-review requires: EVERY non-definitive
 * outcome after the create request may have reached Stripe is treated as ambiguous, never as a decline --
 *   - a timeout (no answer at all),
 *   - a 409 idempotency_error (another attempt under this key is still in flight at Stripe -- this is
 *     exactly what a same-key retry sent 20s after a still-processing first attempt gets back),
 *   - a 429 (rate limited -- Stripe never evaluated this attempt),
 *   - any 5xx (Stripe's own "indeterminate" status class),
 *   - any OTHER thrown error once fetchFn has been called (a connection reset, etc.) -- this wrapper
 *     cannot prove such an error happened before Stripe ever received the request, so it is not assumed
 *     to be safe either.
 * On a first ambiguous outcome, retries the SAME request once (same Idempotency-Key, same body, same
 * headers) -- Stripe's documented idempotent replay then returns the ORIGINAL response if the first
 * attempt actually reached and was processed by Stripe. If the retry is ALSO ambiguous, the true outcome
 * is unknowable from here, and this throws AmbiguousChargeOutcomeError so the CALLER stops instead of
 * trying another payment method. Only a definitive Stripe answer -- a decisive decline, or a genuine
 * succeeded/requires_action/requires_payment_method body on a 2xx -- is ever returned to the caller.
 *
 * getRemainingMs, when given, is polled immediately before EACH attempt (not just once, up front) and
 * caps that attempt's own timeout to whatever is actually left -- the hard-deadline fix for N1: neither
 * this function's own internal retry, nor the caller's subsequent cancel (which does its own capping),
 * can individually run past the caller's overall deadline; each can only spend up to whatever time
 * remains at the moment it starts. If nothing is left when an attempt would start, that attempt is not
 * even sent -- it counts as ambiguous immediately ("deadline exhausted"), never as a decline.
 */
export async function fetchStripeCreateWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = STRIPE_FETCH_TIMEOUT_MS,
  getRemainingMs?: () => number,
): Promise<CreateAttemptResult> {
  const attempt = async (): Promise<AttemptOutcome> => {
    const budget = getRemainingMs ? Math.max(0, Math.min(timeoutMs, getRemainingMs())) : timeoutMs;
    if (budget <= 0) {
      return { kind: "ambiguous", reason: "overall deadline exhausted before this attempt could be sent" };
    }
    try {
      const result = await fetchStripeJsonWithTimeout(fetchFn, url, init, budget);
      if (isAmbiguousStatus(result.response.status)) {
        return { kind: "ambiguous", reason: `HTTP ${result.response.status}` };
      }
      return { kind: "decisive", result };
    } catch (e) {
      return { kind: "ambiguous", reason: e instanceof Error ? e.message : String(e) };
    }
  };

  const first = await attempt();
  if (first.kind === "decisive") return first.result;
  const second = await attempt();
  if (second.kind === "decisive") return second.result;

  const key = (init.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? "(no key)";
  throw new AmbiguousChargeOutcomeError(
    `Stripe create outcome is ambiguous for Idempotency-Key ${key} even after a same-key retry ` +
      `(first attempt: ${first.reason}; retry: ${second.reason}). The charge outcome for this payment ` +
      `method is unknown, so no other payment method will be attempted. code=${AMBIGUOUS_OUTCOME_CODE}`,
    key,
  );
}
