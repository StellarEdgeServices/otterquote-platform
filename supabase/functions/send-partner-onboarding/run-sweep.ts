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
//      reads of referral_agents or the ledger. This must be the very first
//      thing checked — everything below assumes sending is authorized.
//   2. Stop condition (selectStage's activation gate) — per partner.
//   3. agent_type routing — per partner.
//   4. Placeholder-copy gate — per partner, on the FINAL copy (after the
//      is_test [TEST] prefix is applied), so a bug in the prefix step can
//      never accidentally hide a placeholder marker from this check.
//   5. Bot-pattern skip — only for non-is_test partners (is_test wins,
//      matching notify-admin-new-partner's P-3 convention exactly).
//
// IDEMPOTENCY: stamp-before-send, the SAME general mechanism
// send-homeowner-next-steps used before gh-2069 (see that function's
// deliver-stage.ts file header for the full trade-off writeup) — a losing
// concurrent invocation's ledger insert hits the (partner_id, stage) unique
// index, is caught as 23505, and is treated as already-sent WITHOUT calling
// Mailgun. Chosen over gh-2069's send-then-stamp order deliberately: this
// function ships with the kill switch OFF and placeholder copy, so no real
// send is possible yet, and stamp-before-send is strictly simpler to test
// and strictly safer against a double-send once it is live. This is a
// documented, deliberate choice, not an oversight — see the build report.

import {
  type EligibleAgentType,
  type LedgerStatus,
  type OnboardingStage,
  type PartnerRow,
  selectStage,
} from "./onboarding-stage.ts";
import { type EmailCopy, getCopyForAgentType, hasPlaceholderCopy } from "./copy.ts";
import { isOnboardingEnabled } from "./kill-switch.ts";
import { isTestAccount } from "./bot-pattern.ts";

export interface LedgerRow {
  partner_id: string;
  stage: OnboardingStage;
  status: LedgerStatus;
}

export type SkipReason =
  | "activated"
  | "not_due"
  | "invalid_created_at"
  | "ineligible_agent_type"
  | "placeholder_copy"
  | "bot_pattern"
  | "no_email"
  | "send_failed"
  | "already_sent"; // 23505 race loss

export interface PartnerResult {
  partner_id: string;
  sent?: OnboardingStage;
  /** Backlog-superseded stages marked skipped THIS run (RUN 22 lesson —
   * persisted, never silently dropped). */
  skipped_stages?: OnboardingStage[];
  skipped_reason?: SkipReason;
}

export interface InsertLedgerResult {
  error: { code?: string; message?: string } | null;
}

export interface SendEmailResult {
  ok: boolean;
  mailgunId?: string;
  error?: string;
}

export interface RunDeps {
  /** Reads platform_settings for PARTNER_ONBOARDING_SETTING_KEY. Returning
   * null/undefined, or throwing, both mean "unreadable" and must fail
   * closed — the caller wraps this in try/catch. */
  readSetting: () => Promise<{ value: unknown } | null>;
  fetchCandidatePartners: () => Promise<PartnerRow[]>;
  fetchLedgerForPartners: (partnerIds: string[]) => Promise<LedgerRow[]>;
  insertLedgerRow: (row: { partner_id: string; stage: OnboardingStage; status: LedgerStatus; skipped_reason?: string; mailgun_id?: string | null }) => Promise<InsertLedgerResult>;
  sendEmail: (to: string, subject: string, textBody: string, htmlBody: string) => Promise<SendEmailResult>;
  log?: (level: "log" | "warn" | "error", message: string) => void;
  now: number;
  /** Copy lookup, defaulting to ./copy.ts's real (placeholder) table.
   * Overridable ONLY by tests, to exercise the full send/idempotency/[TEST]-
   * prefix path with non-placeholder copy without touching the real
   * Tier C module. index.ts never overrides this. */
  getCopy?: (agentType: EligibleAgentType, stage: OnboardingStage) => EmailCopy | null;
}

export type SweepOutcome =
  | { ok: true; skipped: "disabled" }
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
      const { error } = await deps.insertLedgerRow({
        partner_id: partner.id,
        stage,
        status: "skipped",
        skipped_reason: "superseded_by_backlog",
      });
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
    // placeholder-copy gate.
    if (!isTest && isTestAccount(email)) {
      results.push(withSkips("bot_pattern"));
      continue;
    }

    const copyLookup = deps.getCopy ?? getCopyForAgentType;
    const baseCopy = copyLookup(agentType, stage)!;
    const subjectPrefix = isTest ? "[TEST] " : "";
    const finalCopy = { ...baseCopy, subject: `${subjectPrefix}${baseCopy.subject}` };

    // Checked on the FINAL copy, after the [TEST] prefix — a prefix bug can
    // never mask a placeholder marker from this gate.
    if (hasPlaceholderCopy(finalCopy)) {
      results.push(withSkips("placeholder_copy"));
      continue;
    }

    // ── Stamp before send (see file header for why this order). ───────────
    const { error: stampError } = await deps.insertLedgerRow({
      partner_id: partner.id,
      stage,
      status: "sent",
    });
    if (stampError?.code === "23505") {
      say("log", `stage ${stage} for partner ${partner.id} already claimed by a concurrent run`);
      results.push(withSkips("already_sent"));
      continue;
    }
    if (stampError) {
      say("error", `failed to stamp stage ${stage} for partner ${partner.id}: ${stampError.message ?? ""}`);
      // Fail closed: do not send if the stamp could not be written — an
      // unstamped send is a future duplicate waiting to happen.
      results.push(withSkips("send_failed"));
      continue;
    }

    const sendResult = await deps.sendEmail(email, finalCopy.subject, finalCopy.textBody, finalCopy.htmlBody);
    if (!sendResult.ok) {
      say("error", `FAILED ${stage} onboarding email for partner ${partner.id}: ${sendResult.error ?? "unknown"}`);
      results.push(withSkips("send_failed"));
      continue;
    }

    results.push({
      partner_id: partner.id,
      sent: stage,
      ...(selection.toMarkSkipped.length ? { skipped_stages: selection.toMarkSkipped } : {}),
    });
  }

  return { ok: true, results };
}
