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
  /** referral_agents.status — CHECK-constrained to 'pending' | 'active' |
   * 'suspended' (see the baseline schema). Ben, DECIDED (bus 14:11:18Z, P-5
   * LEGAL ruling): only 'active' partners enter the onboarding sequence —
   * see hasAcceptedAgreementAndIsActive below. */
  status: string;
  /** gh-1059's referral_agents.partner_agreement_accepted_at — NULL until a
   * real acceptance of partner-agreement.html is recorded (register_partner
   * sets this at signup time for every P-1 partner). Ben, DECIDED (bus
   * 14:11:18Z, P-5 LEGAL ruling): P-5's Meta webhook will create partner
   * rows BEFORE this is set (invited/pending, no acceptance) — those rows
   * must never enter the onboarding sequence ("your account is ready" is a
   * lie for a partner who hasn't agreed to anything yet). Checking for the
   * PRESENCE of a real acceptance record, rather than the ABSENCE of one
   * specific non-'active' status string, is what makes this robust to
   * whatever exact status P-5 actually uses. */
  partner_agreement_accepted_at: string | null;
}

/** Ben, DECIDED (bus 14:11:18Z, P-5 LEGAL ruling): the entry gate for the
 * whole sequence. Both conditions independently necessary — a partner could
 * in principle have one without the other (e.g. a future admin-reactivated
 * 'active' row that predates gh-1059 and has no acceptance timestamp at
 * all: 13 such pre-gh1059 rows exist per that migration's own column
 * comment). See the PartnerRow.partner_agreement_accepted_at doc comment
 * for why this checks for acceptance PRESENCE, not P-5's status ABSENCE. */
export function hasAcceptedAgreementAndIsActive(
  partner: Pick<PartnerRow, "status" | "partner_agreement_accepted_at">,
): boolean {
  return partner.status === "active" && partner.partner_agreement_accepted_at != null;
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
  reason?: "activated" | "opted_out" | "not_due" | "invalid_created_at" | "before_switch_enabled";
}

const EMPTY_SKIP: OnboardingStage[] = [];

/**
 * priorRecords: the stages already recorded for THIS partner, from the
 * partner_onboarding_sends ledger — any status, not just resolved ones (see
 * RESOLVED_STATUSES above for which ones actually block re-selection).
 */
