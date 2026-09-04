-- Rollback for v114-watch-template-mapping-cron (gh-1313).
--
-- Only meaningful once v114 has actually been applied. Unschedules the
-- watch-template-mapping pg_cron job and removes its rate_limit_config
-- row. Does not touch supabase/functions/watch-template-mapping/ or the
-- admin-template-review.html age column — those are inert without the cron
-- running, not destructive, and are reverted by a normal git revert of the
-- PR if ever needed. platform_alerts_log rows already written (alert_type
-- 'template_stuck') are left in place: they are history, and the admin can
-- acknowledge them like any other alert.

SELECT cron.unschedule('watch-template-mapping');

DELETE FROM public.rate_limit_config WHERE function_name = 'watch-template-mapping';
