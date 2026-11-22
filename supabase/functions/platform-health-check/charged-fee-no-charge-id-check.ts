/**
 * charged-fee-no-charge-id-check.ts (gh-1759, Dustin's "1759 alert" word, CEO board 2026-11-22)
 *
 * stripe-webhook resolves a charge.dispute.created event to a claim by claims.platform_fee_stripe_id. PR #1807 gave that
 * column a writer (docusign-webhook stores the charge id create-payment-intent returns). If a platform fee is ever charged
 * and the charge id does NOT come back or is not stored, the dispute lookup misses again and the handler can burn Stripe's
 * one evidence submission. This check is the forward guard from the issue's closes-on: the count of claims with
 * platform_fee_charged IS TRUE AND platform_fee_stripe_id IS NULL (non-test) must stay 0.
 *
 * INTERNAL ONLY: the alert goes to the owner through platform-health-check's EXISTING fireAlert() (Mailgun to ALERT_EMAIL +
 * platform_alerts_log + dedup). No customer-facing text, no new vendor.
 *
 * Pure logic only (no Deno.env, no Supabase client, no fetch), mirroring fee-acceptance-gap-check.ts. index.ts Phase 7 does
 * the read (READ-ONLY) and calls fireAlert().
 */

export interface ClaimFeeRow {
  id: string;
  created_at?: string | null;
  platform_fee_charged?: boolean | null;
  platform_fee_stripe_id?: string | null;
  is_test?: boolean | null;
}

export interface ChargedFeeResult {
  count: number;
  /** Oldest first when created_at is present. */
  claims: ClaimFeeRow[];
}

export const CHARGED_FEE_ALERT_TYPE = "charged_fee_no_charge_id";
export const CHARGED_FEE_FUNCTION_NAME = "claims.platform_fee_stripe_id";
export const CHARGED_FEE_LISTED_IDS = 20;

/** Same predicate as the closes-on forward guard, minus is_test rows (unless includeTest, planted-case proof only). */
export function isChargedFeeWithoutChargeId(c: ClaimFeeRow, includeTest = false): boolean {
  if (!includeTest && c.is_test === true) return false;
  if (c.platform_fee_charged !== true) return false;
  return c.platform_fee_stripe_id == null || c.platform_fee_stripe_id === "";
}

export function findChargedFeesWithoutChargeId(rows: ClaimFeeRow[], includeTest = false): ChargedFeeResult {
  const claims = rows
    .filter((c) => isChargedFeeWithoutChargeId(c, includeTest))
    .sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? "") || 0);
  return { count: claims.length, claims };
}

export interface ChargedFeeAlert {
  alertType: typeof CHARGED_FEE_ALERT_TYPE;
  functionName: typeof CHARGED_FEE_FUNCTION_NAME;
  subject: string;
  message: string;
}

/** null when the count is 0 (silent). Never throws. */
export function evaluateChargedFeeWithoutChargeId(result: ChargedFeeResult, includeTest = false): ChargedFeeAlert | null {
  if (result.count <= 0) return null;
  const listed = result.claims.slice(0, CHARGED_FEE_LISTED_IDS).map((c) => c.id);
  const more = result.count > listed.length ? ` ... and ${result.count - listed.length} more` : "";
  return {
    alertType: CHARGED_FEE_ALERT_TYPE,
    functionName: CHARGED_FEE_FUNCTION_NAME,
    subject: `OtterQuote Health Alert — ${result.count} charged platform fee${result.count === 1 ? "" : "s"} with no stored charge id`,
    message: [
      `${result.count} ${includeTest ? "(test-inclusive proof run) " : ""}claim(s) show platform_fee_charged = true but platform_fee_stripe_id is NULL.`,
      "A charged fee must store its Stripe charge id: charge.dispute.created finds the claim by that id, and a miss can auto-submit an empty evidence packet (gh-1759).",
      `Claim ids: ${listed.join("; ")}${more}.`,
      "Next step: find the charge in Stripe and check the create-payment-intent response and the docusign-webhook / stripe-webhook write; do not guess the id.",
    ].join(" "),
  };
}