export function selectStage(
  partner: Pick<PartnerRow, "created_at" | "app_first_signed_in_launch_at" | "onboarding_opted_out_at"> & {
    // gh-2154 P-5 (#2180 R-177 condition (4), carried by Kevin): optional so
    // every pre-existing call site/test that has no opinion on invite
    // acceptance keeps compiling unchanged. See the effectiveStartMs note
    // below for why this is COALESCEd with created_at, never used alone.
    partner_agreement_accepted_at?: string | null;
  },
  priorRecords: ReadonlyMap<OnboardingStage, LedgerStatus>,
  now: number,
  // Ben, DECIDED (bus 14:01:57Z, ruling a — REVIEW FAIL 5833587935): the
  // moment the kill switch was turned on (see kill-switch.ts's
  // parseOnboardingSwitch). A partner whose effective onboarding start (see
  // effectiveStartMs below) is BEFORE this moment never enters the
  // sequence, at any stage, ever — this is what stops turning the switch on
  // from blasting day0-through-day7 at every partner who signed up while it
  // was off. Optional and defaulting to -Infinity ("the switch has
  // effectively always been on") purely so every pre-existing test in this
  // file that has no opinion on switch timing keeps passing unchanged;
  // run-sweep.ts's real caller always passes the real value.
  switchEnabledSinceMs: number = -Infinity,
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

  // gh-2154 P-5 (#2180 R-177 condition (4)): the day-count clock starts at
  // real agreement ACCEPTANCE, never at row creation. A P-1 browser signup
  // stamps partner_agreement_accepted_at at the same instant as created_at,
  // so this changes nothing for them (COALESCE is a no-op). A P-5 Meta
  // webhook invite row, though, is created 'pending' with no acceptance —
  // meta-leadgen-webhook's insert and the partner's actual click on the
  // invite link (partner-invite-accept) can be days apart. Keying age to
  // created_at there would make an invite accepted 8 days after the webhook
  // fired look "8 days old" the instant it activates, jumping straight to
  // day7 ("Last reminder") as the FIRST email that partner ever gets, with
  // day0/1/3 all marked skipped as backlog before they were ever eligible
  // to receive one. Keying to acceptance instead makes day0 fire on their
  // actual first eligible run, same as every other partner. (hasAccepted-
  // AgreementAndIsActive() at the run-sweep.ts call site already means this
  // function is never even reached for a not-yet-accepted P-5 row, but the
  // age math itself must not silently fall back to created_at once it is.)
  const effectiveStartMs = new Date(partner.partner_agreement_accepted_at ?? partner.created_at).getTime();
  if (Number.isNaN(effectiveStartMs)) {
    // Fail closed on malformed data — never guess a stage from a NaN age.
    return { stage: null, toMarkSkipped: EMPTY_SKIP, reason: "invalid_created_at" };
  }

  // Ruling (a): a partner whose effective start is before the switch was
  // ever turned on never enters, permanently — same "checked before stage
  // math, no ledger writes at all" shape as the activated/opted_out gates
  // above.
  if (effectiveStartMs < switchEnabledSinceMs) {
    return { stage: null, toMarkSkipped: EMPTY_SKIP, reason: "before_switch_enabled" };
  }

  const ageMs = now - effectiveStartMs;
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
// Ben, DECIDED (orchestrator review of the P-4 fix round, ruling c
// REOPENED): the original "stale pending is reclaimable" branch below was
// itself the defect Kevin's Q3 correction was supposed to have eliminated.
// A 'pending' row with no recorded 'sent'/'failed' outcome means the send
// OUTCOME IS UNKNOWN — Mailgun may have accepted it right before the
// invocation crashed. Silently reclaiming it and sending again risks a real
// double-send to a real partner, which is strictly worse than a stage that
// waits for a human. Per Ben's words: "mark the stage sent-or-uncertain
// BEFORE calling Mailgun, never auto-reclaim a row whose send outcome is
// unknown (surface it instead)." A 'pending' row is now NEVER reclaimable
// by this function, however old — `now`/`staleMinutes` are kept in the
// signature only so existing/future callers don't need to change shape, but
// neither is consulted for the 'pending' branch any more. Staleness is
// still meaningful — see isUncertainPending below — but it now means
// "surface this for a human," never "safe to claim again."
// gh-2154 P-4 switch-on hardening (Ben, bus 18:23:17Z item (3) retry cap):
// mirrors claim_partner_onboarding_stage()'s NEW WHERE clause exactly (see
// supabase/migrations/20260925183000_gh2154_p4_switchon_retry_cap_uncertain_alert.sql
// and ./claim-stage-sql-proof.ts's byte-exact quoted copy). A 'failed' row
// is reclaimable ONLY while attempt_count is still under the cap AND it was
// never marked terminal_failure (a permanent 4xx Mailgun rejection ends
// retries immediately, before the count cap is even reached). 'pending'
// (any age), 'sent', and 'skipped' remain never-reclaimable, unchanged.
export const MAX_SEND_ATTEMPTS = 5;

export function canClaimStage(
  existing: { status: LedgerStatus; created_at: string; attempt_count?: number; terminal_failure?: boolean } | undefined,
  _now: number,
  _staleMinutes: number = STALE_PENDING_MINUTES,
): boolean {
  if (!existing) return true;
  if (existing.status !== "failed") return false; // 'pending' (any age), 'sent', or 'skipped' — never reclaimable
  if (existing.terminal_failure) return false; // permanent 4xx rejection — never retried, regardless of attempt_count
  const attempts = existing.attempt_count ?? 0;
  return attempts < MAX_SEND_ATTEMPTS;
}

/**
 * A 'pending' row older than staleMinutes is one whose send OUTCOME IS
 * UNKNOWN (see canClaimStage's comment above) — never auto-retried, but a
 * later run must still be able to find and report it so a human can decide
 * (check Mailgun's own logs for that message-id-less window, or just
 * manually mark it 'failed' to allow a retry). Ben, DECIDED: "surface it
 * instead" — run-sweep.ts calls this per (partner, stage) BEFORE attempting
 * a claim, and reports every true result in the sweep's own JSON output and
 * console.error, never silently.
 */
export function isUncertainPending(
  existing: { status: LedgerStatus; created_at: string } | undefined,
  now: number,
  staleMinutes: number = STALE_PENDING_MINUTES,
): boolean {
  if (!existing || existing.status !== "pending") return false;
  const claimedMs = new Date(existing.created_at).getTime();
  if (Number.isNaN(claimedMs)) return true; // fail toward surfacing, never toward silently ignoring bad data
  return now - claimedMs >= staleMinutes * 60 * 1000;
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
