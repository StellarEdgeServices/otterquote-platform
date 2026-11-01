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

/**
 * One key per claim, request type AND amount (in cents): reused on every retry of the same charge, which is why nothing
 * per-request may be in the body.
 *
 * gh-3228: the amount is part of the key because the body carries it and Stripe pins a key to its first body for 24 hours.
 * With a per-claim key only, a homeowner who loaded the form at the old price and reloads after a price change was handed the
 * stale intent (or, with the new amount in the body, a 400 idempotency_error and a 500 from this function for 24 hours).
 * With the amount in the key, a reload after a price change creates a fresh intent at the new price, and the same amount still
 * reuses the same intent. The key is therefore a function of exactly the body's own inputs.
 */
export function standardIdempotencyKey(metadata: { type: string; claim_id: string }, amount: unknown): string {
  return `${metadata.type}-${metadata.claim_id}-${String(amount)}`;
}
