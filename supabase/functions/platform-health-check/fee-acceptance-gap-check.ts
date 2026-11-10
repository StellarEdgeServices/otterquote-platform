/**
 * fee-acceptance-gap-check.ts (gh-3586, from REVIEW 6745486099 on PR #3501)
 *
 * D-214 treats a contractor's bid submission as acceptance of the displayed platform fee, and public.fee_acceptances
 * is the evidence. Both bid forms insert the quote first and the acceptance row second, and the second write is
 * non-fatal: if it fails or times out the bid stands with no acceptance record and only Sentry knows. This check lists
 * quotes that have no fee_acceptances row so the gap is surfaced to an admin instead of being found in a dispute.
 *
 * Pure logic only (no Deno.env, no Supabase client, no fetch), mirroring register-partner-budget-check.ts. index.ts
 * Phase 6 does the reads and calls the EXISTING fireAlert() (Mailgun + platform_alerts_log + dedup).
 *
 * What counts as a gap:
 *  - a quote with NO fee_acceptances row whose bid_id is the quote id (a rescinded row still counts as a row: the
 *    acceptance was recorded; rescission is a separate, deliberate event);
 *  - created before now - graceMinutes (the acceptance insert follows the quote insert by seconds; the grace stops an
 *    in-flight bid from alerting);
 *  - created at or after `since` (fee_acceptances went live with v62 on 2026-05-07; older quotes cannot have a row);
 *  - is_test is not true (unless includeTest, used only to plant a proof case in production: a test quote must be
 *    visible to the proof and invisible to the real alert);
 *  - renewed_from_quote_id is null. process-bid-expirations clones an expiring bid with renewed_from_quote_id set and
 *    writes no fee_acceptances row; the ORIGINAL bid carries the acceptance (and is checked itself). Excluding renewals
 *    (rather than walking the chain) is the simpler reading of the closes-on ("any non-test quote lacking a row") that
 *    does not alarm on every auto-renewed bid forever. Flagged on #3586 for Ben/Marty to overrule.
 *  - is_auto_bid is not true. process-auto-bids files quotes with fee_agreed set by the contractor's standing auto-bid
 *    setup and writes no fee_acceptances row today, so counting them would fire forever. Whether auto-bids need an
 *    acceptance row is a product/legal question raised on #3586, not decided here.
 */

export interface QuoteRow {
  id: string;
  claim_id?: string | null;
  contractor_id?: string | null;
  created_at: string;
  status?: string | null;
  is_test?: boolean | null;
  is_auto_bid?: boolean | null;
  renewed_from_quote_id?: string | null;
}

export interface GapOptions {
  /** Quotes created before this ISO instant are ignored. */
  since: string;
  /** Quotes younger than this many minutes are ignored (insert race). */
  graceMinutes: number;
  /** Count is_test quotes too. Only for the planted-case proof. */
  includeTest?: boolean;
  /** "Now" for the grace window; injectable for tests. */
  now?: Date;
}

export interface GapResult {
  count: number;
  /** Oldest first. */
  gaps: QuoteRow[];
}

export const FEE_GAP_ALERT_TYPE = "fee_acceptance_missing";
export const FEE_GAP_FUNCTION_NAME = "fee_acceptances";
/** fee_acceptances shipped with v62 (sql/v62-d214-d215-fee-acceptances.sql, 2026-05-07). */
export const FEE_GAP_DEFAULT_SINCE = "2026-05-07T00:00:00Z";
export const FEE_GAP_DEFAULT_GRACE_MINUTES = 10;
export const FEE_GAP_LISTED_IDS = 20;

/** Is this quote eligible to be checked at all (before looking for its acceptance row)? */
export function isCheckableQuote(q: QuoteRow, opts: GapOptions): boolean {
  if (!opts.includeTest && q.is_test === true) return false;
  if (q.is_auto_bid === true) return false;
  if (q.renewed_from_quote_id) return false;
  const created = Date.parse(q.created_at);
  if (Number.isNaN(created)) return false;
  if (created < Date.parse(opts.since)) return false;
  const now = (opts.now ?? new Date()).getTime();
  if (created > now - opts.graceMinutes * 60_000) return false;
  return true;
}

/** acceptedBidIds: every fee_acceptances.bid_id that exists (any row, rescinded or not). */
export function findQuotesMissingAcceptance(
  quotes: QuoteRow[],
  acceptedBidIds: Iterable<string>,
  opts: GapOptions,
): GapResult {
  const accepted = new Set(acceptedBidIds);
  const gaps = quotes
    .filter((q) => isCheckableQuote(q, opts) && !accepted.has(q.id))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return { count: gaps.length, gaps };
}

export const FEE_GAP_REMINDER_HOURS = 24;

/**
 * Throttle for a STANDING condition. Alert when (a) there has never been an alert, (b) a gap appeared since the last alert
 * (created after lastAlertSentAt - graceMinutes, because a quote becomes checkable only graceMinutes after it is filed), or
 * (c) the last alert is older than reminderHours (one reminder a day while gaps stand). `force` (the planted-case proof) always alerts.
 * lastAlertSentAt is the newest platform_alerts_log row of this type, acknowledged or not.
 */
export function shouldAlertOnGap(
  result: GapResult,
  lastAlertSentAt: string | null,
  o: { graceMinutes: number; now?: Date; reminderHours?: number; force?: boolean },
): { alert: boolean; newCount: number } {
  if (result.count <= 0) return { alert: false, newCount: 0 };
  const last = lastAlertSentAt ? Date.parse(lastAlertSentAt) : NaN;
  if (o.force || Number.isNaN(last)) return { alert: true, newCount: result.count };
  const newSince = last - o.graceMinutes * 60_000;
  const newCount = result.gaps.filter((g) => Date.parse(g.created_at) > newSince).length;
  const now = (o.now ?? new Date()).getTime();
  const reminderDue = now - last >= (o.reminderHours ?? FEE_GAP_REMINDER_HOURS) * 3_600_000;
  return { alert: newCount > 0 || reminderDue, newCount };
}

export interface FeeGapAlert {
  alertType: typeof FEE_GAP_ALERT_TYPE;
  functionName: typeof FEE_GAP_FUNCTION_NAME;
  subject: string;
  message: string;
}

/** null when there is no gap (silent). Never throws. */
export function evaluateFeeAcceptanceGap(result: GapResult, includeTest = false): FeeGapAlert | null {
  if (result.count <= 0) return null;
  const listed = result.gaps.slice(0, FEE_GAP_LISTED_IDS).map((q) => `${q.id} (${q.created_at})`);
  const more = result.count > listed.length ? ` ... and ${result.count - listed.length} more` : "";
  return {
    alertType: FEE_GAP_ALERT_TYPE,
    functionName: FEE_GAP_FUNCTION_NAME,
    subject: `OtterQuote Health Alert — ${result.count} quote${result.count === 1 ? "" : "s"} filed without a fee_acceptances row`,
    message: [
      `${result.count} ${includeTest ? "(test-inclusive proof run) " : ""}quote(s) have no fee_acceptances row (D-214 evidence of fee acceptance is missing).`,
      "A first-filed bid inserts the quote, then the acceptance; the acceptance write is non-fatal, so a failed or timed-out write leaves the bid with no record.",
      `Quote ids (oldest first): ${listed.join("; ")}${more}.`,
      "Next step: confirm with the contractor and record the acceptance through the admin path; do not backfill a row from the quote alone.",
    ].join(" "),
  };
}
