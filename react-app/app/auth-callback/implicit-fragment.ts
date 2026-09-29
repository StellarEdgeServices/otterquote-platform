/**
 * gh-1980 PR 3/3 -- implicit-fragment rescue for the React auth callback.
 *
 * Emailed magic / recovery / confirmation links stay IMPLICIT (Google is the only
 * PKCE flow; Dustin, #1980 comment 5889011351), so they arrive as
 * `#access_token=...&refresh_token=...`. The shared client is an implicit client
 * on such a load, so supabase-js's detectSessionInUrl normally consumes the
 * fragment; if it did not (client that skipped it, or a stale pkce page load
 * that refused it with "Not a valid PKCE flow url."), recover the session by
 * hand instead of hard-failing. Resolves true only if a session was
 * established (setSession then emits SIGNED_IN, which the callback page's
 * onAuthStateChange handler routes on). Static twin: js/auth.js
 * rescueImplicitFragment().
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