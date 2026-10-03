-- Rollback for: 20261003140000_gh2462_send_support_email_rate_limit.sql
-- GitHub: #2462
-- WARNING: do not apply this without also reverting the check_rate_limit() call in
-- supabase/functions/send-support-email/index.ts. The call is unconditional, so with the row
-- gone and the call still deployed, check_rate_limit() fails CLOSED and every request to the
-- function is answered 429.

DELETE FROM public.rate_limit_config WHERE function_name = 'send-support-email';
