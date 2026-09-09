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

// ─────────────────────────────────────────────────────────────────────────────
// gh-1580 — the CANDIDATE SCREEN, extracted from index.ts so the acceptance
// test CTO RUN 28 named on this issue (comment 5572642959) can exist as a repo
// artifact instead of as a live prod seed nobody can run twice.
//
// That acceptance test, verbatim: "seed one is_test homeowner claim at
// documents_needed with zero activity_log rows and zero hover_orders, invoke
// send-homeowner-next-steps by hand, and assert EXACTLY ONE activity_log row
// with event_type = 'next_steps_nudge_sent'; then add a single activity_log
// row to that claim, invoke again, and assert ZERO further nudges."
//
// The second half is the discriminating one, and until now it lived only in
// the handler's inline loop: nothing could exercise it without a database.
// The two functions below are that loop, moved verbatim in behaviour (no
// predicate changed, no order changed) so index.ts calls them instead of
// re-implementing them. A duplicate would be worse than no test at all — it
// would prove a copy, which is the false-confidence failure #1697's spec
// exists to prevent.
//
// NOT covered here, and named rather than glossed: `isNewUntouched()` in
// admin-dashboard.html (the "NEW — no activity since signup" strip predicate)
// is inline in that page's <script> and is not importable. This issue's own
// dispatch (5572642959) forbids reopening admin-dashboard.html, so the strip
// half of the acceptance test stays a live observation, not a unit test.

export type NudgeSkipReason =
  | "has_hover_order"
  | "real_activity_since_created"
  | "ineligible_status"
  | "opted_out";

/** One activity_log row, as the handler selects it. */
export interface ActivityLogRow {
  user_id: string;
  event_type: string;
  metadata?: { claim_id?: string; nudge_stage?: string } | null;
  created_at: string;
}

export interface ReducedActivity {
  /** user_id -> ISO timestamp of the latest REAL (non-self-generated) row. */
  realActivityByUser: Map<string, string>;
  /** claim_id -> (stage -> ISO created_at of the EARLIEST stamp for it). */
  nudgeSentByClaim: Map<string, Map<NudgeStage, string>>;
}

/**
 * Reduce the raw activity_log read into the two maps the per-claim screen
 * needs. Two event types are deliberately NOT "real homeowner activity":
 *
 *   - our own `nudgeEventType` stamp — otherwise the '2h' send would itself
 *     disqualify the claim from ever reaching '48h';
 *   - the `optOutEventType` row — clicking "Stop these updates" is not
 *     progress on the claim, and counting it would also change what the
 *     admin dashboard's "no activity since signup" strip shows.
 */
export function reduceActivityRows(
  rows: readonly ActivityLogRow[],
  nudgeEventType: string,
  optOutEventType: string,
): ReducedActivity {
  const realActivityByUser = new Map<string, string>();
  const nudgeSentByClaim = new Map<string, Map<NudgeStage, string>>();

  for (const row of rows) {
    if (row.event_type === optOutEventType) continue;
    if (row.event_type === nudgeEventType) {
      const md = row.metadata || {};
      if (md.claim_id && (md.nudge_stage === "2h" || md.nudge_stage === "48h")) {
        let stages = nudgeSentByClaim.get(md.claim_id);
        if (!stages) {
          stages = new Map<NudgeStage, string>();
          nudgeSentByClaim.set(md.claim_id, stages);
        }
        const prevStamp = stages.get(md.nudge_stage as NudgeStage);
        // If the same stage was stamped more than once (pre-unique-index
        // race, #1725) the EARLIEST stamp wins.
        if (!prevStamp || row.created_at < prevStamp) {
          stages.set(md.nudge_stage as NudgeStage, row.created_at);
        }
      }
      continue;
    }
    const prev = realActivityByUser.get(row.user_id);
    if (!prev || row.created_at > prev) {
      realActivityByUser.set(row.user_id, row.created_at);
    }
  }

  return { realActivityByUser, nudgeSentByClaim };
}

export interface ScreenClaim extends StageClaim {
  user_id: string;
  status: string;
}

export interface ClaimDecision {
  /** The one stage to send this run, or null for "send nothing". */
  stage: NudgeStage | null;
  /** Set only when the claim was screened OUT before stage selection. */
  skipped_reason?: NudgeSkipReason;
}

/**
 * The per-claim screen, in the handler's own order. Order is load-bearing:
 * an opted-out claim must cost no reads and must never be stamped, so the
 * opt-out gate runs before the hover/activity gates and before selectStage.
 */
export function screenClaim(
  claim: ScreenClaim,
  ctx: {
    optedOutClaimIds: ReadonlySet<string>;
    claimIdsWithHoverOrder: ReadonlySet<string>;
    reduced: ReducedActivity;
    now: number;
  },
): ClaimDecision {
  if (!isNudgeEligibleStatus(claim.status)) {
    return { stage: null, skipped_reason: "ineligible_status" };
  }
  if (ctx.optedOutClaimIds.has(claim.id)) {
    return { stage: null, skipped_reason: "opted_out" };
  }
  if (ctx.claimIdsWithHoverOrder.has(claim.id)) {
    return { stage: null, skipped_reason: "has_hover_order" };
  }
  const lastReal = ctx.reduced.realActivityByUser.get(claim.user_id);
  if (lastReal && lastReal > claim.created_at) {
    return { stage: null, skipped_reason: "real_activity_since_created" };
  }
  const emptySends: ReadonlyMap<NudgeStage, string> = new Map();
  return {
    stage: selectStage(claim, ctx.reduced.nudgeSentByClaim.get(claim.id) ?? emptySends, ctx.now),
  };
}
