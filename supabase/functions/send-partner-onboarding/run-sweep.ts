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
//   5. Bot-pattern skip — only for non-is_test partners (is_test wins,
//      matching notify-admin-new-partner's P-3 convention exactly).
//   6. Placeholder-copy gate — per partner, on the FINAL composed copy
//      (per-stage body + [TEST] prefix + the D-320-mirrored unsubscribe
//      line with this partner's real link substituted in), so a bug in any
//      earlier transform step can never accidentally hide a placeholder
//      marker from this check.
//   7. Atomic claim (Kevin correction Q3) — only after every skip gate above
//      has passed does this run attempt to claim the (partner, stage) row.
//
// KEVIN CORRECTION (Q3): the original version of this file stamped a ledger
// row 'sent' BEFORE calling Mailgun — exactly the defect gh-2069 fixed in
// send-homeowner-next-steps ("stops claiming 'sent' before it has sent").
// The corrected shape, in order:
//   (a) claimStage(partnerId, stage) — an ATOMIC claim, enforced at the
//       database level by a conditional upsert (see
//       claim_partner_onboarding_stage() in the ledger migration) that can
//       only transition a row into 'pending' if it doesn't already hold a
//       'sent'/'skipped' row or a fresh 'pending' one. Only one concurrent
//       caller's claim can succeed for a given (partner, stage) — this is
//       what actually prevents a double send, NOT anything in this file.
//   (b) sendEmail — only after the claim succeeds.
//   (c) markSent(partnerId, stage, mailgunId) on acceptance, or
//       markFailed(partnerId, stage, error) on rejection/throw. A 'failed'
//       row is NOT terminal (see onboarding-stage.ts's selectStage) — a
//       later run retries it exactly like a stage that was never attempted.
// A losing claim (claimed:false) means another run already owns this
// (partner, stage) — reported as 'already_sent' and Mailgun is NEVER called.

import {
  type EligibleAgentType,
  type LedgerStatus,
  type OnboardingStage,
  type PartnerRow,
  selectStage,
} from "./onboarding-stage.ts";
import { composeFinalCopy, getCopyForAgentType, hasPlaceholderCopy } from "./copy.ts";
import { isOnboardingEnabled } from "./kill-switch.ts";
import { isTestAccount } from "./bot-pattern.ts";

export interface LedgerRow {
  partner_id: string;
  stage: OnboardingStage;
  status: LedgerStatus;
  created_at?: string;
}

export type SkipReason =
  | "activated"
  | "opted_out"
  | "not_due"
  | "invalid_created_at"
  | "ineligible_agent_type"
  | "placeholder_copy"
  | "bot_pattern"
  | "no_email"
  | "send_failed"
  | "already_sent"; // lost the atomic claim race

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
  markFailed: (partnerId: string, stage: OnboardingStage, error: string) => Promise<MarkResult>;
  markSkipped: (partnerId: string, stage: OnboardingStage, reason: string) => Promise<MarkResult>;
  /** Builds this partner's real, signed, per-partner unsubscribe URL. Only
   * called when optOutSecretConfigured is true. */
  buildOptOutUrl: (partnerId: string) => Promise<string>;
  sendEmail: (to: string, subject: string, textBody: string, htmlBody: string) => Promise<SendEmailResult>;
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
  | { ok: true; results: PartnerResult[] };

export async function runOnboardingSweep(deps: RunDeps): Promise<SweepOutcome> {
  const say = deps.log ?? (() => {});

  // ── Guard 1: kill switch — fails closed on OFF, unset, or a read error ────
  let settingValue: unknown = null;
  try {
    const row = await deps.readSetting();
    settingValue = row?.value ?? null;
  } catch (err) {
    say("warn", `partner_onboarding_enabled read failed — treating as disabled: ${String(err)}`);
    settingValue = null;
  }
  if (!isOnboardingEnabled(settingValue)) {
    return { ok: true, skipped: "disabled" };
  }

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
  for (const row of ledgerRows) {
    let m = ledgerByPartner.get(row.partner_id);
    if (!m) {
      m = new Map();
      ledgerByPartner.set(row.partner_id, m);
    }
    m.set(row.stage, row.status);
  }

  const results: PartnerResult[] = [];

  for (const partner of partners) {
    const prior = ledgerByPartner.get(partner.id) ?? new Map<OnboardingStage, LedgerStatus>();
    const selection = selectStage(partner, prior, deps.now);

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

    const email = partner.email ?? null;
    if (!email) {
      results.push(withSkips("no_email"));
      continue;
    }

    // is_test wins over the bot-pattern skip (P-3 convention, verbatim):
    // only a NON-is_test row matching a bot pattern is skipped. Checked
    // before any copy is built — a bot account should never even reach the
    // placeholder-copy gate, let alone the claim step.
    if (!isTest && isTestAccount(email)) {
      results.push(withSkips("bot_pattern"));
      continue;
    }

    const copyLookup: CopyLookup = deps.getCopy ?? getCopyForAgentType;
    const baseCopy = copyLookup(agentType, stage)!;
    const subjectPrefix = isTest ? "[TEST] " : "";
    const optOutUrl = await deps.buildOptOutUrl(partner.id);
    const finalCopy = deps.getUnsubLineTemplate
      ? composeFinalCopy(baseCopy, optOutUrl, subjectPrefix, deps.getUnsubLineTemplate())
      : composeFinalCopy(baseCopy, optOutUrl, subjectPrefix);

    // Checked on the FINAL composed copy (stage body + [TEST] prefix + the
    // unsubscribe line) — a bug in any earlier step can never mask a
    // placeholder marker from this gate. This runs BEFORE the claim, so a
    // placeholder-blocked stage is never claimed and is retried once real
    // copy lands.
    if (hasPlaceholderCopy(finalCopy)) {
      results.push(withSkips("placeholder_copy"));
      continue;
    }

    // ── Kevin correction Q3: claim BEFORE send, mark AFTER. ────────────────
    const { claimed } = await deps.claimStage(partner.id, stage);
    if (!claimed) {
      say("log", `stage ${stage} for partner ${partner.id} already claimed (sent, or a fresh in-flight claim by a concurrent run)`);
      results.push(withSkips("already_sent"));
      continue;
    }

    const sendResult = await deps.sendEmail(email, finalCopy.subject, finalCopy.textBody, finalCopy.htmlBody);
    if (!sendResult.ok) {
      const error = sendResult.error ?? "unknown";
      say("error", `FAILED ${stage} onboarding email for partner ${partner.id} — not retried this run, eligible again next tick: ${error}`);
      const { error: markError } = await deps.markFailed(partner.id, stage, error);
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

  return { ok: true, results };
}
