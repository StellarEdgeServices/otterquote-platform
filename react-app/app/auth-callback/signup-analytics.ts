/**
 * GA4 `sign_up` (Google path) reliability fix — gh-1940, fired from the
 * auth-callback LANDING rather than pre-redirect in get-started/page.tsx.
 *
 * Extracted from page.tsx into its own pure-logic module (mirrors the
 * repo's page.tsx / use-*-data.ts / utils.ts split elsewhere in this app)
 * so the guard conditions are unit-testable without mounting the full
 * callback component and its Supabase auth-state wiring.
 *
 * fix2 (cto32-review-pr1979-20260915.md, REVIEW: FAIL) — the first version
 * of this fix was wrong on two counts, both corrected here:
 *
 *   B1: get-started/page.tsx's pre-redirect `sign_up` was NOT actually
 *   unreliable — the refuter's repro delivered it in every run — so adding
 *   this landing-side emit alongside it just double-counted the same
 *   signup. get-started/page.tsx no longer fires `sign_up` for the Google
 *   path AT ALL (see its `fireSignupAnalytics`); this file is now the ONLY
 *   place a Google `sign_up` is counted.
 *
 *   B2: firing `track('sign_up', ...)` fire-and-forget and then
 *   immediately continuing to `window.location.href = ...` (a full-page
 *   navigation) can tear the page down before gtag.js has processed the
 *   queued hit at all — the refuter measured `sign_up=0` on a fast
 *   connection, the exact opposite of "safer than pre-redirect". This is
 *   fixed by `fireSignUpAndWait` (see lib/track.ts): the landing now waits
 *   up to ~1s for gtag's own `event_callback` (or the timeout, whichever
 *   is first) before this function resolves, and the caller
 *   (auth-callback/page.tsx) awaits it before navigating away.
 *
 * `referral_source` is carried through from the `cs_signup` payload
 * get-started/page.tsx already writes to localStorage before the redirect
 * (`persistSignupContext`) — reusing that existing bridge rather than
 * inventing a second one, same reasoning as the HubSpot contact sync a few
 * lines above this in auth-callback/page.tsx.
 */

import { fireSignUpAndWait, type ReferralSource } from '@/lib/track';

/** A new account is one Supabase created within this window of "now". */
const NEW_SIGNUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes (upper bound — not "too old")

/**
 * fix2 (finding N3): tolerance for the CLIENT clock reading behind the
 * SERVER's `created_at` — without a lower bound, `Date.now() - createdMs`
 * going NEGATIVE (client clock behind server, or `created_at` briefly in
 * the future relative to this device) still satisfied `< 5min` and passed
 * for a genuinely returning user. Bounding age on both sides means
 * `created_at` must read as neither "too old" (a returning user) nor "too
 * far in the future" (clock skew / a malformed timestamp) to count as new.
 * 60s covers ordinary client/server clock drift without meaningfully
 * narrowing the legitimate new-signup window (which is 5 minutes wide).
 */
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000; // 1 minute

/** Default bound on how long the landing waits for gtag before navigating anyway. */
const SIGN_UP_WAIT_TIMEOUT_MS = 1000;

export interface SignUpGuardUser {
  id: string;
  created_at?: string | null;
  app_metadata?: { provider?: string | null } | null;
}

/** localStorage key namespacing the one-time marker, keyed per user id. */
export function signUpFiredKey(userId: string): string {
  return `oq_ga4_signup_fired_v1:${userId}`;
}

export function hasFiredSignUp(userId: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(signUpFiredKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function markSignUpFired(userId: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(signUpFiredKey(userId), '1');
  } catch {
    // best-effort — a storage failure just risks a rare re-fire, never a crash
  }
}

/**
 * True only for an account Supabase created within the last few minutes,
 * and not implausibly in the future (fix2 N3 — see CLOCK_SKEW_TOLERANCE_MS
 * above). `age` is how long ago `created_at` was, in ms; negative means
 * `created_at` is in the future relative to this device's clock.
 */
export function isNewlyCreatedUser(user: Pick<SignUpGuardUser, 'created_at'>): boolean {
  if (!user.created_at) return false;
  const createdMs = Date.parse(user.created_at);
  if (Number.isNaN(createdMs)) return false;
  const age = Date.now() - createdMs;
  return age > -CLOCK_SKEW_TOLERANCE_MS && age < NEW_SIGNUP_WINDOW_MS;
}

/**
 * Reads the `referral_source` get-started/page.tsx stashed in `cs_signup`
 * before the OAuth redirect. Best-effort: any parse failure or a missing/
 * non-string value yields `''`, which `fireSignUpAndWait` (via
 * `lib/track.ts`'s closed `ReferralSource` sanitizer) already treats as the
 * "unknown/none" case — this function does not need its own vocabulary
 * check, only to hand back whatever raw value cs_signup has, or a safe
 * fallback.
 */
export function readReferralSourceFromCsSignup(): ReferralSource {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('cs_signup') : null;
    if (!raw) return '';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.referral_source === 'string' ? (parsed.referral_source as ReferralSource) : '';
  } catch {
    return '';
  }
}

/**
 * Fire GA4 `sign_up` (method: 'google') exactly once for a brand-new Google
 * signup, landing here with a live session. Guarded so it can never
 * double-count and never fires for a returning sign-in:
 *
 *   1. `app_metadata.provider === 'google'` — only the Google path; the
 *      password path's `sign_up` already lives in get-started/page.tsx
 *      (gh-1948) and is unchanged by this PR.
 *   2. `isNewlyCreatedUser` — bounded on both sides (see above), so a
 *      returning Google sign-in never reaches the marker check at all.
 *   3. the one-time localStorage marker.
 *
 * fix2: the marker is now set AFTER `fireSignUpAndWait` resolves `true`
 * (queued/sent), not before the emit — the prior ordering could burn the
 * once-only marker for a hit that gtag never actually had a chance to
 * queue (gtag absent this pageload), permanently losing that user's
 * `sign_up` on every future landing even after GA4Gate goes on to load
 * normally. If `fireSignUpAndWait` resolves `false` (gtag was never
 * present), the marker is left unset so a later landing (e.g. a reload
 * once GA4Gate mounts) can still count it.
 *
 * Returns a Promise so the caller (auth-callback/page.tsx) can await it
 * before navigating away — see fireSignUpAndWait's header for why that
 * ordering is the fix for B2.
 */
export async function maybeFireGoogleSignUp(
  user: SignUpGuardUser,
  referralSource: ReferralSource,
  timeoutMs: number = SIGN_UP_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  if (user.app_metadata?.provider !== 'google') return false;
  if (!isNewlyCreatedUser(user)) return false;
  if (hasFiredSignUp(user.id)) return false;

  const queued = await fireSignUpAndWait({ method: 'google', referral_source: referralSource }, timeoutMs);
  if (queued) markSignUpFired(user.id);
  return queued;
}
