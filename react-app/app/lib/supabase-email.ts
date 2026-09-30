/**
 * gh-1980 PR 3/3 -- client for EMAIL-initiated auth calls (signUp confirmation
 * link, OTP, recovery). Ben, #1980 5889011351: email flows must never become
 * PKCE-bound. The shared client is pkce for the whole page load of a Google
 * ?code= return, so on such a load these calls use an explicitly implicit client
 * (same canonical storageKey + adapter; it only initiates: no URL detection, no
 * token refresh). On every other load it is simply the shared client.
 */
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { otterquoteCookieStorage, OTTERQUOTE_AUTH_STORAGE_KEY } from './cookie-storage';
import { PAGE_LOAD_FLOW_TYPE } from './oauth-pkce';
import { nonDeadlockingLock } from './supabase-lock';

export function getEmailAuthClient(): SupabaseClient {
  if (PAGE_LOAD_FLOW_TYPE !== 'pkce') return supabase;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('Missing Supabase environment variables.');
  return createClient(url, anon, {
    auth: {
      flowType: 'implicit',
      persistSession: true,
      storageKey: OTTERQUOTE_AUTH_STORAGE_KEY,
      storage: otterquoteCookieStorage,
      detectSessionInUrl: false,
      autoRefreshToken: false,
      lock: nonDeadlockingLock,
    },
  });
}
