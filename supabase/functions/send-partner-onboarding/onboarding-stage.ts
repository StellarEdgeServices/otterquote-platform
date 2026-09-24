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

export type LedgerStatus = "sent" | "skipped";

export interface PartnerRow {
  id: string;
  created_at: string;
  agent_type: string;
  is_test: boolean;
  email: string | null;
  /** NULL until the partner first signs in to the standalone app (P-2). */
  app_first_signed_in_launch_at: string | null;
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
  reason?: "activated" | "not_due" | "invalid_created_at";
}

const EMPTY_SKIP: OnboardingStage[] = [];

/**
 * priorRecords: the stages already resolved (sent OR skipped) for THIS
 * partner, from the partner_onboarding_sends ledger.
 */
export function selectStage(
  partner: Pick<PartnerRow, "created_at" | "app_first_signed_in_launch_at">,
  priorRecords: ReadonlyMap<OnboardingStage, LedgerStatus>,
  now: number,
): StageSelection {
  // Stop condition FIRST — checked before stage math, before the created_at
  // parse, before anything. Once set, this partner is done, permanently.
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
  const unresolved = due.filter((s) => !priorRecords.has(s));

  if (unresolved.length === 0) {
    return { stage: null, toMarkSkipped: EMPTY_SKIP, reason: "not_due" };
  }

  // The latest (highest-threshold) unresolved due stage wins; everything
  // earlier in `unresolved` is backlog to be marked skipped, never sent.
  const stage = unresolved[unresolved.length - 1];
  const toMarkSkipped = unresolved.slice(0, -1);
  return { stage, toMarkSkipped };
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
