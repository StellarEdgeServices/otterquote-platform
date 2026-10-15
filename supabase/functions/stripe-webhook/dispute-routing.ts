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
 *      unresolvable dispute to auto-submit anyway, the request sends an
 *      explicit top-level `submit=false`, which makes Stripe stage the evidence
 *      as a DRAFT instead of spending the final submission. (Omitting `submit`
 *      would NOT do this: Stripe defaults it to true.)
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
 * When this is false the request still goes out, with an explicit top-level
 * `submit=false`, so Stripe stages the evidence as a draft for a human to finish.
 * (Omitting `submit` would NOT do that: Stripe defaults it to true.)
 */
export function maySubmitFinalEvidence(params: {
  claimResolved: boolean;
  feeAcceptanceResolved: boolean;
}): boolean {
  return params.claimResolved && params.feeAcceptanceResolved;
}

// ---------------------------------------------------------------------------
// [gh-2794] GATE 3: draft-only unless a person has deliberately switched final
// submission on.
// ---------------------------------------------------------------------------

/**
 * Name of the Supabase Edge Function secret / env var that turns on FINAL
 * (irreversible) dispute-evidence submission. Same pattern as the other
 * feature switches under supabase/functions (`Deno.env.get(NAME) === "true"`,
 * e.g. BOLDSIGN_REQUIRE_SIGNATURE, TEMPLATE_WATCH_EMAIL_ENABLED).
 */
export const FINAL_SUBMIT_ENV_VAR = "DISPUTE_EVIDENCE_FINAL_SUBMIT_ENABLED";

/**
 * Is final submission explicitly switched on? Fail-closed: ONLY the exact
 * string "true" enables it. Unset, empty, "TRUE", "1", "yes", " true " and
 * anything else all mean OFF (draft only).
 *
 * WHY: the evidence names the homeowner and the property address, and Stripe
 * allows exactly one final submission per dispute. #2794 promised Dustin that
 * final submission "stays draft-only until you answer"; until this gate nothing
 * enforced it. This stays OFF until he answers and someone sets the secret.
 */
export function isFinalSubmitEnabled(envValue: string | undefined | null): boolean {
  return envValue === "true";
}

/**
 * Final decision for the top-level `submit` parameter. True only when BOTH the evidence is
 * complete (claim + fee-acceptance resolved: `maySubmitFinalEvidence`) AND the
 * explicit switch is on. Default (switch off) is always false.
 */
export function shouldSubmitFinalEvidence(params: {
  claimResolved: boolean;
  feeAcceptanceResolved: boolean;
  finalSubmitEnabled: boolean;
}): boolean {
  return params.finalSubmitEnabled === true && maySubmitFinalEvidence(params);
}

/**
 * Build the form body for POST /v1/disputes/{id}.
 *
 * STRIPE WIRE CONTRACT (https://docs.stripe.com/api/disputes/update): `submit` is a
 * TOP-LEVEL boolean parameter and it DEFAULTS TO TRUE. `evidence` has no `submit`
 * child. So leaving the parameter out means Stripe submits FINAL, and sending
 * `evidence[submit]` is an unknown parameter. The only way to save a draft is an
 * explicit top-level `submit=false`, so this ALWAYS sets it, to "true" only when
 * shouldSubmitFinalEvidence() says so, and never emits `evidence[submit]`.
 */
export function buildDisputeRequestBody(
  evidence: Record<string, string>,
  params: {
    claimResolved: boolean;
    feeAcceptanceResolved: boolean;
    finalSubmitEnabled: boolean;
  },
): Record<string, string> {
  const body: Record<string, string> = {};
  for (const [k, v] of Object.entries(evidence)) {
    if (k === "evidence[submit]" || k === "submit") continue; // never trust a caller-supplied key
    body[k] = v;
  }
  body["submit"] = shouldSubmitFinalEvidence(params) ? "true" : "false";
  return body;
}

export interface DisputeSubmitResult {
  ok: boolean;
  data: unknown;
  error?: string;
  /** True only when the request carried submit=true (FINAL). False = staged draft. */
  submitFinal: boolean;
  /** The exact key/value pairs that were form-encoded and sent. */
  requestBody: Record<string, string>;
}

/**
 * The ONE place that writes to a Stripe dispute. Form-encodes the body from
 * buildDisputeRequestBody and POSTs it. `fetchImpl` is injectable so tests can
 * decode the real request body.
 */
export async function postDisputeEvidence(params: {
  disputeId: string;
  stripeKey: string;
  evidence: Record<string, string>;
  claimResolved: boolean;
  feeAcceptanceResolved: boolean;
  finalSubmitEnabled: boolean;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<DisputeSubmitResult> {
  const requestBody = buildDisputeRequestBody(params.evidence, params);
  const submitFinal = requestBody["submit"] === "true";
  const doFetch = params.fetchImpl ?? fetch;
  try {
    const res = await doFetch(
      `${params.apiBase ?? "https://api.stripe.com/v1"}/disputes/${params.disputeId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(requestBody).toString(),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      return {
        ok: false,
        data,
        error: (data as { error?: { message?: string } })?.error?.message ?? "Stripe API error",
        submitFinal,
        requestBody,
      };
    }
    return { ok: true, data, submitFinal, requestBody };
  } catch (err) {
    return { ok: false, data: null, error: String(err), submitFinal, requestBody };
  }
}
