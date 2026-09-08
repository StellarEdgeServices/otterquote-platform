/**
 * sms-delivery-check.ts (gh-1825)
 *
 * `send-sms` (supabase/functions/send-sms/index.ts) reports `status: "sent"`
 * on Twilio's initial API *acceptance* of the message and never reads the
 * final carrier delivery status. Measured live on 2026-09-08 (#1825 comment
 * 5583955467): the production account's entire lifetime history is 30
 * messages, all 30 `undelivered` — the 7 that went to real numbers
 * (`+13175019215`) are all error 30032 "Toll-Free Number Has Not Been
 * Verified"; the other 23 went to reserved-`555` fictional numbers (error
 * 30006, which measures nothing about deliverability) and only exist as
 * pre-fix/negative-signal noise from earlier verification runs.
 *
 * This module is pure logic (no Deno.env, no fetch side effects) so it can
 * be unit-tested directly. `index.ts`'s Phase 4 does the Twilio fetch and
 * calls into `findConsecutiveUndelivered`.
 *
 * Colocated per Edge Function directory (not `_shared/`) for the same
 * reason `create-measurement-order/notification-failure.ts` is: the EF
 * deploy path does not resolve `_shared/` imports.
 *
 * Tier 3a (CTO ruling, #1825 comment 5583955467): this is read-only
 * observability — it changes no send behaviour and sends no SMS itself.
 */

/** One row of Twilio's `Messages.json` list response, trimmed to the fields this module reads. */
export interface TwilioMessageRow {
  sid: string;
  to: string;
  status: string;
  error_code: number | string | null;
  date_created: string;
  direction?: string;
}

/** Result of scanning the most recent real-recipient messages for a consecutive-undelivered run. */
export interface ConsecutiveUndeliveredResult {
  /** True once `consecutiveCount >= threshold`. */
  alarmed: boolean;
  /** How many of the newest real-recipient messages, in a row, were `undelivered`. */
  consecutiveCount: number;
  /** The real-recipient messages that make up the streak (newest first), for the alert message. */
  streak: TwilioMessageRow[];
  /** How many rows were excluded from consideration as reserved-`555` fictional numbers. */
  fictionalExcluded: number;
}

/**
 * True for a US/CA E.164 number whose central-office code (the 3 digits
 * right after the area code) is `555` — the reserved fictional-number range
 * (555-0100 through 555-0199 is the documentary-use block, but every
 * `NXX-555-XXXX` a test fixture might use is drawn from the same exchange,
 * so this matches on the exchange code rather than the narrower 4-digit
 * sub-range). These numbers cannot receive real SMS and their carrier
 * errors (e.g. 30006 "Unreachable Destination Handset") measure nothing
 * about our own delivery health — #1825 comment 5583955467 confirmed all
 * 23 of the account's `555` sends are exactly this noise.
 */
export function isFictional555(e164: string): boolean {
  const m = /^\+1(\d{3})(\d{3})\d{4}$/.exec(e164.trim());
  if (!m) return false;
  return m[2] === "555";
}

/**
 * Scans `messages` (must be newest-first, i.e. Twilio's default
 * `Messages.json` order) for a run of consecutive `undelivered` outbound
 * sends to REAL (non-`555`) recipients, starting from the newest message.
 * The streak stops at the first real-recipient message that is not
 * `undelivered`, or at the end of the list. `555` rows are skipped
 * entirely — they neither break nor extend the streak.
 *
 * `threshold` is the number of consecutive undelivered real sends required
 * to alarm (the issue's "N consecutive" — default wired to 3 in index.ts).
 */
export function findConsecutiveUndelivered(
  messages: TwilioMessageRow[],
  threshold: number,
): ConsecutiveUndeliveredResult {
  let consecutiveCount = 0;
  let fictionalExcluded = 0;
  const streak: TwilioMessageRow[] = [];

  for (const msg of messages) {
    if (isFictional555(msg.to)) {
      fictionalExcluded++;
      continue; // does not participate in the streak either way
    }
    if (msg.status === "undelivered") {
      consecutiveCount++;
      streak.push(msg);
    } else {
      break; // first real, non-undelivered message ends the streak
    }
  }

  return {
    alarmed: consecutiveCount >= threshold,
    consecutiveCount,
    streak,
    fictionalExcluded,
  };
}

/** Builds the platform_alerts_log / Mailgun message body for an SMS-undelivered alarm. */
export function buildSmsAlertMessage(result: ConsecutiveUndeliveredResult, threshold: number): string {
  const rows = result.streak
    .map((m) => `  ${m.sid} -> ...${m.to.slice(-4)} status=${m.status} error_code=${m.error_code ?? "(none)"} at ${m.date_created}`)
    .join("\n");
  return (
    `SMS delivery alarm: ${result.consecutiveCount} consecutive undelivered sends to real ` +
    `(non-555) recipients (threshold ${threshold}).\n` +
    `send-sms reports "sent" on Twilio API acceptance only and does not see this — see gh-1825.\n\n` +
    `${rows}\n`
  );
}
