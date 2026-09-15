/**
 * GA4 `sign_up` (Google path) reliability fix — gh-1940, fired from the
 * auth-callback LANDING rather than pre-redirect in get-started/page.tsx.
 *
 * Extracted from page.tsx into its own pure-logic module (mirrors the
 * repo's page.tsx / use-*-data.ts / utils.ts split elsewhere in this app)
 * so the guard conditions are unit-testable without mounting the full
 * callback component and its Supabase auth-state wiring.
 *
 * Root cause this replaces: get-started/page.tsx's `handleGoogle` fires its
 * own local `sign_up` immediately before `supabase.auth.signInWithOAuth`
 * redirects the browser to accounts.google.com. GA4 property 541423859
 * showed 0 `sign_up` events over 10 days against 2 real `auth.users` rows
 * in the same window (#1940) — gtag.js's default transport does not
 * guarantee that pre-redirect hit is flushed before the cross-origin
 * navigation cancels it. This page is the LANDING both OAuth paths return
 * to, with a live session and no imminent unload, so it is a materially
 * safer place to count the "account created" funnel step for the Google
 * path specifically.
 */

import { track } from '@/lib/track';

/** A new account is one Supabase created within this window of "now". */
const NEW_SIGNUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

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

/** True only for an account Supabase created within the last few minutes. */
export function isNewlyCreatedUser(user: Pick<SignUpGuardUser, 'created_at'>): boolean {
  if (!user.created_at) return false;
  const createdMs = Date.parse(user.created_at);
  if (Number.isNaN(createdMs)) return false;
  return Date.now() - createdMs < NEW_SIGNUP_WINDOW_MS;
}

/**
 * Fire GA4 `sign_up` (method: 'google') exactly once for a brand-new Google
 * signup, landing here with a live session. Guarded three ways so it can
 * never double-count and never fires for a returning sign-in:
 *
 *   1. `app_metadata.provider === 'google'` — only the Google path; the
 *      password path's `sign_up` already lives in get-started/page.tsx
 *      (gh-1948) and is unchanged by this PR.
 *   2. `isNewlyCreatedUser` — a returning user's `created_at` is always
 *      well outside the window, so a returning Google sign-in never
 *      reaches the marker check at all.
 *   3. the one-time localStorage marker, set BEFORE the emit — even a
 *      double-invocation of routeSession (e.g. onAuthStateChange firing
 *      SIGNED_IN then INITIAL_SESSION for the same session, or the
 *      visitor reloading the callback page) fires at most once per
 *      browser per user id.
 *
 * Returns true iff it actually emitted (test-observable without spying on
 * the module-level `track` import).
 */
export function maybeFireGoogleSignUp(user: SignUpGuardUser): boolean {
  if (user.app_metadata?.provider !== 'google') return false;
  if (!isNewlyCreatedUser(user)) return false;
  if (hasFiredSignUp(user.id)) return false;
  markSignUpFired(user.id);
  track('sign_up', { method: 'google' });
  return true;
}
