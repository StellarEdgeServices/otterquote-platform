/**
 * gh-2421 (D-344) / gh-1570: the homeowner blocked-states setting, shared by
 * every function that must honour it.
 *
 * Colocated copy of the parser in notify-admin-new-homeowner/notify-helpers.ts
 * (the EF deploy path does not resolve `_shared/` imports, and importing
 * notify-helpers would pull in react-app code). Kept identical by
 * blocked-states.test.ts, which imports both and asserts they agree.
 */

export const DEFAULT_BLOCKED_STATES: readonly string[] = ["FL", "LA", "TX"];
export const BLOCKED_STATES_SETTING_KEY = "homeowner_blocked_states";

export function normalizeState(v: unknown): string {
  return typeof v === "string" ? v.trim().toUpperCase() : "";
}

// Accepts the jsonb value of the platform_settings row. Anything that is not
// an array of strings (missing row, null, object, number) falls back to the
// default. An empty array is a valid, deliberate "nothing blocked".
export function parseBlockedStates(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((s) => typeof s === "string")) {
    return [...DEFAULT_BLOCKED_STATES];
  }
  return value.map(normalizeState).filter(Boolean);
}
