// templates.ts (gh-1824 footer batch 6)
//
// Alert email text for platform-health-check, split out of index.ts so it can
// be unit-tested without importing index.ts (which calls serve() at module load
// time). Pure functions: the "Checked at" stamp is passed in (index.ts supplies
// formatDualTimestamp(new Date())), so the same inputs always render the same
// bytes. Wording is moved verbatim from index.ts; templates.test.ts pins every
// rendered alert with exact-equality goldens.

import { buildSmsAlertMessage, type ConsecutiveUndeliveredResult } from "./sms-delivery-check.ts";
import { footerPostalAddressText } from "./email-footer.ts"; // gh-1824 D-237

export interface AlertText {
  subject: string;
  message: string;
}

/** The text/plain part actually sent by sendMailgunAlert: alert body + D-237 postal footer. */
export function alertEmailText(body: string): string {
  return `${body}\n\n${footerPostalAddressText()}`;
}

/** Phase 1, 2nd-strike Edge Function ping failure. */
export function efSilentFailureAlert(
  result: { functionName: string; status: string; httpStatus?: number | null; error?: string | null },
  checkedAt: string,
): AlertText {
  const subject = `OtterQuote Health Alert — ${result.functionName} is not responding (2 consecutive failures)`;
  const message = [
    `Edge Function: ${result.functionName}`,
    `Status: ${result.status}`,
    result.httpStatus ? `HTTP Status: ${result.httpStatus}` : null,
    result.error ? `Error: ${result.error}` : null,
    `Checked at: ${checkedAt}`,
    "",
    "Two consecutive failures across two cron runs (~15 min apart) — first failure was suppressed by the 2-strikes gate; this is the second.",
    "",
    "This is an automated alert from OtterQuote platform monitoring.",
    "Resolve this alert at: https://otterquote.com/admin-contractors.html",
  ].filter(Boolean).join("\n");
  return { subject, message };
}

/** Phase 2, 2nd-strike cron job last-run-error. */
export function cronErrorAlert(
  jobName: string,
  lastRunAt: string | undefined,
  lastError: string | null | undefined,
  checkedAt: string,
): AlertText {
  const subject = `OtterQuote Health Alert — cron job "${jobName}" last run failed (2 consecutive failures)`;
  const message = [
    `Cron Job: ${jobName}`,
    `Last Run: ${lastRunAt}`,
    `Status: ERROR`,
    lastError ? `Error: ${lastError}` : null,
    `Checked at: ${checkedAt}`,
    "",
    "Two consecutive failed runs across two cron ticks (~15 min apart) — first failure was suppressed by the 2-strikes gate; this is the second.",
    "This is an automated alert from OtterQuote platform monitoring.",
    "Resolve this alert at: https://otterquote.com/admin-contractors.html",
  ].filter(Boolean).join("\n");
  return { subject, message };
}

/** Phase 2, 2nd-strike cron job staleness. */
export function cronStalenessAlert(
  jobName: string,
  lastRunAt: string | undefined,
  ageMs: number,
  thresholdHuman: string,
  checkedAt: string,
): AlertText {
  const subject = `OtterQuote Health Alert — cron job "${jobName}" is stale (2 consecutive ticks)`;
  const message = [
    `Cron Job: ${jobName}`,
    `Last Run: ${lastRunAt ?? "never"}`,
    `Age: ${Math.round(ageMs / 60000)} minutes (threshold: ${thresholdHuman})`,
    `Checked at: ${checkedAt}`,
    "",
    "This cron job has not run within its expected window across two consecutive checks (~15 min apart) — first miss was suppressed by the 2-strikes gate; this is the second.",
    "This is an automated alert from OtterQuote platform monitoring.",
    "Resolve this alert at: https://otterquote.com/admin-contractors.html",
  ].join("\n");
  return { subject, message };
}

/** Phase 3, public path availability failure. */
export function publicPathFailureAlert(
  result: { path: string; jobName: string; status: string; error?: string | null },
  checkedAt: string,
): AlertText {
  const subject = `OtterQuote Health Alert — public path unavailable: ${result.path}`;
  const message = [
    `Public Path: ${result.path}`,
    `Job: ${result.jobName}`,
    `Status: ${result.status}`,
    result.error ? `Error: ${result.error}` : null,
    `Checked at: ${checkedAt}`,
    "",
    "This failure survived one in-run retry (~5s later) before being recorded.",
    "The OtterQuote public site may be unreachable or serving incorrect content.",
    "This is an automated alert from OtterQuote platform monitoring.",
    "Resolve this alert at: https://otterquote.com/admin-contractors.html",
  ].filter(Boolean).join("\n");
  return { subject, message };
}

/** Phase 4 (gh-1825), consecutive undelivered SMS sends. */
export function smsUndeliveredAlert(
  result: ConsecutiveUndeliveredResult,
  threshold: number,
  checkedAt: string,
): AlertText {
  const subject = `OtterQuote Health Alert — ${result.consecutiveCount} consecutive undelivered SMS sends`;
  const message = buildSmsAlertMessage(result, threshold) +
    `\nChecked at: ${checkedAt}\n` +
    `This is an automated alert from OtterQuote platform monitoring (gh-1825).\n` +
    `Resolve this alert at: https://otterquote.com/admin-contractors.html`;
  return { subject, message };
}

/** Phase 5 (gh-2154/gh-2223), register_partner_global budget alert body (subject comes from the evaluator). */
export function registerPartnerBudgetMessage(alertMessage: string, checkedAt: string): string {
  return `${alertMessage}\nChecked at: ${checkedAt}\n` +
    `This is an automated alert from OtterQuote platform monitoring (gh-2154/gh-2223).`;
}
