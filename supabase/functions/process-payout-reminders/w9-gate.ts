// process-payout-reminders/w9-gate.ts
//
// D-319 (gh-1509, half A) — flag-read + pure skip-decision for JOB 3 (the
// W-9 request sweep) in process-payout-reminders. Same source-split pattern
// as approve-payout/w9-gate.ts and notify-partner-w9/w9-gate.ts — see
// approve-payout/w9-gate.ts for the full D-319 flag-home writeup.
//
// D-319 intent: when the flag is ON, JOB 3 does not run at all — no query,
// no notify-partner-w9 calls, no w9_notification_sent_at stamps. Flag OFF
// (default; no platform_settings row yet — this PR ships no seed/migration)
// runs JOB 3 exactly as before.

export const W9_GATE_FLAG_KEY = "w9_gate_retired";

/**
 * Shape of a single platform_settings row fetch. A plain fetch function
 * rather than a chained-builder interface so the caller just wraps its real
 * query in an arrow function (the real supabase-js PostgrestFilterBuilder is
 * not a literal Promise and does not type-check against a hand-written
 * chain interface) and tests can pass a trivial stub.
 */
export type SettingsFetcher = () => Promise<{
  data: { value: unknown } | null;
  error: { message: string } | null;
}>;

/** Fail-safe default false (JOB 3 runs) on a missing row or read error. */
export async function readW9GateFlag(
  fetchFlag: SettingsFetcher,
  logError: (message: string) => void = () => {},
): Promise<boolean> {
  const { data, error } = await fetchFlag();
  if (error) {
    logError(`platform_settings read failed for ${W9_GATE_FLAG_KEY} — defaulting to gate ENFORCED (JOB 3 runs): ${error.message}`);
    return false;
  }
  return data?.value === true;
}

/** True when JOB 3 (the W-9 request sweep) should be skipped entirely. */
export function shouldSkipW9ReminderJob(w9GateRetired: boolean): boolean {
  return w9GateRetired === true;
}
