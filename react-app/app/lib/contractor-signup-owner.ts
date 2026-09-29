/**
 * gh-2340 -- owner + freshness guard for the `cs_contractor_signup` blob.
 *
 * contractor-join.html writes the blob (company data, signer email, `_at`
 * stamp) before the magic link is sent. It is applied on the NEXT sign-in in
 * this browser, so an abandoned signup on a shared browser used to leak a
 * stranger's company data onto whoever signed in next. Mirrors js/auth.js
 * `getOwnedContractorSignup` (the static stack shares this localStorage key).
 *
 * Honour the blob only when its stored email equals the signed-in user's
 * email (case-insensitive, trimmed) AND its `_at` stamp is present, not
 * future-dated, and under 24h old. Otherwise ignore it, clear it, and
 * console.warn (no user-visible text).
 *
 * The React stack never writes profiles.role from this blob: the only React
 * consumer is the pre-approval page, which builds the contractors stub from it
 * for a user who deliberately reached the contractor wizard. The role guard
 * for "existing non-contractor account" therefore lives in js/auth.js
 * handleAuthCallback (the one place that promotes a role from the blob).
 */
export const CONTRACTOR_SIGNUP_KEY = 'cs_contractor_signup';
export const CONTRACTOR_SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export function clearContractorSignup(): void {
  if (typeof localStorage === 'undefined') return;
  for (const k of [CONTRACTOR_SIGNUP_KEY, `${CONTRACTOR_SIGNUP_KEY}_at`, `${CONTRACTOR_SIGNUP_KEY}_session`]) {
    try { localStorage.removeItem(k); } catch { /* non-fatal */ }
    try { sessionStorage.removeItem(k); } catch { /* non-fatal */ }
  }
}

/** Parsed blob if it belongs to `userEmail` and is fresh; otherwise null (and the blob is cleared). */
export function readOwnedContractorSignup(
  userEmail: string | null | undefined,
  now: number = Date.now(),
): Record<string, unknown> | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(CONTRACTOR_SIGNUP_KEY);
  if (!raw) return null;
  const reject = (why: string): null => {
    console.warn(`[cs_contractor_signup] ignored and cleared: ${why}`);
    clearContractorSignup();
    return null;
  };
  let data: Record<string, unknown> | null = null;
  try {
    const o = JSON.parse(raw);
    data = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    data = null;
  }
  if (!data) return reject('unparseable blob');
  const email = norm(userEmail);
  if (!email || norm(data.email) !== email) return reject('email does not match the signed-in user');
  const at = Number(data._at != null ? data._at : localStorage.getItem(`${CONTRACTOR_SIGNUP_KEY}_at`));
  const age = now - at;
  if (!Number.isFinite(at) || at <= 0 || age < 0 || age >= CONTRACTOR_SIGNUP_TTL_MS) {
    return reject('missing, future-dated or stale _at stamp');
  }
  return data;
}
