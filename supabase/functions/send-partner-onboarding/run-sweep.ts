// gh-2154 P-4 — the injected-dependency sweep executor, testable with fake
// dependencies (no Supabase, no Mailgun, no database) — same shape as
// send-homeowner-next-steps/admin-digest-executor.ts and ./deliver-stage.ts
// in that same directory. index.ts wires the real Supabase/Mailgun-backed
// deps and calls runOnboardingSweep(); every test in run-sweep.test.ts calls
// it with recording fakes instead.
//
// GUARD ORDER (load-bearing, each one tested independently in
// run-sweep.test.ts):
//   1. Kill switch (platform_settings.partner_onboarding_enabled === true).
//      OFF, unset, or unreadable -> {ok:true, skipped:'disabled'}, ZERO
//      reads of referral_agents or the ledger.
//   2. Opt-out secret configured (Kevin correction Q1, mirrors D-320's
//      canSendWithOptOut CAN-SPAM gate exactly) — unset -> {ok:true,
//      skipped:'no_optout_secret'}, same "send nothing rather than send
//      without a working opt-out" posture. Checked ahead of any candidate
//      scan, same position D-320 uses in send-homeowner-next-steps/index.ts.
//   3. Stop conditions (selectStage's activation AND opt-out gates) — per
//      partner.
//   4. agent_type routing — per partner.
//   4a. Agreement-acceptance + active-status gate (P-5 LEGAL ruling) — per
//      partner; see hasAcceptedAgreementAndIsActive.
//   5. Bot-pattern skip — only for non-is_test partners (is_test wins,
//      matching notify-admin-new-partner's P-3 convention exactly).
//   6. Placeholder-copy gate — per partner, on the FINAL composed copy
//      (per-stage body + [TEST] prefix + the D-320-mirrored unsubscribe
//      line with this partner's real link substituted in), so a bug in any
//      earlier transform step can never accidentally hide a placeholder
//      marker from this check.
//   6a. Uncertain-pending check (ruling c, REOPENED) — a stale 'pending' row
//      for this exact (partner, stage) is an UNKNOWN outcome, surfaced and
//      skipped, never auto-retried. See isUncertainPending.
//   7. Atomic claim (Kevin correction Q3) — only after every skip gate above
//      has passed does this run attempt to claim the (partner, stage) row.
//
// KEVIN CORRECTION (Q3), REOPENED by Ben (orchestrator review of the P-4 fix
// round): the original version of this file stamped a ledger row 'sent'
// BEFORE calling Mailgun — exactly the defect gh-2069 fixed in
// send-homeowner-next-steps ("stops claiming 'sent' before it has sent").
// The FIRST correction round still let a stale 'pending' claim be silently
// RECLAIMED by a later run — which is itself a double-send risk: a crash
// right after Mailgun accepted the message leaves a 'pending' row whose
// TRUE outcome is unknown, and reclaiming it sends again. The current shape:
//   (a) claimStage(partnerId, stage) — an ATOMIC claim, enforced at the
//       database level by a conditional upsert (see
//       claim_partner_onboarding_stage() in the ledger migration) that can
//       only transition a row into 'pending' if no row exists yet, or the
//       existing row is 'failed'. A 'pending' row — of ANY age — is NEVER
//       reclaimable; only 'failed' is retried automatically.
//   (b) sendEmail — only after the claim succeeds.
//   (c) markSent(partnerId, stage, mailgunId) on acceptance, or
//       markFailed(partnerId, stage, error) on rejection/throw. A 'failed'
//       row is NOT terminal (see onboarding-stage.ts's selectStage) — a
//       later run retries it exactly like a stage that was never attempted.
// A losing claim (claimed:false) on a NON-stale row means another run
// currently owns this (partner, stage) — reported as 'already_sent', Mailgun
// never called. A stale 'pending' row (guard 6a, checked BEFORE the claim
// attempt) is reported as 'uncertain' instead, in both the per-partner
// result and the sweep's own `uncertain` list — surfaced for a human, never
// auto-retried.

