/**
 * gh-2060 item 2 -- freshness guard for the `cs_signup` blob (localStorage).
 *
 * get-started writes the homeowner's name / phone / address here before the
 * magic link or Google round trip, and later steps (auth-callback HubSpot sync,
 * trade-selector prefill + claim/profile writes, dashboard profile bootstrap)
 * read it back. It had no owner key and no timestamp, so an abandoned signup
 * left on a shared browser seeded the NEXT person's profile and HubSpot contact.
 *
 * Same rule as `cs_auth_role`: `cs_signup_at` must be present, not future-dated
 * and at most 24h old, otherwise the blob is ignored AND cleared. Sign-out clears
 * it too (providers/auth-provider.tsx). Mirrors js/auth.js readFreshSignupRaw.
 */
export const CS_SIGNUP_KEY = 'cs_signup';
export const CS_SIGNUP_AT_KEY = 'cs_signup_at';
export const CS_SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;

export function clearSignup(): void {
  for (const k of [CS_SIGNUP_KEY, CS_SIGNUP_AT_KEY]) {
    try { localStorage.removeItem(k); } catch { /* non-fatal */ }
    try { sessionStorage.removeItem(k); } catch { /* non-fatal */ }
  }
}

/** Stamp the blob just written by get-started (the only creator). */
export function stampSignup(): void {
  try { localStorage.setItem(CS_SIGNUP_AT_KEY, String(Date.now())); } catch { /* non-fatal */ }
}

/**
 * Raw JSON of a FRESH cs_signup, or null. A missing, future-dated or stale
 * stamp counts as stale: the blob is cleared and null returned.
 */
export function readFreshSignupRaw(): string | null {
  let raw: string | null = null;
  let at = NaN;
  try {
    if (typeof localStorage === 'undefined') return null;
    raw = localStorage.getItem(CS_SIGNUP_KEY);
    at = parseInt(localStorage.getItem(CS_SIGNUP_AT_KEY) || '', 10);
  } catch {
    return null;
  }
  if (!raw) return null;
  const age = Date.now() - at;
  if (!Number.isFinite(at) || age < 0 || age > CS_SIGNUP_TTL_MS) {
    console.warn('[cs_signup] ignored and cleared: missing, future-dated or stale cs_signup_at stamp');
    clearSignup();
    return null;
  }
  return raw;
}
