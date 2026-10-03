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

// Accepts the jsonb value of the platform_settings row and returns EXACTLY what the
// database function public.get_homeowner_blocked_states() returns for it (gh-2492; CTO
// ruling 5969703832: one rule for every reader, and it is the database's). Fails CLOSED:
//   - not an array (missing row, null, string, object, number, boolean)  -> default FL/LA/TX
//   - empty array: a deliberate "nothing blocked"                        -> []
//   - ANY element that is not a string holding a two-letter A-Z code     -> the WHOLE value is
//     rejected and the default is returned (dropping only the bad element would silently
//     UNBLOCK a state on a typo: ["FL","LA","Texas"] must not open Texas)
//   - otherwise the distinct upper-cased codes, sorted.
// "Two-letter code" is the SQL test `upper(btrim(e)) ~ '^[A-Z]{2}$'`: btrim() strips SPACES
// only (not tab / newline / no-break space, which JS trim() would also strip), and upper() is a
// full Unicode case map (so "ß" becomes "SS", as in Postgres). Do not "simplify" this to
// normalizeState(), which is intentionally looser and is used for claim.property_state.
const TWO_LETTER_CODE = /^[A-Z]{2}$/;

function blockedStateCode(e: unknown): string | null {
  if (typeof e !== "string") return null;
  const code = e.replace(/^ +| +$/g, "").toUpperCase();
  return TWO_LETTER_CODE.test(code) ? code : null;
}

export function parseBlockedStates(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_BLOCKED_STATES];
  if (value.length === 0) return [];
  const codes: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const code = blockedStateCode(value[i]);
    if (code === null) return [...DEFAULT_BLOCKED_STATES];
    codes.push(code);
  }
  return [...new Set(codes)].sort();
}