import {
  type EligibleAgentType,
  hasAcceptedAgreementAndIsActive,
  isUncertainPending,
  type LedgerStatus,
  type OnboardingStage,
  type PartnerRow,
  selectStage,
  STALE_PENDING_MINUTES,
} from "./onboarding-stage.ts";
import { composeFinalCopy, getCopyForAgentType, hasPlaceholderCopy } from "./copy.ts";
import { parseOnboardingSwitch } from "./kill-switch.ts";
import { isAlwaysExcludedAddress, isTestAccount } from "./bot-pattern.ts";

export interface LedgerRow {
  partner_id: string;
  stage: OnboardingStage;
  status: LedgerStatus;
  /** Required, not optional — every real row has one (DB `DEFAULT now()
   * NOT NULL`); isUncertainPending needs it to judge staleness, and a
   * missing value on a 'pending' row fails TOWARD surfacing it, never
   * toward silently ignoring it (see that function's own comment). */
  created_at: string;
  /** gh-2154 P-4 switch-on hardening (item (2), admin-alert dedupe): NULL
   * until this row has already been included in an uncertain-outcome admin
   * alert. Only meaningful on a 'pending' row that isUncertainPending finds
   * stale — used below to decide whether THIS run needs to (re-)alert for
   * it, so a still-pending uncertain row is not re-alerted every 15-minute
   * tick forever. Optional so every pre-existing test/fake in this file
   * that has no opinion on alert history keeps compiling unchanged. */
  uncertain_alerted_at?: string | null;
}

/** Surfaced by the sweep for a human to act on — never auto-retried. See
 * onboarding-stage.ts's isUncertainPending for what "uncertain" means and
 * why (Ben, DECIDED: "mark the stage sent-or-uncertain BEFORE calling
 * Mailgun, never auto-reclaim a row whose send outcome is unknown"). */
export interface UncertainStage {
  partner_id: string;
  stage: OnboardingStage;
}

export type SkipReason =
  | "activated"
  | "opted_out"
  | "not_due"
  | "invalid_created_at"
  | "before_switch_enabled" // ruling (a): created before the switch's enabled_since
  | "ineligible_agent_type"
  | "agreement_not_accepted" // P-5 LEGAL ruling (bus 14:11:18Z): no recorded acceptance, or status != 'active'
  | "placeholder_copy"
  | "bot_pattern"
  | "internal_test_domain" // ruling (b): unconditional, even if is_test=true
  | "no_email"
  | "send_failed"
  | "already_sent" // lost the atomic claim race
  | "uncertain"; // ruling (c) reopened: a stale 'pending' row — outcome unknown, surfaced, never auto-retried

export interface PartnerResult {
  partner_id: string;
  sent?: OnboardingStage;
  /** Backlog-superseded stages marked skipped THIS run (RUN 22 lesson —
   * persisted, never silently dropped). */
  skipped_stages?: OnboardingStage[];
  skipped_reason?: SkipReason;
}

export interface MarkResult {
  error: { code?: string; message?: string } | null;
}

export interface SendEmailResult {
  ok: boolean;
  mailgunId?: string;
  error?: string;
  /** Orchestrator review of 50a59e50 (fix round 3): true when `ok` is false
   * because NO response was ever received (a thrown fetch — connection
   * reset, DNS failure, timeout) rather than because a response WAS
   * received and it was a non-2xx rejection. Only meaningful when
   * ok === false. A definite rejection (uncertain unset/false) is safe to
   * retry (markFailed, reclaimable). An uncertain one is NOT — Mailgun may
   * have already accepted the message right before the connection dropped
   * — see the per-partner loop below, which leaves the ledger row
   * 'pending' (never markFailed) and surfaces it in the sweep's own
   * `uncertain` list immediately, rather than waiting for it to go stale. */
  uncertain?: boolean;
  /** gh-2154 P-4 switch-on hardening (item (3) retry cap): true only when
   * `ok` is false because a response WAS received (a definite rejection,
   * uncertain is falsy) AND it was a PERMANENT failure — a 4xx status
   * OTHER than 429 (which is a rate limit and is retried like a 5xx).
   * Meaningful only when ok === false && !uncertain. A permanent failure
   * is routed to markFailed(..., terminal: true), which sets
   * terminal_failure on the ledger row so it is never retried again,
   * regardless of attempt_count. Undefined/false means "retry as usual,
   * subject to the MAX_SEND_ATTEMPTS cap" (a 5xx, a 429, or any other
   * non-2xx this function doesn't recognize as permanent). */
  permanent?: boolean;
}

