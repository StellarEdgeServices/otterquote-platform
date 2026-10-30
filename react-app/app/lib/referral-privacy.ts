/**
 * gh-3257 / privacy.html 4.7 — referral rows whose homeowner declined updates to their referrer.
 *
 * `get_my_referrals()` returns `status = NULL` (and `display_name = NULL`) for such a row. `referrals.status` is
 * NOT NULL DEFAULT 'clicked', so a NULL status in an RPC row means exactly "updates declined". Those rows show no
 * name and no progress status; the referrer sees "Referral #N — updates declined" and, once earned, their own fee.
 * The RPC returns no job value for any row, and no page renders one.
 *
 * "updates declined" is the only copy added for this (approved in Dustin's #3257 ruling). Add no other wording here.
 */

/** Approved copy (#3257). */
export const REFERRAL_UPDATES_DECLINED = 'updates declined';

/** True when a `get_my_referrals()` row is one whose homeowner declined updates (status withheld by the RPC). */
export function referralUpdatesDeclined(ref: { status?: string | null } | null | undefined): boolean {
  return !!ref && ref.status == null;
}

/** "Referral #N — updates declined", N = 1-based position in the referrer's full list (newest first). */
export function declinedReferralLabel(index: number): string {
  return `Referral #${index + 1} — ${REFERRAL_UPDATES_DECLINED}`;
}

/** The referrer's own fee counts as earned once `commission_amount` is set (non-null). */
export function referralFeeEarned(ref: { commission_amount?: unknown } | null | undefined): boolean {
  return !!ref && ref.commission_amount != null;
}
