// gh-1786 / D-320 — the sender's side of the homeowner nudge opt-out.
// gh-2013: copied for send-home-profile-prompt (D-231 promotional nudge),
// same reasoning as send-homeowner-next-steps/optout-filter.ts.
//
// Pure, so "a suppressed recipient is skipped while an unsuppressed one on
// the same run is sent" is testable without Supabase or Mailgun.
//
// MECHANISM. D-320 says the opt-out is "honored by a key in the claim's
// existing JSONB, matching the mechanism D-303 established for the referrer
// opt-out. No migration." send-homeowner-next-steps/optout-filter.ts's own
// header comment documents why the faithful no-migration reading of D-320 is
// activity_log.metadata.claim_id on a row whose event_type is
// OPTOUT_EVENT_TYPE — that reasoning is unchanged here; this file reuses the
// SAME event type and the SAME activity_log shape, not a second mechanism.

import { OPTOUT_EVENT_TYPE } from "./optout-token.ts";

export interface ActivityRowLike {
  user_id?: string | null;
  event_type?: string | null;
  metadata?: { claim_id?: string | null } | null;
  created_at?: string | null;
}

/**
 * Claim ids that have opted out. A row with no metadata.claim_id is ignored
 * rather than treated as a global opt-out — failing OPEN here would silently
 * stop the whole batch, which is the "suppresses everybody" outcome #1786's
 * negative control exists to catch.
 */
export function collectOptedOutClaimIds(rows: readonly ActivityRowLike[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (!row || row.event_type !== OPTOUT_EVENT_TYPE) continue;
    const claimId = row.metadata?.claim_id;
    if (typeof claimId === "string" && claimId.length > 0) out.add(claimId);
  }
  return out;
}

/** True when this claim's homeowner has asked for the series to stop. */
export function isOptedOut(optedOut: ReadonlySet<string>, claimId: string): boolean {
  return optedOut.has(claimId);
}

// ─── Bounded, filtered opt-out read (gh-1786 PR #1810 legal-read-fail fix) ──
// The pre-send suppression read must be COMPLETE. An unfiltered activity_log
// read (no event_type predicate, no order, no limit) is not safe to reduce
// this from: it can hit PostgREST's row cap before the opt-out row is even
// considered on a user with a lot of history. fetchOptedOutClaimIds below
// gives the opt-out check its OWN query, bounded by event_type AND by
// metadata->>claim_id IN (candidateClaimIds) — never more rows than this
// batch's own candidate set.

export interface OptOutFilterBuilder
  extends PromiseLike<{ data: ActivityRowLike[] | null; error: { message: string } | null }> {
  eq(column: string, value: string): OptOutFilterBuilder;
  in(column: string, values: readonly string[]): OptOutFilterBuilder;
}

export interface OptOutQueryClient {
  from(table: string): {
    select(columns: string): OptOutFilterBuilder;
  };
}

/**
 * The opt-out check's own filtered, bounded read — see the block comment
 * above for why this cannot reuse a general activity_log read.
 */
export async function fetchOptedOutClaimIds(
  client: OptOutQueryClient,
  candidateUserIds: readonly string[],
  candidateClaimIds: readonly string[],
): Promise<{ optedOut: Set<string>; error: { message: string } | null }> {
  if (candidateClaimIds.length === 0) return { optedOut: new Set(), error: null };
  const { data, error } = await client
    .from("activity_log")
    .select("event_type, metadata")
    .eq("event_type", OPTOUT_EVENT_TYPE)
    .in("user_id", candidateUserIds)
    .in("metadata->>claim_id", candidateClaimIds);
  if (error) return { optedOut: new Set(), error };
  return { optedOut: collectOptedOutClaimIds((data || []) as ActivityRowLike[]), error: null };
}

/**
 * Whether this run may send at all. CAN-SPAM requires a working opt-out
 * mechanism in the message; if no signing secret is configured, no verifiable
 * link can be built, so the correct behaviour is to send NOTHING rather than
 * to send a commercial email with a dead or absent unsubscribe. Fails CLOSED
 * on purpose — a missing env var must not degrade into pre-fix behaviour.
 */
export function canSendWithOptOut(signingSecret: string | null | undefined): boolean {
  return typeof signingSecret === "string" && signingSecret.length > 0;
}
