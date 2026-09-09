-- Rollback for: 20260908194734_gh1724_check_email_exists_rate_limit.sql
-- GitHub: #1724
-- WARNING: restores the PRE-FIX behavior -- check-email-exists has no
-- rate_limit_config row. Do not apply this rollback without also
-- reverting the check_rate_limit() call in
-- supabase/functions/check-email-exists/index.ts (same PR): that call is
-- unconditional, so with the row gone and the call still deployed, every
-- request to the function would be denied (check_rate_limit() fails
-- CLOSED when no config row exists), not merely unrated-limited.

DELETE FROM public.rate_limit_config WHERE function_name = 'check-email-exists';
