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

import { hasUsableEmail, isFounderOrTestEmail, isSyntheticLead } from "./founder-filter.ts";

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
  | "founder_or_test_email"
  | "synthetic_lead"
  | "too_young"
  | "too_old"
  | "already_sent"
  | "opted_out"
  | "goal_recorded";

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
  if (isFounderOrTestEmail(lead.email)) {
    return { send: false, skip_reason: "founder_or_test_email" };
  }
  if (isSyntheticLead(lead.is_synthetic)) {
    return { send: false, skip_reason: "synthetic_lead" };
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
