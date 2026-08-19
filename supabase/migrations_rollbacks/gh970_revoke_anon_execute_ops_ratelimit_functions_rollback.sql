-- Rollback for: 20260818214604_gh970_revoke_anon_execute_ops_ratelimit_functions.sql
-- GitHub: #970
-- Restores the pre-migration proacl for all 6 functions:
-- {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

BEGIN;

GRANT EXECUTE ON FUNCTION public.acknowledge_alert(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_alert(uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.cleanup_old_rate_limits() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_old_rate_limits() TO anon;
GRANT EXECUTE ON FUNCTION public.cleanup_old_rate_limits() TO authenticated;

GRANT EXECUTE ON FUNCTION public.record_cron_health(text, text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_cron_health(text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.record_cron_health(text, text, text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.update_keepalive_health(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_keepalive_health(text) TO anon;
GRANT EXECUTE ON FUNCTION public.update_keepalive_health(text) TO authenticated;

COMMIT;
