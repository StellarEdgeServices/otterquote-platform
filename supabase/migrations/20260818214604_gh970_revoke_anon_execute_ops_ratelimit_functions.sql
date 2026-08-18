-- gh-970: 6 internal ops/rate-limit SECURITY DEFINER functions were
-- anon-executable with zero auth check. D-182 approved by Dustin
-- 2026-08-18 ("APPROVE ALL 7"). Applied live via Supabase MCP; this file
-- is the git record. Full analysis + per-function caller audit: issue
-- #970 comment 5321000863.
--
-- authenticated retained ONLY on acknowledge_alert (live caller:
-- admin-contractors.html's Acknowledge button, gated client-side by
-- is_admin_email()-equivalent email check, not a server-side boundary -
-- the caller-analysis in the issue package flags this as a residual risk,
-- fast-follow candidate, not solved here).
--
-- Live-verified post-apply: proacl for all 6 shows anon removed (and
-- authenticated removed from 5 of 6); public.track_referral_click's
-- internal call to check_rate_limit (nested SECURITY DEFINER -> executes
-- as owner) still returns a valid uuid, confirming the revoke doesn't
-- break that call path.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.acknowledge_alert(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.acknowledge_alert(uuid) FROM anon;
-- authenticated: INTENTIONALLY NOT REVOKED (live caller, see above).

REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.check_rate_limit(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(uuid, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_rate_limits() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_rate_limits() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_rate_limits() FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.record_cron_health(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_cron_health(text, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.record_cron_health(text, text, text) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.update_keepalive_health(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_keepalive_health(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_keepalive_health(text) FROM authenticated;

COMMIT;
