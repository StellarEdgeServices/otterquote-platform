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
export const CHARGED_FEE_REMINDER_HOURS = 24;

/**
 * Standing-condition throttle (same idea as gh-3586's shouldAlertOnGap, review 7087416804). A charged fee with no charge id
 * stays stuck until someone fixes it, and fireAlert()'s own dedup only looks at UNACKNOWLEDGED rows in the last 15 minutes
 * (the cron period), so without this the owner is emailed every run, and acknowledging the alert re-fires it at once.
 * lastAlert is the newest platform_alerts_log row of this type, acknowledged or not (null = never alerted or read error).
 * Alert when (a) never alerted, (b) a currently-offending claim id (among the ids an alert lists) is not named in the last
 * alert's message, (c) the last alert is older than reminderHours (one reminder a day), or (d) force (planted-case proof run).
 * New claims are detected by id, not created_at: a claim can be old and only become offending when its charge flag flips.
 */
export function shouldAlertOnChargedFee(
  result: ChargedFeeResult,
  lastAlert: { sent_at: string | null; message?: string | null } | null,
  o: { now?: Date; reminderHours?: number; force?: boolean } = {},
): { alert: boolean; newCount: number } {
  if (result.count <= 0) return { alert: false, newCount: 0 };
  const last = lastAlert?.sent_at ? Date.parse(lastAlert.sent_at) : NaN;
  if (o.force || Number.isNaN(last)) return { alert: true, newCount: result.count };
  const prior = lastAlert?.message ?? "";
  const newCount = result.claims.slice(0, CHARGED_FEE_LISTED_IDS).filter((c) => !prior.includes(c.id)).length;
  const now = (o.now ?? new Date()).getTime();
  const reminderDue = now - last >= (o.reminderHours ?? CHARGED_FEE_REMINDER_HOURS) * 3_600_000;
  return { alert: newCount > 0 || reminderDue, newCount };
}

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
