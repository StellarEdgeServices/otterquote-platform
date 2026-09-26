/**
 * [gh-1886 re-review #2, independent review on #2198, 2026-09-25T22:02:35Z -- "B1-c"] Pure classification
 * of a non-ok response from create-payment-intent's platform_fee branch, extracted for testability -- the
 * same reasoning live-charge-guard.ts, price-verify.ts and ack-verify.ts give for themselves: a money-path
 * decision should be unit-testable without a network or a live webhook call.
 *
 * WHY THIS EXISTS. Before this fix, ANY non-2xx, non-422-guard-refusal response from create-payment-intent
 * was bucketed as `hard_failure`, which routes into dunning (marks the quote "dunning", inserts a
 * `payment_failures` row, and POSTs process-dunning). That was correct for a genuine decline, but
 * create-payment-intent can also fail with an AMBIGUOUS outcome (gh-1886 B1: a timeout, a 409
 * idempotency_error, a 429, a 5xx, or a network error whose Stripe-side effect is unknown) -- Stripe may
 * already have charged the contractor. Routing THAT into dunning is a double-charge: process-dunning
 * charges Stripe DIRECTLY on retry, under a DIFFERENT Idempotency-Key
 * (`dunning-<quote_id>-<payment_method>`, which never collides with
 * `plat-fee-<claim_id>-<contractor_id>-<payment_method>`), with no human in the loop.
 *
 * classifyPlatformFeeErrorResponse distinguishes THREE outcomes instead of two:
 *   - "guard_refused": the existing #1467 live-charge-guard refusal (422 + REFUSAL_CODE). No charge was
 *     ever attempted. Unaffected by this change.
 *   - "ambiguous_outcome": create-payment-intent's off-session loop hit an AmbiguousChargeOutcomeError
 *     (422 + AMBIGUOUS_OUTCOME_CODE, gh-1886 B1). The charge outcome for this contractor is UNKNOWN.
 *   - "hard_failure": every other non-ok response -- a genuine decline, or any response shape this
 *     function does not specifically recognise. Unchanged: this is the only classification that may ever
 *     trigger dunning (see shouldTriggerDunning below).
 */
export type PlatformFeeErrorClassification = "guard_refused" | "ambiguous_outcome" | "hard_failure";

export function classifyPlatformFeeErrorResponse(
  status: number,
  bodyText: string,
  guardRefusalCode: string,
  ambiguousOutcomeCode: string,
): PlatformFeeErrorClassification {
  if (status === 422 && bodyText.includes(guardRefusalCode)) return "guard_refused";
  if (status === 422 && bodyText.includes(ambiguousOutcomeCode)) return "ambiguous_outcome";
  return "hard_failure";
}

/**
 * [gh-1886 re-review #2 -- "B1-c"] The dunning-routing decision, as a single pure predicate so it can be
 * pinned directly: dunning (mark "dunning", insert payment_failures, POST process-dunning) may run ONLY
 * for a genuine hard_failure. Neither a guard refusal (no charge attempted) nor an ambiguous outcome
 * (charge outcome UNKNOWN -- may already be charged) may ever reach it.
 */
export function shouldTriggerDunning(classification: PlatformFeeErrorClassification): boolean {
  return classification === "hard_failure";
}

/**
 * Best-effort extraction of the `idempotency_key` field create-payment-intent's ambiguous-outcome JSON
 * body carries, for the reconciliation alert message. Never throws: an unparseable or missing field simply
 * yields "unknown" rather than blocking the alert (which must still fire) on a malformed body.
 */
export function extractIdempotencyKeyHint(bodyText: string): string {
  try {
    // deno-lint-ignore no-explicit-any
    const parsed: any = JSON.parse(bodyText);
    if (typeof parsed?.idempotency_key === "string" && parsed.idempotency_key.trim() !== "") {
      return parsed.idempotency_key;
    }
  } catch {
    // Not JSON, or JSON.parse failed -- fall through to the default below.
  }
  return "unknown";
}
