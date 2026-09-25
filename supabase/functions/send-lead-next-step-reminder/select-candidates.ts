// gh-2121 (LRS HO-1 S21) — pure selection logic for the lead next-step
// reminder, extracted so it is testable without Supabase or Mailgun (same
// separation send-homeowner-next-steps/select-stage.ts already established
// for this repo's other nudge email).
//
// Scope, per Dustin's ruling (#2121 comment 5821760029) and the approved
// copy (comment 5821796976 / approved 5824921642): ONE email, sent the day
// after the lead, only if no goal event has been recorded, only to leads
// with an email, excluding synthetic/test leads and founder/test addresses,
// sent at most once ever, honoring the D-320-style opt-out.

import {
  hasUsableEmail,
  isFounderOrTestEmail,
  isSingleValidEmail,
  isSyntheticLead,
} from "./founder-filter.ts";

export const REMINDER_MIN_AGE_MS = 24 * 60 * 60 * 1000; // "the day after the lead"
// Upper bound on how old a lead can be and still receive the reminder — this
// is a single day-after nudge, not a backlog sweep. A lead this run's cron
// missed for longer than this (an outage, a paused schedule) is left
// unsent rather than reminded a week late; MAX_AGE_DAYS=7 mirrors the
// existing precedent for a bounded catch-up window on this exact kind of
// job (notify-admin-new-homeowner/index.ts's own MAX_AGE_DAYS=7).
export const REMINDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type SkipReason =
  | "disabled"
  | "no_email"
  | "invalid_email_format"
  | "founder_or_test_email"
  | "synthetic_lead"
  | "not_homeowner_arm_f"
  | "too_young"
  | "too_old"
  | "already_sent"
  | "opted_out"
  | "goal_recorded"
  | "duplicate_email_in_batch";

export interface CandidateLead {
  id: string;
  email: string | null;
  created_at: string;
  is_synthetic: boolean | null;
  next_step_reminder_sent_at: string | null;
  next_step_reminder_opted_out_at: string | null;
  /** True when public.lead_goal_events (PR #2163) has a row for this lead
   * with goal_at IS NOT NULL — "a goal has been recorded for this lead". A
   * lead with no converted_user_id at all also reads as false here (no
   * account, so certainly no goal), which is the caller's responsibility to
   * establish (see index.ts's own query — this module takes the already-
   * resolved boolean so it stays a pure function). */
  has_goal_event: boolean;
  /** `leads.role` (leads_role_check: 'homeowner' | 'contractor' |
   * 'referral_partner'). Fix round 1 (CEO RUN 68 LEGAL-READ: FAIL, comment
   * 5825694840, must-fix 6): this email is HO-1 (Arm F homeowner) scope
   * only — a contractor or referral_partner lead must never receive it. */
  role: string | null;
  /** `leads.variant` — the router arm letter this lead was captured on
   * ('a'..'f'; see 20260918122231_gh2011_leads_variant.sql and
   * start.html's insertFreshLead(), which writes the SAME `variant` scope
   * variable start.html uses for the arm letter, not a separate Meta-test
   * value — confirmed by reading that call site). 'f' is Arm F. */
  variant: string | null;
}

export interface SelectionDecision {
  send: boolean;
  skip_reason?: SkipReason;
}

/**
 * Decide whether `lead` should receive the S21 next-step reminder right now.
 * `killSwitchEnabled` is checked FIRST and unconditionally — "switch OFF
 * sends nothing", regardless of how eligible the lead otherwise is, and at
 * zero read cost for every other predicate.
 */
export function selectLeadForReminder(
  lead: CandidateLead,
  killSwitchEnabled: boolean,
  now: number,
): SelectionDecision {
  if (!killSwitchEnabled) {
    return { send: false, skip_reason: "disabled" };
  }
  if (!hasUsableEmail(lead.email)) {
    return { send: false, skip_reason: "no_email" };
  }
  // Fix round 1, must-fix 5: reject anything that is not a single plain
  // address BEFORE the founder-domain check below, which assumes it can
  // split on a single "@".
  if (!isSingleValidEmail(lead.email)) {
    return { send: false, skip_reason: "invalid_email_format" };
  }
  if (isFounderOrTestEmail(lead.email)) {
    return { send: false, skip_reason: "founder_or_test_email" };
  }
  if (isSyntheticLead(lead.is_synthetic)) {
    return { send: false, skip_reason: "synthetic_lead" };
  }
  // Fix round 1, must-fix 6: HO-1 / Arm F scope only.
  if (lead.role !== "homeowner" || lead.variant !== "f") {
    return { send: false, skip_reason: "not_homeowner_arm_f" };
  }
  if (lead.next_step_reminder_opted_out_at) {
    return { send: false, skip_reason: "opted_out" };
  }
  if (lead.next_step_reminder_sent_at) {
    return { send: false, skip_reason: "already_sent" };
  }
  if (lead.has_goal_event) {
    return { send: false, skip_reason: "goal_recorded" };
  }

  const createdMs = new Date(lead.created_at).getTime();
  if (Number.isNaN(createdMs)) {
    return { send: false, skip_reason: "too_young" }; // fail closed on a malformed timestamp
  }
  const ageMs = now - createdMs;
  if (ageMs < REMINDER_MIN_AGE_MS) {
    return { send: false, skip_reason: "too_young" };
  }
  if (ageMs > REMINDER_MAX_AGE_MS) {
    return { send: false, skip_reason: "too_old" };
  }

  return { send: true };
}

/** Lowercase + trim, the equality key "at most one reminder per normalized
 * email address ever" is defined against. Exported so index.ts's DB-level
 * lookups (the partial unique index in the gh2121 migration) and this
 * module's own in-batch de-dup agree on exactly what "same address" means. */
export function normalizeEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Fix round 1 (CEO RUN 68 REVIEW: FAIL, comment 5825698253, must-fix 4 /
 * adversarial test A7): two different `leads` rows can carry the same
 * email address (a homeowner who submitted the router form twice). Without
 * this, a single batch could select BOTH rows and send the reminder twice
 * to one inbox — the per-row atomic UPDATE...RETURNING stamp only prevents
 * re-claiming the SAME row, not a second DIFFERENT row with the same
 * address.
 *
 * Keeps the FIRST occurrence of each normalized email (callers pass rows
 * already ordered oldest-created-first, so "first" is the oldest lead) and
 * marks every later row sharing that address as a duplicate skip. This is
 * the in-memory half of the guarantee; the migration's partial unique index
 * on lower(email) WHERE next_step_reminder_sent_at IS NOT NULL is the
 * database-level half that also holds across two concurrent runs, which a
 * single process's in-memory Set cannot.
 */
export function dedupeByNormalizedEmail<T extends { id: string; email: string | null }>(
  rows: readonly T[],
): { toSend: T[]; duplicates: T[] } {
  const seen = new Set<string>();
  const toSend: T[] = [];
  const duplicates: T[] = [];
  for (const row of rows) {
    const key = typeof row.email === "string" ? normalizeEmailKey(row.email) : null;
    if (key === null || key === "") {
      // No usable email at all — not this function's concern (selectLeadForReminder's
      // own no_email check handles it); let it through untouched.
      toSend.push(row);
      continue;
    }
    if (seen.has(key)) {
      duplicates.push(row);
      continue;
    }
    seen.add(key);
    toSend.push(row);
  }
  return { toSend, duplicates };
}
