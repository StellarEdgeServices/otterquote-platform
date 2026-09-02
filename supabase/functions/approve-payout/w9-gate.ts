// approve-payout/w9-gate.ts
//
// D-319 (gh-1509, half A) — pure gate-evaluation logic for the W-9 payout
// gate, split out of index.ts (same source-split pattern as
// mint-test-session/gate.ts and notify-contractors/test-exclusion.ts) so it
// is unit-testable with plain object literals — no live Supabase client, no
// network listener.
//
// D-319 intent: introduce a single config flag (read from platform_settings,
// key 'w9_gate_retired' — see readW9GateFlag below) that, when ON, retires
// ONLY the w9_verified_at condition of the gate. payments_blocked semantics
// are UNCHANGED by the flag in either state — a partner whose payments are
// blocked for any reason still HOLDS regardless of the flag. The issue body
// only asked for the w9-verified check to retire ("the W-9 verified-gate no
// longer blocks approval"); it said nothing about payments_blocked, so that
// condition is preserved verbatim per the conservative-default instruction.
//
// Flag OFF (default): isW9GateHeld behaves byte-identically to the
// pre-D-319 inline condition
//   `agent.payments_blocked !== false || agent.w9_verified_at == null`.

export interface W9GateAgent {
  payments_blocked: boolean | null;
  w9_verified_at: string | null;
}

/**
 * True when the payout must be held. Mirrors the original inline guard
 * exactly when w9GateRetired is false; when true, the w9_verified_at
 * condition is skipped (payments_blocked is still authoritative).
 */
export function isW9GateHeld(agent: W9GateAgent, w9GateRetired: boolean): boolean {
  const w9Unverified = !w9GateRetired && agent.w9_verified_at == null;
  return agent.payments_blocked !== false || w9Unverified;
}

/**
 * Held-reason text. Unchanged from the pre-D-319 branching: when
 * isW9GateHeld() is true only because of payments_blocked, that reason wins;
 * the "W-9 not on file" reason can only be reached when the flag is OFF
 * (with the flag ON, isW9GateHeld is true only via the payments_blocked arm,
 * so this function's callers never hit that branch in the ON state).
 */
export function w9GateHeldReason(agent: W9GateAgent): string {
  return agent.payments_blocked !== false
    ? "Held — partner payments are blocked (W-9 not on file)"
    : "Held — partner W-9 not on file";
}

export const W9_GATE_FLAG_KEY = "w9_gate_retired";

/**
 * Shape of a single platform_settings row fetch — matches the project's
 * established key/value config pattern (see D204_HARD_FILTER in
 * contractor-bid-form.html and the same read in create-payment-intent/
 * index.ts). A plain fetch function rather than a chained-builder interface
 * so callers just wrap their real query in an arrow function (avoids trying
 * to structurally type-match the real supabase-js PostgrestFilterBuilder,
 * which is not a literal Promise and does not type-check against a hand-
 * written chain interface) and tests can pass a trivial stub.
 */
export type SettingsFetcher = () => Promise<{
  data: { value: unknown } | null;
  error: { message: string } | null;
}>;

/**
 * Reads the D-319 flag from platform_settings. No row (not yet seeded — this
 * PR ships no migration/seed) or a read error both default to false
 * (today's behavior: gate enforced) — fail-safe in the direction of NOT
 * silently retiring a money gate.
 */
export async function readW9GateFlag(
  fetchFlag: SettingsFetcher,
  logError: (message: string) => void = () => {},
): Promise<boolean> {
  const { data, error } = await fetchFlag();
  if (error) {
    logError(`platform_settings read failed for ${W9_GATE_FLAG_KEY} — defaulting to gate ENFORCED: ${error.message}`);
    return false;
  }
  return data?.value === true;
}
