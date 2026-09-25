// gh-2154 P-5 go-live (Ben, bus 2026-09-25T22:17:42Z item 2) — the Meta-lead
// invite's 48h reminder email. Pure, injected-dependency sweep logic, same
// shape as send-partner-onboarding/run-sweep.ts, reduced to ONE stage
// ("invite_reminder") instead of four -- no backlog/skip-supersession math
// is needed because there is only one due-or-not check, not a sequence.
//
// Reuses P-4's own partner_onboarding_sends ledger + claim_partner_
// onboarding_stage() atomic claim (see the migration this build adds:
// 20260925222500_gh2154_p5_invite_reminder_stage.sql, which only widens
// that function's stage CHECK constraint -- the function itself is
// unchanged). That is deliberate, not a shortcut: it means this reminder
// inherits, for free, every hardening #2191 already proved on prod --
// at-most-one-claim-in-flight, a 'pending' row is NEVER auto-reclaimed
// (surfaced as uncertain instead), and 'failed' retries are capped
// (attempt_count < 5 AND NOT terminal_failure) -- "treat uncertain
// outcomes the way P-4 does after #2191" (this task's own brief) is true
// by construction, not by re-implementation.

export const REMINDER_STAGE = "invite_reminder";
export const REMINDER_DELAY_MS = 48 * 60 * 60 * 1000;

export interface ReminderCandidate {
  id: string;
  email: string | null;
  first_name: string | null;
  agent_type: string;
  created_at: string;
  partner_agreement_accepted_at: string | null;
  status: string;
  meta_lead_id: string | null;
}

/**
 * Ben, DECIDED (bus 14:11:18Z, P-5 LEGAL ruling, carried here): only a
 * still-'pending', webhook-sourced (meta_lead_id set), NOT-yet-accepted
 * row is reminder-eligible. "Skip anyone who has already accepted" (this
 * task's brief) is this same isInviteEligible shape from partner-invite-
 * accept/index.ts, restated here as its own pure function so this
 * directory has no cross-directory import.
 */
export function isReminderEligible(
  row: Pick<ReminderCandidate, "status" | "meta_lead_id" | "partner_agreement_accepted_at">,
): boolean {
  return row.status === "pending" &&
    typeof row.meta_lead_id === "string" && row.meta_lead_id.length > 0 &&
    row.partner_agreement_accepted_at == null;
}

/** Fails CLOSED on a malformed created_at — never guess "due" from a NaN
 * age, same posture as onboarding-stage.ts's selectStage. */
export function isReminderDue(createdAtIso: string, nowMs: number): boolean {
  const createdMs = new Date(createdAtIso).getTime();
  if (Number.isNaN(createdMs)) return false;
  return nowMs - createdMs >= REMINDER_DELAY_MS;
}

export interface SendResult {
  ok: boolean;
  mailgunId?: string;
  error?: string;
  /** A response WAS received but not ok, AND it is not a transient 429 —
   * mirrors send-partner-onboarding's own permanent/retry-cap posture. */
  permanent?: boolean;
  /** No response was ever confirmed (thrown fetch, timeout) — the send
   * outcome is UNKNOWN, never auto-retried (see header comment). */
  uncertain?: boolean;
}

export interface RunDeps {
  now: number;
  fetchCandidates: () => Promise<ReminderCandidate[]>;
  /** RPC wrapper for claim_partner_onboarding_stage(id, 'invite_reminder'). */
  claim: (partnerId: string) => Promise<boolean>;
  buildOptOutUrl: (partnerId: string) => Promise<string>;
  sendEmail: (args: { to: string; firstName: string; agentType: string; partnerId: string; optOutUrl: string }) => Promise<SendResult>;
  markSent: (partnerId: string, mailgunId: string | undefined) => Promise<{ error?: { message: string } }>;
  markFailed: (partnerId: string, error: string, terminal: boolean) => Promise<{ error?: { message: string } }>;
  /** Whether this partner's ledger row has already been alerted for the
   * CURRENT uncertain episode (uncertain_alerted_at IS NOT NULL) — same
   * dedupe P-4's own run-sweep.ts uses. */
  alreadyAlertedUncertain: (partnerId: string) => Promise<boolean>;
  markUncertainAlerted: (partnerId: string) => Promise<void>;
  alertAdminUncertain: (rows: readonly { partner_id: string; stage: string }[]) => Promise<void>;
}

