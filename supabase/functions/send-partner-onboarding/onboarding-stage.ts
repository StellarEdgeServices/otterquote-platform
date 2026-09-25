// gh-2154 P-4 — pure stage-selection logic for send-partner-onboarding.
//
// Mirrors send-homeowner-next-steps/select-stage.ts's shape and its two CTO
// RUN 22 lessons (Marty's dispatch on #2154 quotes defect 2 directly: "an
// early version fired two stages back-to-back on a backlog"):
//
//   1. AT MOST ONE STAGE PER RUN. Four stages exist here (day0/1/3/7), not
//      two, so the backlog case is wider: a partner first scanned at, say,
//      9 days old with nothing recorded is due for day0, day1, day3 AND
//      day7 simultaneously. Only the LATEST unresolved due stage is sent;
//      every earlier unresolved due stage is marked SKIPPED (not silently
//      dropped, not sent) so it is never reconsidered on a later run.
//
//   2. STOP CONDITION. Once app_first_signed_in_launch_at IS NOT NULL,
//      nothing further sends — checked FIRST, before any stage math, and
//      fails toward "send nothing" the same way a malformed created_at does.
//      A partner who activates between day1 and day3 gets day0 and day1 (if
//      those runs already happened) and never day3 or day7 — activation is
//      a permanent gate checked at invocation time, not a one-time skip.
//      Same permanent-gate shape for onboarding_opted_out_at (Kevin
//      correction, Q1 / D-320 mirror): once set, nothing further sends,
//      checked alongside activation, before stage math.
//
// KEVIN CORRECTION (Q3, overruling this file's original "trade-off" framing
// of stamp-before-send): a ledger row must never say a stage was 'sent'
// before Mailgun has actually accepted it — that is precisely the defect
// gh-2069 fixed in send-homeowner-next-steps ("stops claiming 'sent' before
// it has sent," R-097). The ledger now has FOUR states, not two:
//   'pending'  — claimed by one run, in flight, not yet resolved.
//   'sent'     — Mailgun accepted it; terminal, resolved.
//   'failed'   — Mailgun rejected it, or the send threw; NOT terminal — a
//                failed stage is retried on a later run, same as a never-
//                attempted one.
//   'skipped'  — superseded by a later due stage on a backlog run; terminal,
//                resolved, per the RUN 22 lesson (unchanged from before).
// Only 'sent' and 'skipped' count as RESOLVED for selectStage's backlog
// math below — 'pending' and 'failed' are treated as still-due, so a failed
// or stale-pending stage is picked up again exactly like one that was never
// attempted. The atomic claim (canClaimStage below, enforced for real by a
// DB-level conditional upsert — see ../migrations/*_gh2154_p4_*) is what
// prevents two overlapping runs from both sending: only one call can
// transition a row into 'pending', so the loser sees "not claimed" and
// sends nothing.

export type OnboardingStage = "day0" | "day1" | "day3" | "day7";

export const DAY_MS = 24 * 60 * 60 * 1000;

// Ordered ascending — selectStage below relies on this order to find "the
// latest unresolved due stage" by taking the last element of a filtered scan.
export const STAGE_ORDER: readonly OnboardingStage[] = ["day0", "day1", "day3", "day7"];

export const STAGE_THRESHOLD_MS: Readonly<Record<OnboardingStage, number>> = {
  day0: 0,
  day1: 1 * DAY_MS,
  day3: 3 * DAY_MS,
  day7: 7 * DAY_MS,
};

export type LedgerStatus = "sent" | "skipped" | "pending" | "failed";

/** Only these two are terminal/resolved for backlog purposes — see the
 * Kevin-correction block comment above. */
const RESOLVED_STATUSES: ReadonlySet<LedgerStatus> = new Set(["sent", "skipped"]);

/** A 'pending' claim older than this is stale — treated as abandoned (a
 * crashed or timed-out invocation) and reclaimable by a later run. Set well
 * above the 15-minute cron tick (see the cron migration) so a genuinely
 * in-flight send from the immediately-previous tick is never reclaimed out
 * from under itself. */
export const STALE_PENDING_MINUTES = 20;

export interface PartnerRow {
  id: string;
  created_at: string;
  agent_type: string;
  is_test: boolean;
  email: string | null;
  /** Used for the {{first_name}} merge field in the copy (gh-2154 P-4
   * approved copy, comment 5821400303). Falls back to "there" when null,
   * same convention as send-homeowner-next-steps' buildEmailContent. */
  first_name: string | null;
  /** NULL until the partner first signs in to the standalone app (P-2). */
  app_first_signed_in_launch_at: string | null;
  /** NULL until the partner clicks the D-320-style unsubscribe link (Kevin
   * correction, Q1). Once set, permanent — same shape as activation. */
  onboarding_opted_out_at: string | null;
}

