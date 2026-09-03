-- Rollback for v113-homeowner-next-steps-nudge-cron (gh-1580).
--
-- Only meaningful once v113 has actually been applied. Unschedules the
-- send-homeowner-next-steps pg_cron job and removes its rate_limit_config
-- row. Does not touch supabase/functions/send-homeowner-next-steps/ or the
-- get-business-lines-dashboard / admin-dashboard.html changes — those are
-- inert without the cron running, not destructive, and are reverted by a
-- normal git revert of the PR if ever needed.

SELECT cron.unschedule('send-homeowner-next-steps');

DELETE FROM public.rate_limit_config WHERE function_name = 'send-homeowner-next-steps';