export interface PartnerResult {
  partner_id: string;
  sent?: true;
  skipped_reason?: string;
}

export type SweepOutcome =
  | { ok: true; results: PartnerResult[]; uncertain: { partner_id: string }[] }
  | { ok: false; error: string };

export async function runReminderSweep(deps: RunDeps): Promise<SweepOutcome> {
  let candidates: ReminderCandidate[];
  try {
    candidates = await deps.fetchCandidates();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const results: PartnerResult[] = [];
  const uncertain: { partner_id: string }[] = [];
  const toAlert: { partner_id: string; stage: string }[] = [];

  for (const row of candidates) {
    if (!isReminderEligible(row)) {
      results.push({ partner_id: row.id, skipped_reason: "not_eligible" });
      continue;
    }
    if (!isReminderDue(row.created_at, deps.now)) {
      results.push({ partner_id: row.id, skipped_reason: "not_due" });
      continue;
    }
    if (!row.email) {
      results.push({ partner_id: row.id, skipped_reason: "no_email" });
      continue;
    }

    const claimed = await deps.claim(row.id);
    if (!claimed) {
      // Either already 'sent'/'skipped' (terminal), a still-'pending' row
      // from an in-flight/uncertain prior run (never reclaimed — see
      // header comment), or a 'failed' row past its retry cap.
      const alreadyAlerted = await deps.alreadyAlertedUncertain(row.id);
      results.push({ partner_id: row.id, skipped_reason: "not_claimed" });
      if (!alreadyAlerted) {
        // Surfacing here too (not just on a fresh-claim uncertain outcome
        // below) mirrors run-sweep.ts: a STALE pending row from an earlier
        // run must also reach the admin, not just a freshly-uncertain one.
        uncertain.push({ partner_id: row.id });
        toAlert.push({ partner_id: row.id, stage: REMINDER_STAGE });
      } else {
        uncertain.push({ partner_id: row.id });
      }
      continue;
    }

    const optOutUrl = await deps.buildOptOutUrl(row.id);
    let sendResult: SendResult;
    try {
      sendResult = await deps.sendEmail({
        to: row.email,
        firstName: row.first_name || "",
        agentType: row.agent_type,
        partnerId: row.id,
        optOutUrl,
      });
    } catch (err) {
      sendResult = { ok: false, uncertain: true, error: err instanceof Error ? err.message : String(err) };
    }

    if (sendResult.ok) {
      const { error } = await deps.markSent(row.id, sendResult.mailgunId);
      if (error) {
        results.push({ partner_id: row.id, skipped_reason: "mark_sent_failed" });
      } else {
        results.push({ partner_id: row.id, sent: true });
      }
      continue;
    }

    if (sendResult.uncertain) {
      // Ben, DECIDED (P-4 precedent, carried here): NEVER auto-retry an
      // uncertain outcome — the row stays 'pending' (claim_partner_
      // onboarding_stage already set that), never marked 'failed', so a
      // later run cannot silently double-send. Alert immediately.
      uncertain.push({ partner_id: row.id });
      toAlert.push({ partner_id: row.id, stage: REMINDER_STAGE });
      results.push({ partner_id: row.id, skipped_reason: "uncertain" });
      continue;
    }

    // Definite rejection: markFailed with the same permanent/retry
    // distinction P-4 uses (permanent 4xx-not-429 -> terminal_failure=true,
    // ending retries now; anything else -> retryable next tick).
    const { error: markErr } = await deps.markFailed(row.id, sendResult.error || "send_failed", !!sendResult.permanent);
    if (markErr) {
      results.push({ partner_id: row.id, skipped_reason: "mark_failed_failed" });
    } else {
      results.push({ partner_id: row.id, skipped_reason: "send_failed" });
    }
  }

  if (toAlert.length > 0) {
    try {
      await deps.alertAdminUncertain(toAlert);
      for (const row of toAlert) {
        await deps.markUncertainAlerted(row.partner_id);
      }
    } catch (_) {
      // Best-effort, same posture as P-4's own alertAdminUncertain failure
      // handling — never throws, never blocks the sweep's own response.
    }
  }

  return { ok: true, results, uncertain };
}
