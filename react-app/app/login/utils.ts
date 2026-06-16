/**
 * Login page pure helpers + redirect targets — D-211 P3.
 *
 * Extracted so the parity test can assert redirect/validation logic without
 * importing page.tsx (which pulls in the Supabase client). Mirrors the static
 * login.html + the live React /get-started + /auth-callback conventions:
 *   - magic link + Google OAuth land on the React auth-callback route
 *   - cross-stack post-auth redirects go to the static otterquote.com app shell
 */

// React auth-callback route (app.otterquote.com) — same target as /get-started.
export const AUTH_CALLBACK_URL = 'https://app.otterquote.com/auth-callback';
// Google OAuth carries the homeowner intent (parity with login.html ?intent=homeowner).
export const GOOGLE_OAUTH_REDIRECT = `${AUTH_CALLBACK_URL}?intent=homeowner`;

// App-shell destinations (static stack still serves these — except the contractor
// dashboard, now LIVE in React per D-211 Phase 2).
export const DASHBOARD_URL = 'https://otterquote.com/dashboard.html';
export const CONTRACTOR_DASHBOARD_URL = '/contractor/dashboard';
export const GET_STARTED_URL = 'https://otterquote.com/get-started.html';
export const CONTRACTOR_LOGIN_URL = 'https://otterquote.com/contractor-login.html';

/**
 * Email validity — identical regex to static login.html and /get-started utils.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Role-appropriate app-shell destination for an already-authenticated user
 * landing on /login (mirrors Auth.redirectToDashboard's role branch). Nuanced
 * homeowner claim/trade-selector routing is owned by /auth-callback.
 */
export function dashboardUrlForRole(role: string | null): string {
  return role === 'contractor' ? CONTRACTOR_DASHBOARD_URL : DASHBOARD_URL;
}
