/**
 * [gh-1759] Dispute routing + final-submission decisions, as pure functions.
 *
 * WHY THIS EXISTS. `charge.dispute.created` resolves a dispute to a claim via
 * `claims.platform_fee_stripe_id = dispute.charge`. Until this change no code
 * path had ever WRITTEN that column (0 non-null across all 16 claims, measured
 * 2026-09-07), so the primary lookup always missed and the handler fell back to
 * `quotes.payment_intent_id` — a field that ordinary dunning retries overwrite
 * (see index.ts, the payment_intent_id note in the succeeded handler).
 *
 * THE PART THAT MADE IT URGENT was not the missing write. It was that a miss did
 * not fail safe. For a dispute under $500 whose reason is not
 * `product_not_received`, the handler called the evidence builder with
 * `claim = null, feeAcceptance = null` and POSTed `/disputes/{id}` with
 * `evidence[submit]: "true"` — Stripe's ONE-SHOT FINAL submission — carrying the
 * literal text "FEE ACCEPTANCE RECORD: Not found in database". That burns the
 * single submission we get and effectively concedes the chargeback, in writing,
 * to a card network.
 *
 * SO THERE ARE TWO INDEPENDENT GATES HERE, DELIBERATELY. One gate is a code
 * path; two gates is a property (the same reasoning #1467 used for its
 * duplicated live-charge guard):
 *
 *   1. `shouldRouteToManualQueue` — an unresolvable dispute never reaches the
 *      auto-submit branch at all. It becomes a ClickUp task and an
 *      `admin_dispute_queue` row, exactly like a >= $500 or non-delivery
 *      dispute already does today. VISIBLE WORK, NOT SILENCE.
 *   2. `maySubmitFinalEvidence` — even if a future refactor routes an
 *      unresolvable dispute to auto-submit anyway, the evidence payload omits
 *      `evidence[submit]` entirely, which makes the Stripe call save DRAFT
 *      evidence instead of spending the final submission.
 *
 * Gate 2 exists precisely because gate 1 is the kind of boolean someone
 * refactors. Pure and separate for the same reason `live-charge-guard.ts` is:
 * this is a money decision, and a money decision should be unit-testable
 * without a network. See dispute-routing.test.ts.
 */

/** Reasons that always go to a human regardless of amount (D-228). */
export const NON_DELIVERY_REASON_SET: ReadonlySet<string> = new Set([
  "product_not_received",
]);

/** D-228 routing threshold: $500.00. */
export const MANUAL_QUEUE_AMOUNT_THRESHOLD_CENTS = 50_000;

export type ManualQueueReason =
  | "claim_unresolved"
  | "non_delivery_reason"
  | "amount_threshold";

export interface DisputeRoutingInput {
  /** `dispute.reason` from Stripe. */
  reason: string;
  /** `dispute.amount` in cents. */
  amountCents: number;
  /**
   * Did the handler resolve this dispute to a claim row? `false` means neither
   * the `platform_fee_stripe_id` lookup nor the `payment_intent_id` fallback
   * found anything — we do not know which job this charge belongs to.
   */
  claimResolved: boolean;
}

export interface DisputeRoutingVerdict {
  routing: "auto_submit" | "manual_queue";
  /** Why it went to a human. `null` when routing is auto_submit. */
  reason: ManualQueueReason | null;
}

/**
 * Decide whether a dispute goes to a human or to the auto-evidence submitter.
 *
 * `claim_unresolved` is checked FIRST and reported first, because it is the one
 * of the three that says "we cannot describe this transaction", and that is a
 * more important thing for the operator reading `admin_dispute_queue` to see
 * than the amount.
 */
export function evaluateDisputeRouting(
  input: DisputeRoutingInput,
): DisputeRoutingVerdict {
  if (!input.claimResolved) {
    return { routing: "manual_queue", reason: "claim_unresolved" };
  }
  if (NON_DELIVERY_REASON_SET.has(input.reason)) {
    return { routing: "manual_queue", reason: "non_delivery_reason" };
  }
  if (input.amountCents >= MANUAL_QUEUE_AMOUNT_THRESHOLD_CENTS) {
    return { routing: "manual_queue", reason: "amount_threshold" };
  }
  return { routing: "auto_submit", reason: null };
}

/**
 * May this evidence payload spend Stripe's single FINAL submission?
 *
 * Only when we can actually describe the transaction: a claim row AND a
 * fee-acceptance row. Without both, the payload we would send says our own
 * records were "Not found in database" — a submission worse than no submission,
 * because it is final and it is quotable.
 *
 * Omitting `evidence[submit]` does NOT lose the evidence: Stripe stores it as
 * draft against the dispute, so a human working the queue item starts from what
 * we did manage to assemble rather than from nothing.
 */
export function maySubmitFinalEvidence(params: {
  claimResolved: boolean;
  feeAcceptanceResolved: boolean;
}): boolean {
  return params.claimResolved && params.feeAcceptanceResolved;
}
