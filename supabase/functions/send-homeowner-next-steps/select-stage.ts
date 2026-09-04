// gh-1580 — pure selection + stage logic for send-homeowner-next-steps.
//
// Extracted from index.ts so the two CTO RUN 22 spec defects are testable
// without Supabase or Mailgun:
//
//   1. STATUS PREDICATE. The candidate scan had no `status` predicate, so it
//      picked up a `draft` claim (a homeowner mid-intake, not "one step from
//      bids"). The only status a stalled post-signup claim can sit in is the
//      column's own DEFAULT, 'documents_needed' (claims.status DEFAULT
//      'documents_needed'; zero code write sites — claims land there by
//      inaction). Everything else is either pre-signup (`draft`) or already
//      past the point this nudge is about (`submitted`, `active`, `waitlisted`,
//      `bidding`, `contract_signed`, `awarded` — the full set enumerated by
//      migration 20260904132600_gh1532_claims_status_check.sql).
//
//   2. ONE EMAIL PER RUN. The two stages were independent gates, so on the
//      first run every claim older than 48h got BOTH the '2h' and the '48h'
//      email back-to-back (RUN 22: 7 emails to 4 people). selectStage returns
//      at most ONE stage per call:
//        - nothing recorded, 2h <= age < 48h            -> '2h'
//        - nothing recorded, age >= 48h (backlog)       -> '48h'  (one email,
//          the stage appropriate to its age; the '2h' stage is never
//          back-filled, so a month-old claim gets exactly one email ever)
//        - '2h' recorded, age >= 48h, and the '2h' stamp itself is at least
//          (48h - 2h) old                               -> '48h'
//        - '48h' recorded                               -> null (done)
//        - otherwise                                    -> null
//      The stamp-age spacing on the '2h' -> '48h' transition is what keeps a
//      claim first seen at, say, 44h from getting the '2h' email now and the
//      '48h' email three hours later: stage 2 follows stage 1 by the same
//      ~46h it would in the steady state (stamp at ~+2h, second at +48h).

export type NudgeStage = "2h" | "48h";

export const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
export const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
// Minimum gap between the '2h' stamp and the '48h' send — the steady-state
// distance between the two stages.
export const STAGE_GAP_MS = FORTY_EIGHT_HOURS_MS - TWO_HOURS_MS;

// The one claims.status value this nudge targets (the column DEFAULT — where
// a claim sits after homeowner signup until measurements/material arrive).
export const NUDGE_ELIGIBLE_STATUS = "documents_needed";
// Explicitly excluded even though the equality predicate above already
// rejects it: a `draft` is a homeowner still filling in the intake form, and
// telling them "You're one step from bids" is wrong.
export const NUDGE_EXCLUDED_STATUS = "draft";

export function isNudgeEligibleStatus(status: string | null | undefined): boolean {
  if (status == null) return false;
  if (status === NUDGE_EXCLUDED_STATUS) return false;
  return status === NUDGE_ELIGIBLE_STATUS;
}

export interface StageClaim {
  id: string;
  created_at: string;
}

/**
 * priorSends: the stages already stamped for THIS claim, each mapped to the
 * ISO timestamp of its activity_log stamp row (created_at).
 */
export function selectStage(
  claim: StageClaim,
  priorSends: ReadonlyMap<NudgeStage, string>,
  now: number,
): NudgeStage | null {
  const createdMs = new Date(claim.created_at).getTime();
  if (Number.isNaN(createdMs)) return null;
  const ageMs = now - createdMs;
  if (ageMs < TWO_HOURS_MS) return null;

  if (priorSends.has("48h")) return null; // terminal stage already sent

  const twoHourStampIso = priorSends.get("2h");
  if (twoHourStampIso === undefined) {
    // Nothing recorded yet: exactly one email, the stage appropriate to age.
    return ageMs >= FORTY_EIGHT_HOURS_MS ? "48h" : "2h";
  }

  // '2h' already sent: the '48h' stage depends on that record existing AND
  // on the claim being >= 48h old AND on the '2h' stamp being old enough
  // that the two emails are spaced the way the steady state spaces them.
  if (ageMs < FORTY_EIGHT_HOURS_MS) return null;
  const stampMs = new Date(twoHourStampIso).getTime();
  if (Number.isNaN(stampMs)) return null; // malformed stamp: fail closed
  if (now - stampMs < STAGE_GAP_MS) return null;
  return "48h";
}