export interface StageSelection {
  /** The one stage to send this run, or null for "send nothing". */
  stage: OnboardingStage | null;
  /** Earlier due-but-unresolved stages superseded by `stage` (or, when
   * `stage` is null because of activation/bad data, ALWAYS empty — a gated
   * partner gets no ledger writes at all, not even skip rows, since nothing
   * about the run should touch that partner going forward). */
  toMarkSkipped: OnboardingStage[];
  /** Set only when `stage` is null because of the stop condition — lets the
   * caller report a specific reason instead of a bare "nothing to do". */
  reason?: "activated" | "opted_out" | "not_due" | "invalid_created_at";
}

const EMPTY_SKIP: OnboardingStage[] = [];

/**
 * priorRecords: the stages already recorded for THIS partner, from the
 * partner_onboarding_sends ledger — any status, not just resolved ones (see
 * RESOLVED_STATUSES above for which ones actually block re-selection).
 */
export function selectStage(
  partner: Pick<PartnerRow, "created_at" | "app_first_signed_in_launch_at" | "onboarding_opted_out_at">,
  priorRecords: ReadonlyMap<OnboardingStage, LedgerStatus>,
  now: number,
): StageSelection {
  // Stop conditions FIRST — checked before stage math, before the
  // created_at parse, before anything. Once either is set, this partner is
  // done, permanently. Opt-out checked ahead of activation only because
  // it's the newer of the two gates; order between these two never matters
  // in practice (either alone is sufficient to stop everything).
  if (partner.onboarding_opted_out_at != null) {
    return { stage: null, toMarkSkipped: EMPTY_SKIP, reason: "opted_out" };
  }
  if (partner.app_first_signed_in_launch_at != null) {
    return { stage: null, toMarkSkipped: EMPTY_SKIP, reason: "activated" };
  }

  const createdMs = new Date(partner.created_at).getTime();
  if (Number.isNaN(createdMs)) {
    // Fail closed on malformed data — never guess a stage from a NaN age.
    return { stage: null, toMarkSkipped: EMPTY_SKIP, reason: "invalid_created_at" };
  }

  const ageMs = now - createdMs;
  if (ageMs < 0) {
    // Clock-skewed future created_at — not due for anything yet.
    return { stage: null, toMarkSkipped: EMPTY_SKIP, reason: "not_due" };
  }

  const due = STAGE_ORDER.filter((s) => ageMs >= STAGE_THRESHOLD_MS[s]);
  // Kevin correction (Q3): a stage counts as resolved (blocks re-selection)
  // ONLY if its recorded status is 'sent' or 'skipped'. A 'pending' or
  // 'failed' record is still due — same as no record at all — so a failed
  // send or a stale in-flight claim is picked up again by a later run.
  const unresolved = due.filter((s) => {
    const status = priorRecords.get(s);
    return status === undefined || !RESOLVED_STATUSES.has(status);
  });

  if (unresolved.length === 0) {
    return { stage: null, toMarkSkipped: EMPTY_SKIP, reason: "not_due" };
  }

  // The latest (highest-threshold) unresolved due stage wins; everything
  // earlier in `unresolved` is backlog to be marked skipped, never sent.
  const stage = unresolved[unresolved.length - 1];
  const toMarkSkipped = unresolved.slice(0, -1);
  return { stage, toMarkSkipped };
}

/**
 * PURE decision mirror of the DB-level atomic claim (see
 * claim_partner_onboarding_stage() in the ledger migration): given the
 * CURRENT ledger row for (partner, stage) — or undefined if none exists —
 * may this run claim it? The real concurrency guarantee comes from the
 * database's conditional `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE`
 * (only one concurrent caller's UPDATE can match), NOT from this function;
 * this function exists so the DECISION boundary itself (which existing
 * states are reclaimable) is unit-testable without a database, and so the
 * SQL function's WHERE clause can be reviewed against it for a literal
 * match.
 */
export function canClaimStage(
  existing: { status: LedgerStatus; created_at: string } | undefined,
  now: number,
  staleMinutes: number = STALE_PENDING_MINUTES,
): boolean {
  if (!existing) return true;
  if (existing.status === "failed") return true;
  if (existing.status === "pending") {
    const claimedMs = new Date(existing.created_at).getTime();
    if (Number.isNaN(claimedMs)) return false; // fail closed on bad data
    return now - claimedMs >= staleMinutes * 60 * 1000;
  }
  return false; // 'sent' or 'skipped' — never reclaimable
}

// ─── agent_type routing ─────────────────────────────────────────────────────

export const ELIGIBLE_AGENT_TYPES = ["re_agent", "insurance_agent", "home_inspector"] as const;
export type EligibleAgentType = (typeof ELIGIBLE_AGENT_TYPES)[number];

/** re_agent / insurance_agent / home_inspector get the sequence; every other
 * agent_type (customer, adjuster, other, and anything unrecognized) gets
 * none — #2154 P-4 spec: "others get none, and say which" (see this
 * function's callers / the build report for the "which"). */
export function isEligibleAgentType(agentType: string | null | undefined): agentType is EligibleAgentType {
  return (ELIGIBLE_AGENT_TYPES as readonly string[]).includes(agentType ?? "");
}
