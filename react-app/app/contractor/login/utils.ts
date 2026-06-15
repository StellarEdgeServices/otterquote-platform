/**
 * Contractor-login page pure helpers + redirect targets — D-211 P4.
 *
 * Extracted so the parity test can assert redirect/validation logic without
 * importing page.tsx (which pulls in the Supabase client). Mirrors the static
 * contractor-login.html + the live React /login + /auth-callback conventions:
 *   - magic link + Google OAuth land on the React auth-callback route
 *   - contractor-table-first routing is owned by /auth-callback, driven by the
 *     `cs_auth_role='contractor'` signal this page sets before each flow
 *   - cross-stack links/redirects go to the static otterquote.com app shell
 */

// React auth-callback route (app.otterquote.com) — same target as /login + /get-started.
export const AUTH_CALLBACK_URL = 'https://app.otterquote.com/auth-callback';
// Google OAuth carries the contractor intent — parity with contractor-login.html
// Auth.signInWithGoogle('/auth-callback.html?intent=contractor').
export const GOOGLE_OAUTH_REDIRECT = `${AUTH_CALLBACK_URL}?intent=contractor`;

// Cross-stack app-shell destinations (static stack still serves these).
export const CONTRACTOR_DASHBOARD_URL = 'https://otterquote.com/contractor-dashboard.html';
export const CONTRACTOR_JOIN_URL = 'https://otterquote.com/contractor-join.html';
export const LOGIN_URL = 'https://otterquote.com/login.html';

/**
 * Email validity — identical regex to static contractor-login.html and /login utils.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * True when the user just bounced here FROM the contractor dashboard — the
 * documented dashboard ↔ login flip guard (contractor-login.html, May 4 2026).
 * When true we must NOT redirect an authenticated contractor back to the
 * dashboard, or we create an infinite loop.
 */
export function cameFromContractorDashboard(referrer: string | null | undefined): boolean {
  return (referrer || '').includes('/contractor-dashboard.html');
}
