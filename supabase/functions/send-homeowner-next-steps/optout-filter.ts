// gh-1786 / D-320 — the sender's side of the homeowner nudge opt-out.
//
// Pure, so the "a suppressed recipient is skipped while an unsuppressed one on
// the same run is sent" requirement in #1786's closes-on is testable without
// Supabase or Mailgun.
//
// MECHANISM, and one place where D-320's wording and the schema disagree.
// D-320 says the opt-out is "honored by a key in the claim's existing JSONB,
// matching the mechanism D-303 established for the referrer opt-out. No
// migration." Measured against production Postgres before writing this:
//
//   select column_name, data_type from information_schema.columns
//    where table_schema='public' and table_name='claims'
//      and data_type in ('jsonb','json');
//   -> hover_measurements, parsed_line_items, project_confirmation,
//      switch_reason_survey, trade_intents
//
// `claims` has NO general-purpose JSONB bag. Every JSONB column on it means
// something specific, and writing a consent flag into `project_confirmation` or
// `switch_reason_survey` would be worse than a migration. D-303's own primary
// surface is in fact a BOOLEAN COLUMN, claims.referrer_updates_opt_out, added by
// migration 20260831124504 — the JSONB half of D-303 is its FALLBACK,
// referrals.metadata.referrer_updates_opt_out.
//
// So the faithful no-migration reading of D-320 is the JSONB key this feature's
// own table already uses: activity_log.metadata.claim_id, on a row whose
// event_type is OPTOUT_EVENT_TYPE. That table is already read in full for these
// users on every run (the nudge stamp lives there the same way), it needs no
// schema change, and unlike a boolean it records WHEN the opt-out happened and
// by what route — which is what anyone asking "why did I get this email" needs.
// If an executive prefers the D-303-shaped boolean column, that is a Tier 3A
// migration and a different PR; this one keeps the no-migration constraint.

import { OPTOUT_EVENT_TYPE } from "./optout-token.ts";

export interface ActivityRowLike {
  user_id?: string | null;
  event_type?: string | null;
  metadata?: { claim_id?: string | null } | null;
  created_at?: string | null;
}

/**
 * Claim ids that have opted out, from the same activity_log read the nudge
 * stamps come from. A row with no metadata.claim_id is ignored rather than
 * treated as a global opt-out — failing OPEN here would silently stop the whole
 * series, which is the "suppresses everybody" outcome #1786's negative control
 * exists to catch.
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

// ─── PR #1810 LEGAL-READ FAIL (comments 5577266980 / 5577311497) ───────────
// The pre-send suppression read must be COMPLETE — a truncated read that
// drops the one row that says "stop" and then sends anyway is the exact
// CAN-SPAM failure #1786 exists to close. The general activity_log read in
// index.ts (`.from("activity_log").select(...).in("user_id", userIds)`, no
// event_type filter, no order, no limit) is NOT safe to reduce this from: it
// has no event_type predicate, so on a user with a lot of history it can hit
// PostgREST's row cap before the opt-out row is even considered, and with no
// ORDER BY which rows survive a cap is arbitrary (this repo already ruled
// this exact shape a silent-truncation hazard on this table — gh-1340 ->
// PR #1435/#1439). One live user already holds 1,032 activity_log rows.
//
// fetchOptedOutClaimIds below gives the opt-out check its OWN query instead,
// bounded two ways so it cannot be truncated regardless of how much other
// history these users accumulate:
//   - event_type = OPTOUT_EVENT_TYPE narrows to opt-out rows only.
//   - metadata->>claim_id IN (candidateClaimIds) bounds the result to AT MOST
//     candidateClaimIds.length rows — never more than this batch's own
//     candidate set (itself capped at BATCH_LIMIT=200 by the caller), which
//     is far below any PostgREST page cap. That is a provable bound, not a
//     "hope the cap is high enough" one — paging would also fix truncation,
//     but this needs no loop and no extra round trips.
//   - user_id IN (candidateUserIds) is included too, purely so Postgres can
//     use idx_activity_log_user_id instead of a sequential scan; it narrows
//     in the same direction as the claim_id filter, never the opposite, so
//     it cannot reintroduce truncation risk.

/** Structural subset of the Supabase/PostgREST query builder this module
 * needs — kept narrow and self-referential (each filter method returns the
 * same builder shape, and the builder itself is thenable) so this file stays
 * testable with a lightweight fake instead of a real @supabase/supabase-js
 * client, while still being satisfied by the real one as-is. */
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
 * above for why this cannot reuse the general activity_log read in index.ts.
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
 * link can be built, so the correct behaviour is to send NOTHING rather than to
 * send a commercial email with a dead or absent unsubscribe. Fails CLOSED on
 * purpose — a missing env var must not degrade into the pre-D-320 behaviour.
 */
export function canSendWithOptOut(signingSecret: string | null | undefined): boolean {
  return typeof signingSecret === "string" && signingSecret.length > 0;
}
