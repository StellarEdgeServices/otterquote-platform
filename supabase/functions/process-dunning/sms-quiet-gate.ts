/**
 * gh-3762 (child of gate #3726 item 5): quiet-hours gate and pending-text rules for process-dunning's direct-to-Twilio SMS.
 *
 * process-dunning is a cron sender (every 30 minutes) and decides its SMS recipients in ONE place, getContractorContacts().
 * That function calls quietHoursPhones(): outside 08:00 <= local < 20:00 (Ben's ruling on PR #3774) for the contractor the
 * phone list for this run is empty and `held` is true. Email is unaffected.
 *
 * REVISION 2 (PR #3774 REVIEW B1): a refused REMINDER or 8 AM WARNING text is not dropped. process-dunning marks the row
 * (payment_failures.sms_pending_kind / sms_pending_since) in the same update that advances the state exactly as before,
 * and at the start of each run drainPendingDunningSms() sends any pending text whose window is now open, after re-running
 * every gate. This module holds the pure rules for that: when a pending text expires. A stale reminder must never arrive
 * after a later notice, so a pending text is dropped (logged `sms_quiet_hours_expired`) when its row reaches the next
 * sequence step or after 4 hours.
 *
 * Pure of I/O except the injected `log`.
 */
import { checkQuietHours, type QuietHoursRecipient } from "../_shared/sms-quiet-hours.ts";

export const PENDING_TEXT_MAX_AGE_MS = 4 * 60 * 60_000;

export type PendingKind = "reminder" | "warning";

export interface QuietPhonesOptions {
  now?: Date;
  contractorId?: string | null;
  log?: (line: string) => void;
}

/** `phones` unchanged (held false) when the window is open for the recipient, otherwise [] and held true. */
export function quietHoursPhones(phones: string[], recipient: QuietHoursRecipient, opts: QuietPhonesOptions = {}): { phones: string[]; held: boolean } {
  if (phones.length === 0) return { phones, held: false };
  const v = checkQuietHours(opts.now ?? new Date(), recipient);
  if (v.allowed) return { phones, held: false };
  (opts.log ?? ((l: string) => console.warn(l)))(
    `[process-dunning] ${JSON.stringify({
      event: "sms_quiet_hours_held",
      contractor_id: opts.contractorId ?? null,
      numbers: phones.length,
      basis: v.basis,
      next_allowed_at: v.nextAllowedAt ? v.nextAllowedAt.toISOString() : null,
      note: "text held; a reminder/warning is marked pending on the row and sent when the window opens (expires at the next step or 4h)",
    })}`,
  );
  return { phones: [], held: true };
}

export interface PendingRow {
  dunning_status?: string | null;
  warning_at?: string | null;
  next_reminder_at?: string | null;
  homeowner_notify_at?: string | null;
  sms_pending_kind?: string | null;
  sms_pending_since?: string | null;
}

export type Expiry = "stale_4h" | "next_step" | "unknown_kind" | "no_since";

/**
 * Why a pending text must be dropped now, or null when it may still go.
 *  - older than 4 hours (or no usable timestamp): drop;
 *  - reminder: dropped once the row is no longer 'active', the 8 AM warning is due (warning_at <= now) or the next hourly
 *    reminder is due (next_reminder_at <= now; that pass sends its own text if the window is open);
 *  - warning: dropped once the row is no longer 'warning_sent' or the homeowner notice is due (homeowner_notify_at <= now).
 */
export function pendingTextExpiry(row: PendingRow, now: Date): Expiry | null {
  const kind = row.sms_pending_kind;
  if (kind !== "reminder" && kind !== "warning") return "unknown_kind";
  const since = row.sms_pending_since ? new Date(row.sms_pending_since).getTime() : NaN;
  if (!Number.isFinite(since)) return "no_since";
  if (now.getTime() - since >= PENDING_TEXT_MAX_AGE_MS) return "stale_4h";
  if (kind === "reminder") {
    const warningAt = row.warning_at ? new Date(row.warning_at).getTime() : NaN;
    const nextAt = row.next_reminder_at ? new Date(row.next_reminder_at).getTime() : NaN;
    if (row.dunning_status !== "active" || !Number.isFinite(warningAt) || now.getTime() >= warningAt) return "next_step";
    if (Number.isFinite(nextAt) && now.getTime() >= nextAt) return "next_step";
  } else {
    const notifyAt = row.homeowner_notify_at ? new Date(row.homeowner_notify_at).getTime() : NaN;
    if (row.dunning_status !== "warning_sent" || !Number.isFinite(notifyAt) || now.getTime() >= notifyAt) return "next_step";
  }
  return null;
}
