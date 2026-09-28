-- Rollback for: 20260927170000_gh1883_auth_uniform_rate_limit.sql
-- GitHub: #1883
-- WARNING: restores the PRE-FIX behavior for the rate-limit ROW only --
-- check_rate_limit() denies by default (fails CLOSED) for a function with
-- no config row, so applying this rollback while auth-uniform/index.ts is
-- still deployed would make EVERY call to it 429. Do not apply this
-- rollback without also rolling back the caller changes that route through
-- auth-uniform back to direct supabase.auth.signInWithOtp() /
-- resetPasswordForEmail() calls (same PR) -- see the PR's go-live order
-- notice (R-097) for the full rollback sequence.

DELETE FROM public.rate_limit_config WHERE function_name = 'auth-uniform';
