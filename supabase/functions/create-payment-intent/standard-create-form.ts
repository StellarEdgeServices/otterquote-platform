/**
 * [gh-2078c / D-330] The standard-flow PaymentIntent CREATE request, as a pure function.
 *
 * WHY THIS IS A MODULE. REVIEW: FAIL 5805531419 (B1) and 5805870455 (F2) on #2110: the create carries a per-claim
 * `Idempotency-Key`, and Stripe answers HTTP 400 `idempotency_error` when a reused key arrives with a different body. The
 * property that keeps a homeowner able to pay is "the create body and the key are functions of the claim and the request
 * type ONLY, never of anything that varies per request", and that property can only be tested, with the real code, if the
 * body is built by a function a test can call. Nothing about the request changed: this is main's construction, moved
 * verbatim, and standard-create-form.test.ts pins it to a literal copy of main's code across a matrix of inputs.
 *
 * The router `variant` is deliberately NOT an input here. It is attached afterwards by variant-metadata.ts.
 */
import { UPGRADE_CHARGE_DESCRIPTION, VENDOR_CREDIT_EXPECTED_CENTS } from "./measurement-upgrade-gate.ts";

export interface StandardCreateInput {
  amount: unknown;
  currency: string;
  description?: string | null;
  // deno-lint-ignore no-explicit-any
  metadata: any;
  contractor_id?: unknown;
}

export function buildStandardCreateForm(i: StandardCreateInput): URLSearchParams {
  const { amount, currency, description, metadata, contractor_id } = i;
  const form = new URLSearchParams();
  form.append("amount", String(amount));
  form.append("currency", currency);
  // measurement_upgrade: description is server-enforced, never the
  // client-sent value — D-312/#1414 scrubbed vendor names from every
  // customer-facing string and this must never regress that.
  const chargeDescription = metadata.type === "measurement_upgrade"
    ? UPGRADE_CHARGE_DESCRIPTION
    : (description || "");
  form.append("description", chargeDescription);
  form.append("metadata[claim_id]", metadata.claim_id);
  form.append("metadata[type]", metadata.type);
  if (metadata.type === "measurement_upgrade") {
    form.append("metadata[contractor_id]", contractor_id as string);
    // Bookkeeping only (Marty, #1411 cto-2026-09-02T13:45:25Z: "does not
    // net it against the charge") — the contractor is still charged the
    // full tier amount above.
    form.append("metadata[vendor_credit_expected_cents]", String(VENDOR_CREDIT_EXPECTED_CENTS));
  }
  form.append("automatic_payment_methods[enabled]", "true");
  return form;
}

/** One key per claim and request type: reused on every retry, which is why nothing per-request may be in the body. */
export function standardIdempotencyKey(metadata: { type: string; claim_id: string }): string {
  return `${metadata.type}-${metadata.claim_id}`;
}
