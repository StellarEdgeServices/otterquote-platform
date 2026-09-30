/**
 * gh-1980 PR 3/3 -- Google OAuth initiation over PKCE (the ONLY PKCE flow).
 *
 * A dedicated pkce-flow client (flowType is client-wide in supabase-js) built
 * on a verifier-only storage adapter under the canonical storageKey: the
 * `<storageKey>-code-verifier` it writes lands (origin localStorage, via the
 * shared adapter's auxiliary-key routing) exactly where the callback's client
 * reads it, and it can never touch the shared session cookies. It does not
 * detect URL sessions or refresh tokens; it only starts the redirect.
 * Email-initiated flows never use this client (they stay implicit).
 */
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient, OAuthResponse } from '@supabase/supabase-js';
import { otterquoteCookieStorage, OTTERQUOTE_AUTH_STORAGE_KEY } from './cookie-storage';
import { createVerifierOnlyStorage } from './oauth-pkce';
import { nonDeadlockingLock } from './supabase-lock';

export interface GoogleOAuthOptions {
  redirectTo: string;
  scopes?: string;
  queryParams?: Record<string, string>;
  skipBrowserRedirect?: boolean;
}

export function createOAuthPkceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error('Missing Supabase environment variables.');
  }
  return createClient(url, anon, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      storageKey: OTTERQUOTE_AUTH_STORAGE_KEY,
      storage: createVerifierOnlyStorage(otterquoteCookieStorage),
      detectSessionInUrl: false,
      autoRefreshToken: false,
      lock: nonDeadlockingLock,
    },
  });
}

/** Start Google sign-in with PKCE. Navigates the browser to Google on success. */
export function signInWithGoogleOAuth(options: GoogleOAuthOptions): Promise<OAuthResponse> {
  return createOAuthPkceClient().auth.signInWithOAuth({ provider: 'google', options });
}
