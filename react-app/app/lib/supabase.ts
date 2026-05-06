import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Singleton Supabase client for the browser.
 *
 * Environment-aware: throws at module load time if required env vars are missing.
 * Configured with sb_at storage key (per D-211 spec — sq_at is deprecated).
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
    storageKey: 'sb_at', // D-211: sb_at only (not sq_at, which is deprecated)
  },
});

/**
 * Server-side admin client (NEVER ship to browser).
 * Used only in Next.js API routes and server components.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY which grants unrestricted database access.
 */
export const supabaseAdmin: SupabaseClient | null = (() => {
  const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!adminKey) {
    console.warn('SUPABASE_SERVICE_ROLE_KEY not set — admin operations unavailable.');
    return null;
  }
  return createClient(supabaseUrl!, adminKey, {
    auth: { persistSession: false },
  });
})();
