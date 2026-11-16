/**
 * gh-3762 (child of gate #3726 item 5): quiet-hours gate for process-dunning's direct-to-Twilio SMS.
 *
 * process-dunning is a cron sender (every 30 minutes) and decides its SMS recipients in ONE place, getContractorContacts().
 * That function calls quietHoursPhones(): outside 08:00 <= local < 20:00 for the contractor (Ben's ruling on PR #3774), the phone list for this run
 * is empty (email is unaffected) and one structured line is logged.
 *
 * "Defer" = skip now: the hourly reminder is re-evaluated on every run, so the first run inside the window sends the next
 * reminder. A ONE-SHOT notice (8 AM warning, homeowner-proceeded, lost-project) advances the row's state once, so its
 * skipped text is NOT retried by a later run; the log line says so and an outbox is the proper fix (see the PR body).
 *
 * Pure of I/O except the injected `log`.
 */
import { checkQuietHours, type QuietHoursRecipient } from "../_shared/sms-quiet-hours.ts";

export interface QuietPhonesOptions {
  now?: Date;
  contractorId?: string | null;
  log?: (line: string) => void;
}

/** `phones` unchanged when the window is open for the recipient, otherwise []. */
export function quietHoursPhones(phones: string[], recipient: QuietHoursRecipient, opts: QuietPhonesOptions = {}): string[] {
  if (phones.length === 0) return phones;
  const v = checkQuietHours(opts.now ?? new Date(), recipient);
  if (v.allowed) return phones;
  (opts.log ?? ((l: string) => console.warn(l)))(
    `[process-dunning] ${JSON.stringify({
      event: "sms_quiet_hours_skipped",
      contractor_id: opts.contractorId ?? null,
      numbers: phones.length,
      basis: v.basis,
      next_allowed_at: v.nextAllowedAt ? v.nextAllowedAt.toISOString() : null,
      note: "no Twilio call; a one-shot notice (warning/proceed/lost) is not retried by a later run",
    })}`,
  );
  return [];
}
