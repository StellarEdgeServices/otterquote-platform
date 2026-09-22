import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  otterquoteCookieStorage,
  OTTERQUOTE_AUTH_STORAGE_KEY,
} from './cookie-storage';
import { nonDeadlockingLock } from './supabase-lock';
import { isInternalTraffic } from './internal-traffic';

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

// gh-2068: leads_force_safe_insert_defaults() (the BEFORE INSERT trigger on
// public.leads) forces is_synthetic=true whenever a leads insert request
// carries an X-OQ-Internal: 1 header -- the server-side connecting rule
// between gh-2064's client-side oq_internal opt-out and gh-2055's
// is_synthetic column. Set it here via supabase-js's `global.headers`
// client option so EVERY insert this singleton client makes (incl.
// /get-started's leads insert in persistSignupContext()) carries it
// automatically, computed once at client-creation time from the same
// isInternalTraffic() check GA4Gate.tsx/MetaPixelGate.tsx already use
// (gh-2064, react-app/app/lib/internal-traffic.ts) -- no separate
// detection logic to keep in sync. isInternalTraffic() is safe to call at
// module-eval time: it no-ops (returns false) outside a browser (SSR/build).
const oqInternalHeaders = isInternalTraffic() ? { 'x-oq-internal': '1' } : {};

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    storageKey: OTTERQUOTE_AUTH_STORAGE_KEY,
    storage: otterquoteCookieStorage,
    // Avoid the supabase-js navigator.locks deadlock that froze getSession() and
    // the contractor dashboard (D-211 2026-06-16, true root of Blocker 1).
    lock: nonDeadlockingLock,
  },
  global: {
    headers: oqInternalHeaders,
  },
});

// Server-side admin client lives in supabase-admin.ts — do not import here.
