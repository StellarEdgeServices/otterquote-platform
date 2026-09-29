/**
 * gh-2344 -- owner binding for the `cs_auth_role` routing breadcrumb.
 *
 * `cs_auth_role` (+ `cs_auth_role_at`, 24h TTL) is written just before a
 * login/signup entry point sends the user into the Supabase auth flow and is
 * read by the next sign-in on the same browser. The TTL bounds age but not
 * WHO the breadcrumb is for: on a shared device, a stranger's abandoned
 * contractor signup steers the next person's post-login routing.
 *
 * Fix: `cs_auth_role_email` is stored beside the role (trimmed, lowercased
 * signer email). A reader honours the breadcrumb only when that stored email
 * equals the signed-in user's email (same normalisation); otherwise it is
 * ignored and all keys are cleared. A legacy breadcrumb with no owner is
 * treated as foreign.
 *
 * Google OAuth writers do not know the signer's email before the redirect.
 * They store `oauth-tab:<nonce>` instead and keep the same nonce in
 * sessionStorage (`cs_auth_role_tab`), which survives the same-tab Google
 * round trip but not a closed tab or another user's tab. Mirrors js/auth.js
 * (Auth.stampRoleOwner / Auth.roleOwnerMatches) and index.html.
 */
export const ROLE_KEY = 'cs_auth_role';
export const ROLE_AT_KEY = 'cs_auth_role_at';
export const ROLE_EMAIL_KEY = 'cs_auth_role_email';
export const ROLE_TAB_KEY = 'cs_auth_role_tab';
const OAUTH_PREFIX = 'oauth-tab:';

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Store the owner beside the role. Pass the signer's email, or null/undefined for an OAuth (email-unknown) write. */
export function stampRoleOwner(email?: string | null): void {
  if (typeof localStorage === 'undefined') return;
  const e = norm(email);
  if (e) {
    localStorage.setItem(ROLE_EMAIL_KEY, e);
    return;
  }
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { sessionStorage.setItem(ROLE_TAB_KEY, nonce); } catch { /* non-fatal */ }
  localStorage.setItem(ROLE_EMAIL_KEY, OAUTH_PREFIX + nonce);
}

export function clearRoleBreadcrumb(): void {
  if (typeof localStorage === 'undefined') return;
  for (const k of [ROLE_KEY, ROLE_AT_KEY, ROLE_EMAIL_KEY]) {
    try { localStorage.removeItem(k); } catch { /* non-fatal */ }
  }
  try { sessionStorage.removeItem(ROLE_TAB_KEY); } catch { /* non-fatal */ }
}

/** True only when the stored owner is this signer (email match, or this tab's OAuth nonce). */
export function roleOwnerMatches(userEmail: string | null | undefined): boolean {
  if (typeof localStorage === 'undefined') return false;
  const stored = localStorage.getItem(ROLE_EMAIL_KEY);
  if (!stored) return false;
  if (stored.indexOf(OAUTH_PREFIX) === 0) {
    let tab: string | null = null;
    try { tab = sessionStorage.getItem(ROLE_TAB_KEY); } catch { tab = null; }
    return !!tab && stored === OAUTH_PREFIX + tab;
  }
  const u = norm(userEmail);
  return !!u && norm(stored) === u;
}
