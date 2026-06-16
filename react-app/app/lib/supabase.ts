import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  otterquoteCookieStorage,
  OTTERQUOTE_AUTH_STORAGE_KEY,
} from './cookie-storage';
import { nonDeadlockingLock } from './supabase-lock';

/**
 * Singleton Supabase client for the browser.
 *
 * Environment-aware: throws at module load time if required env vars are missing.
 *
 * Uses the OtterQuote cookie storage adapter (D-212 / ClickUp 86e1bpk7b — May 12,
 * 2026). Token-only cookies scoped to .otterquote.com so sessions cross from
 * otterquote.com to app.otterquote.com without exceeding the per-cookie size
 * limit. Both stacks (static js/ + this React app) must wire the same adapter
 * and the same storageKey for SSO to work — that contract is enforced by
 * importing OTTERQUOTE_AUTH_STORAGE_KEY from the shared adapter file.
 *
 * See react-app/app/lib/cookie-storage.ts and js/cookie-storage.js for design.
 * Regression spec: tests/e2e/flows/cross-subdomain-sso.spec.ts.
 *
 * Uses anon key (NEXT_PUBLIC_SUPABASE_ANON_KEY) — always safe to ship to browser.
 * Never use SUPABASE_SERVICE_ROLE_KEY in browser context.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. ' +
    'Ensure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set.'
  );
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    storageKey: OTTERQUOTE_AUTH_STORAGE_KEY,
    storage: otterquoteCookieStorage,
    // Avoid the supabase-js navigator.locks deadlock that froze getSession() and
    // the contractor dashboard (D-211 2026-06-16, true root of Blocker 1).
    lock: nonDeadlockingLock,
  },
});

// Server-side admin client lives in supabase-admin.ts — do not import here.