type CopyLookup = (agentType: EligibleAgentType, stage: OnboardingStage) => { subject: string; textBody: string; htmlBody: string } | null;

export interface RunDeps {
  /** Reads platform_settings for PARTNER_ONBOARDING_SETTING_KEY. Returning
   * null/undefined, or throwing, both mean "unreadable" and must fail
   * closed — the caller wraps this in try/catch. */
  readSetting: () => Promise<{ value: unknown } | null>;
  /** Whether an opt-out signing secret is configured — computed once by
   * index.ts (mirrors D-320's canSendWithOptOut). false means "send
   * nothing, for anyone, this run" — same CAN-SPAM posture as the
   * homeowner function's own OPTOUT_SECRET gate. */
  optOutSecretConfigured: boolean;
  fetchCandidatePartners: () => Promise<PartnerRow[]>;
  fetchLedgerForPartners: (partnerIds: string[]) => Promise<LedgerRow[]>;
  /** Attempts the atomic (partner, stage) claim. Production: a single RPC
   * call to claim_partner_onboarding_stage() (conditional upsert). Tests:
   * a fake enforcing the SAME decision boundary as
   * onboarding-stage.ts's canClaimStage, against shared in-memory state, so
   * a losing concurrent call is exercised for real (see run-sweep.test.ts's
   * "concurrent double claim" test). */
  claimStage: (partnerId: string, stage: OnboardingStage) => Promise<{ claimed: boolean }>;
  markSent: (partnerId: string, stage: OnboardingStage, mailgunId: string | null) => Promise<MarkResult>;
  /** gh-2154 P-4 switch-on hardening (item (3)): `terminal` true means a
   * PERMANENT rejection (a 4xx other than 429) — the real implementation
   * sets partner_onboarding_sends.terminal_failure = true, which
   * claim_partner_onboarding_stage() then refuses to ever reclaim, no
   * matter how low attempt_count is. `terminal` false/omitted means an
   * ordinary retryable failure (5xx, 429, or a fetch that threw and was
   * NOT classified as `uncertain`) — retried on a later run same as
   * before, up to the MAX_SEND_ATTEMPTS cap enforced by the claim
   * function itself. */
  markFailed: (partnerId: string, stage: OnboardingStage, error: string, terminal?: boolean) => Promise<MarkResult>;
  markSkipped: (partnerId: string, stage: OnboardingStage, reason: string) => Promise<MarkResult>;
  /** gh-2154 P-4 switch-on hardening (item (2)): sends ONE summary admin
   * alert email for every row in `stages`, reusing
   * notify-admin-new-partner's Mailgun/ADMIN_EMAIL pattern (see
   * ./admin-alert.ts). Called at most once per sweep run, only when there
   * is at least one row that has not already been alerted for (see
   * markUncertainAlerted below) — never per-partner, so a run with many
   * uncertain rows pages Dustin once, not N times. */
  alertAdminUncertain: (stages: readonly UncertainStage[]) => Promise<{ ok: boolean; error?: string }>;
  /** Marks every row in `stages` as alerted (uncertain_alerted_at = now()),
   * so a still-pending uncertain row is not re-alerted on the next tick.
   * Called only after alertAdminUncertain succeeds. */
  markUncertainAlerted: (stages: readonly UncertainStage[]) => Promise<MarkResult>;
  /** Builds this partner's real, signed, per-partner unsubscribe URL. Only
   * called when optOutSecretConfigured is true. */
  buildOptOutUrl: (partnerId: string) => Promise<string>;
  /** `optOutUrl` (Ben SHOULD, mirroring gh-1786/D-320's own
   * send-homeowner-next-steps sendMailgunEmail): the real Mailgun-backed
   * implementation attaches it as the RFC 8058 `List-Unsubscribe` /
   * `List-Unsubscribe-Post` headers, same link the footer already carries.
   * Tests that don't care about that header simply ignore the argument. */
  sendEmail: (to: string, subject: string, textBody: string, htmlBody: string, optOutUrl: string) => Promise<SendEmailResult>;
  log?: (level: "log" | "warn" | "error", message: string) => void;
  now: number;
  /** Copy lookup, defaulting to ./copy.ts's real (placeholder) table.
   * Overridable ONLY by tests, to exercise the full send/idempotency/[TEST]-
   * prefix path with non-placeholder copy without touching the real
   * Tier C module. index.ts never overrides this. */
  getCopy?: CopyLookup;
  /** Unsubscribe line template, defaulting to ./copy.ts's real (placeholder)
   * one. Overridable ONLY by tests, same reason as getCopy. */
  getUnsubLineTemplate?: () => string;
}

