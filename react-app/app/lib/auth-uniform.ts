/**
 * gh-1883 [SECURITY]: routes a magic-link ("otp") or password-reset
 * ("recover") request through the auth-uniform Edge Function instead of
 * calling `supabase.auth.signInWithOtp()` / `supabase.auth.resetPasswordForEmail()`
 * directly. Those supabase-js methods call Supabase GoTrue's own
 * `/auth/v1/otp` and `/auth/v1/recover` routes straight from the browser —
 * both are confirmed unauthenticated account-enumeration oracles (distinct
 * status/body for `/otp`, a timing side-channel for `/recover`; see
 * supabase/functions/auth-uniform/index.ts's header for the full writeup).
 * Fronting them with our own EF only closes the oracle for callers that
 * route through it, so every first-party caller of the old direct methods
 * must call this helper instead — the entire point of this change. This is
 * the React-app twin of js/auth.js's `_callAuthUniform` (same contract,
 * same function on the backend); the static-site and React stacks each
 * carry their own Supabase client, so this cannot be a single shared file
 * without a build-time cross-stack import this repo does not otherwise use.
 *
 * The EF ALWAYS resolves with the same shape (`{}`) after a fixed minimum
 * delay, whether the address exists or not and whether GoTrue's own call
 * (dispatched server-side, off this request) succeeds or fails. The only
 * errors this can throw are caller-side (invalid input, bad redirect,
 * network failure, or the EF's own per-IP rate limit) — never anything
 * that distinguishes an existing address from an absent one.
 */

import { supabase } from './supabase';

export type AuthUniformAction = 'otp' | 'recover';

export async function callAuthUniform(
  action: AuthUniformAction,
  email: string,
  redirectTo: string,
): Promise<void> {
  const { error } = await supabase.functions.invoke('auth-uniform', {
    body: { action, email, redirectTo },
  });
  if (error) throw error;
}
