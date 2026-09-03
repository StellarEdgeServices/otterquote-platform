// notify-partner-w9/w9-gate.ts
//
// D-319 (gh-1509, half A) — flag-read + pure skip-decision for
// notify-partner-w9. Same source-split pattern as
// mint-test-session/gate.ts and approve-payout/w9-gate.ts (that file's
// header comment has the full D-319 flag-home writeup — this one is
// intentionally the short version since the decision here is a single
// boolean, not a multi-condition gate).
//
// D-319 intent: when the flag is ON, this function no-ops (does not send
// the W-9 request email) and logs the skip. Flag OFF (default; no
// platform_settings row yet — this PR ships no seed/migration) sends
// exactly as before.

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

/** Fail-safe default false (send the email) on a missing row or read error. */
export async function readW9GateFlag(
  fetchFlag: SettingsFetcher,
  logError: (message: string) => void = () => {},
): Promise<boolean> {
  const { data, error } = await fetchFlag();
  if (error) {
    logError(`platform_settings read failed for ${W9_GATE_FLAG_KEY} — defaulting to gate ENFORCED (email sends): ${error.message}`);
    return false;
  }
  return data?.value === true;
}

/** True when the send should be skipped (no-op). */
export function shouldSkipW9Notification(w9GateRetired: boolean): boolean {
  return w9GateRetired === true;
}

/** The response body returned on a flag-ON no-op, kept as a pure builder for testability. */
export function skipResponseBody(agentId: string): Record<string, unknown> {
  return { success: true, skipped: true, reason: "w9_gate_retired", agent_id: agentId };
}
