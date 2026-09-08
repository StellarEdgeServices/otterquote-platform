-- Rollback for: supabase/migrations/20260908203218_gh1724_check_email_exists_rate_limit.sql
-- GitHub: #1724
-- WARNING: restores the PRE-FIX behavior - removes the per-IP rate-limit
-- config row for check-email-exists. After this rollback,
-- check_rate_limit('check-email-exists', ...) returns "No rate limit config
-- found ... Denying by default", which the Edge Function treats as ALLOW
-- (fail-open) - i.e. the endpoint returns to unlimited unauthenticated
-- enumeration (30/30 burst accepted), exactly the state gh-1724 documents.
-- The Edge Function code itself needs no rollback: it fails open on a missing
-- config row by design, so deleting this row fully disarms the limiter with
-- no redeploy.

DELETE FROM public.rate_limit_config WHERE function_name = 'check-email-exists';
