/**
 * gh-1980 PR 3/3 -- legacy implicit-flow fragment rescue for the auth callback.
 *
 * The browser client is now `flowType: 'pkce'`. Under pkce, supabase-js
 * (2.116.0, GoTrueClient._getSessionFromURL) REJECTS a legacy implicit-flow
 * URL (`#access_token=...&refresh_token=...`) with "Not a valid PKCE flow
 * url" and leaves the fragment in place. Auth links emailed BEFORE the flip
 * (and any link the auth-uniform Edge Function still issues in implicit
 * form) carry exactly that fragment, so instead of hard-failing we recover
 * the session from it by hand. Resolves true only if a session was
 * established (setSession then emits SIGNED_IN, which the callback page's
 * onAuthStateChange handler routes on).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export async function rescueImplicitFragment(
  client: Pick<SupabaseClient, 'auth'>,
  win: Pick<Window, 'location' | 'history'> = window,
): Promise<boolean> {
  try {
    const hash = win.location.hash;
    if (!hash || !hash.includes('access_token')) return false;
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) return false;
    const { data, error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error || !data?.session) return false;
    try {
      win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search);
    } catch {
      // non-fatal: the fragment simply stays in the address bar
    }
    return true;
  } catch {
    return false;
  }
}