export type SweepOutcome =
  | { ok: true; skipped: "disabled" | "no_optout_secret" }
  | { ok: true; results: PartnerResult[]; uncertain?: UncertainStage[] };

export async function runOnboardingSweep(deps: RunDeps): Promise<SweepOutcome> {
  const say = deps.log ?? (() => {});

  // ── Guard 1: kill switch — fails closed on OFF, unset, malformed, or a
  // read error. Ruling (a): "on" now REQUIRES an enabled_since timestamp
  // (see kill-switch.ts's parseOnboardingSwitch) — a bare `true` no longer
  // counts, and the parsed enabledSinceMs is threaded into every partner's
  // selectStage call below so a partner who signed up before this moment
  // never enters the sequence. ─────────────────────────────────────────────
  let settingValue: unknown = null;
  try {
    const row = await deps.readSetting();
    settingValue = row?.value ?? null;
  } catch (err) {
    say("warn", `partner_onboarding_enabled read failed — treating as disabled: ${String(err)}`);
    settingValue = null;
  }
  const switchState = parseOnboardingSwitch(settingValue);
  if (!switchState.enabled) {
    return { ok: true, skipped: "disabled" };
  }
  const switchEnabledSinceMs = switchState.enabledSinceMs;

  // ── Guard 2 (Kevin correction Q1): CAN-SPAM opt-out gate, ahead of any
  // candidate scan — same position and posture as D-320's canSendWithOptOut
  // check in send-homeowner-next-steps/index.ts. ─────────────────────────
  if (!deps.optOutSecretConfigured) {
    say("error", "opt-out signing secret is not configured — refusing to send: every onboarding email must carry a working unsubscribe link");
    return { ok: true, skipped: "no_optout_secret" };
  }

  const partners = await deps.fetchCandidatePartners();
  if (partners.length === 0) {
    return { ok: true, results: [] };
  }

  const ledgerRows = await deps.fetchLedgerForPartners(partners.map((p) => p.id));
  const ledgerByPartner = new Map<string, Map<OnboardingStage, LedgerStatus>>();
  // Ruling (c) reopened: a second index, keyed the same way, but holding the
  // FULL row (status + created_at) — selectStage only ever needs status
  // (RESOLVED_STATUSES), but isUncertainPending below needs created_at too,
  // to judge staleness for the SPECIFIC stage this run is about to attempt.
  const ledgerRowByPartner = new Map<string, Map<OnboardingStage, LedgerRow>>();
  for (const row of ledgerRows) {
    let m = ledgerByPartner.get(row.partner_id);
    if (!m) {
      m = new Map();
      ledgerByPartner.set(row.partner_id, m);
    }
    m.set(row.stage, row.status);

    let rm = ledgerRowByPartner.get(row.partner_id);
    if (!rm) {
      rm = new Map();
      ledgerRowByPartner.set(row.partner_id, rm);
    }
    rm.set(row.stage, row);
  }

  const results: PartnerResult[] = [];
  const uncertain: UncertainStage[] = [];
  // gh-2154 P-4 switch-on hardening (item (2)): the SUBSET of `uncertain`
  // that still needs an admin alert THIS run — a pre-existing stale
  // 'pending' row already alerted on a prior run (existingRow.
  // uncertain_alerted_at set) is reported in `uncertain` (so the JSON
  // response and console.error keep listing every currently-uncertain
  // row) but NOT re-added here, so it is not re-alerted every tick. A row
  // that just became uncertain THIS run (either branch below) always goes
  // in both.
  const toAlert: UncertainStage[] = [];

  for (const partner of partners) {
    const prior = ledgerByPartner.get(partner.id) ?? new Map<OnboardingStage, LedgerStatus>();
    const selection = selectStage(partner, prior, deps.now, switchEnabledSinceMs);

    // Backlog-superseded stages: persisted as 'skipped' regardless of
    // whether the winning stage itself ends up sending — RUN 22's lesson is
    // that these must never be reconsidered on a later run.
    for (const stage of selection.toMarkSkipped) {
      const { error } = await deps.markSkipped(partner.id, stage, "superseded_by_backlog");
      if (error && error.code !== "23505") {
        say("error", `failed to record skipped stage ${stage} for partner ${partner.id}: ${error.message ?? ""}`);
      }
    }

    if (selection.stage === null) {
      results.push({
        partner_id: partner.id,
        skipped_reason: selection.reason,
        ...(selection.toMarkSkipped.length ? { skipped_stages: selection.toMarkSkipped } : {}),
      });
      continue;
    }

    const stage = selection.stage;
    const withSkips = (reason: SkipReason): PartnerResult => ({
      partner_id: partner.id,
      skipped_reason: reason,
      ...(selection.toMarkSkipped.length ? { skipped_stages: selection.toMarkSkipped } : {}),
    });

    if (!partner.agent_type || !["re_agent", "insurance_agent", "home_inspector"].includes(partner.agent_type)) {
      results.push(withSkips("ineligible_agent_type"));
      continue;
    }
    const agentType = partner.agent_type as EligibleAgentType;
    const isTest = partner.is_test === true;

    // Ben, DECIDED (bus 14:11:18Z, P-5 LEGAL ruling): P-5's Meta webhook
    // will create partner rows that are NOT active and have NO recorded
    // agreement acceptance until the real signup/accept step completes.
    // "Your account is ready" is false for such a row — checked ahead of
    // email/bot-pattern/copy, same "never even builds copy for an
    // out-of-scope partner" posture as the agent_type check above.
    if (!hasAcceptedAgreementAndIsActive(partner)) {
      results.push(withSkips("agreement_not_accepted"));
      continue;
    }

    const email = partner.email ?? null;
    if (!email) {
      results.push(withSkips("no_email"));
      continue;
    }

    // Ruling (b): @otterquote-internal.test / founder ("stohler") / any
    // .invalid or .test domain is excluded UNCONDITIONALLY — checked BEFORE
    // is_test, and wins even when is_test=true (P-3's own precedent for the
    // otterquote-internal.test half of this: REVIEW FAIL 5832785581
    // should-fix 1 — walk-bot runs must never alert/send at all).
    if (isAlwaysExcludedAddress(email)) {
      results.push(withSkips("internal_test_domain"));
      continue;
    }

    // is_test wins over the (non-internal-test-domain) bot-pattern skip
    // (P-3 convention, verbatim): only a NON-is_test row matching a bot
    // pattern is skipped. Checked before any copy is built — a bot account
    // should never even reach the placeholder-copy gate, let alone the
    // claim step.
    if (!isTest && isTestAccount(email)) {
      results.push(withSkips("bot_pattern"));
      continue;
    }

    const copyLookup: CopyLookup = deps.getCopy ?? getCopyForAgentType;
    const baseCopy = copyLookup(agentType, stage)!;
    const subjectPrefix = isTest ? "[TEST] " : "";
    const optOutUrl = await deps.buildOptOutUrl(partner.id);
    const finalCopy = deps.getUnsubLineTemplate
      ? composeFinalCopy(baseCopy, optOutUrl, subjectPrefix, deps.getUnsubLineTemplate(), partner.first_name)
      : composeFinalCopy(baseCopy, optOutUrl, subjectPrefix, undefined, partner.first_name);

    // Checked on the FINAL composed copy (stage body + [TEST] prefix + the
    // unsubscribe line) — a bug in any earlier step can never mask a
    // placeholder marker from this gate. This runs BEFORE the claim, so a
    // placeholder-blocked stage is never claimed and is retried once real
    // copy lands.
    if (hasPlaceholderCopy(finalCopy)) {
      results.push(withSkips("placeholder_copy"));
      continue;
    }

    // Ruling (c) REOPENED: a stale 'pending' row is an UNKNOWN outcome, not
    // a safe-to-reclaim one (see onboarding-stage.ts's canClaimStage /
    // isUncertainPending comments). Checked BEFORE attempting the claim —
    // claimStage would return claimed:false for it either way now (pending
    // is never claimable), but this branch is what tells "still actively
    // in-flight elsewhere" (already_sent, unremarkable) apart from "a
    // previous run crashed or timed out with this partner's outcome
    // unknown" (uncertain, needs a human) — the two cases look identical to
    // claimStage's boolean return but must NOT be reported the same way.
    const existingRow = ledgerRowByPartner.get(partner.id)?.get(stage);
    if (isUncertainPending(existingRow, deps.now)) {
      say(
        "error",
        `stage ${stage} for partner ${partner.id} has an UNCERTAIN outcome — a 'pending' claim from a previous run older than ${STALE_PENDING_MINUTES}m that was never resolved to 'sent' or 'failed'. NOT auto-retried (a crash right after Mailgun accepted would double-send). Needs human review: check Mailgun's logs for this partner/stage, then manually mark the row 'failed' to allow a retry, or leave it if it did in fact send.`,
      );
      uncertain.push({ partner_id: partner.id, stage });
      // gh-2154 P-4 switch-on hardening (item (2)): only queue an alert if
      // this exact row hasn't already been alerted for (dedupe across
      // ticks — see LedgerRow.uncertain_alerted_at's doc comment).
      if (existingRow?.uncertain_alerted_at == null) {
        toAlert.push({ partner_id: partner.id, stage });
      }
      results.push(withSkips("uncertain"));
      continue;
    }

    // ── Kevin correction Q3: claim BEFORE send, mark AFTER. ────────────────
    const { claimed } = await deps.claimStage(partner.id, stage);
    if (!claimed) {
      say("log", `stage ${stage} for partner ${partner.id} already claimed (sent, or a fresh in-flight claim by a concurrent run)`);
      results.push(withSkips("already_sent"));
      continue;
    }

    const sendResult = await deps.sendEmail(email, finalCopy.subject, finalCopy.textBody, finalCopy.htmlBody, optOutUrl);
    if (!sendResult.ok) {
      const error = sendResult.error ?? "unknown";

      // Orchestrator review of 50a59e50 (fix round 3): a sendEmail failure
      // with NO response ever received (uncertain: true — a thrown fetch,
      // connection reset, or timeout) means Mailgun's actual decision is
      // UNKNOWN, not a definite rejection. markFailed would make this row
      // 'failed', which IS reclaimable (canClaimStage) — retrying it risks
      // a real double-send if Mailgun in fact accepted the message right
      // before the connection dropped. The row stays exactly as claimStage
      // left it — 'pending' — which is now NEVER reclaimed (ruling c); this
      // run surfaces it in `uncertain` immediately, rather than waiting for
      // a LATER run to notice it went stale.
      if (sendResult.uncertain) {
        say(
          "error",
          `stage ${stage} for partner ${partner.id} has an UNCERTAIN send outcome — no response was received from Mailgun (${error}), so whether it actually accepted the message is unknown. Row left 'pending' (never marked 'failed' — that would make it reclaimable and risk a double-send). NOT auto-retried this run or any later one. Needs human review: check Mailgun's logs for this partner/stage.`,
        );
        uncertain.push({ partner_id: partner.id, stage });
        // This row just went 'pending' via THIS run's own claim above — it
        // cannot possibly have a prior uncertain_alerted_at, so it always
        // needs an alert.
        toAlert.push({ partner_id: partner.id, stage });
        results.push(withSkips("uncertain"));
        continue;
      }

      // A response WAS received and it was a non-2xx rejection — a
      // DEFINITE non-send. gh-2154 P-4 switch-on hardening (item (3)): a
      // PERMANENT rejection (4xx other than 429) is terminal immediately —
      // retrying a message Mailgun has permanently refused (bad address,
      // etc.) never succeeds and only burns the attempt cap. A retryable
      // rejection (5xx, 429, or anything sendEmail didn't classify as
      // permanent) is safe and correct to retry: markFailed(terminal:
      // false), reclaimable (canClaimStage's 'failed' branch) up to
      // MAX_SEND_ATTEMPTS.
      const terminal = sendResult.permanent === true;
      say(
        "error",
        `FAILED ${stage} onboarding email for partner ${partner.id} — ${terminal ? "PERMANENT rejection, not retried again" : "not retried this run, eligible again next tick (subject to the retry cap)"}: ${error}`,
      );
      const { error: markError } = await deps.markFailed(partner.id, stage, error, terminal);
      if (markError) {
        say("error", `send for partner ${partner.id} stage ${stage} ALSO failed to record as 'failed': ${markError.message ?? ""}`);
      }
      results.push(withSkips("send_failed"));
      continue;
    }

    const { error: markError } = await deps.markSent(partner.id, stage, sendResult.mailgunId ?? null);
    if (markError) {
      say("error", `sent ${stage} to partner ${partner.id} but failed to record it as 'sent': ${markError.message ?? ""}`);
    }

    results.push({
      partner_id: partner.id,
      sent: stage,
      ...(selection.toMarkSkipped.length ? { skipped_stages: selection.toMarkSkipped } : {}),
    });
  }

  // gh-2154 P-4 switch-on hardening (item (2)): ONE summary admin alert per
  // run, only for rows this run has not already alerted for (see toAlert's
  // doc comment above). Never per-partner — a backlog run with many
  // uncertain rows pages Dustin once. Best-effort: an alert-send or
  // mark-alerted failure is logged, never thrown, and never blocks or
  // reverses the sweep's own results — the uncertain list is already
  // returned in the JSON response either way (below), so a failed alert
  // does not hide the underlying problem, it only means this specific
  // paging step needs a human to notice via the response/log instead.
  if (toAlert.length > 0) {
    try {
      const alertResult = await deps.alertAdminUncertain(toAlert);
      if (!alertResult.ok) {
        say("error", `uncertain-outcome admin alert FAILED to send for ${toAlert.length} row(s): ${alertResult.error ?? "unknown"}`);
      } else {
        const { error: markAlertError } = await deps.markUncertainAlerted(toAlert);
        if (markAlertError) {
          say(
            "error",
            `uncertain-outcome admin alert sent for ${toAlert.length} row(s) but failed to record uncertain_alerted_at (may re-alert next tick): ${markAlertError.message ?? ""}`,
          );
        }
      }
    } catch (err) {
      say("error", `uncertain-outcome admin alert threw: ${String(err)}`);
    }
  }

  return { ok: true, results, ...(uncertain.length ? { uncertain } : {}) };
}
