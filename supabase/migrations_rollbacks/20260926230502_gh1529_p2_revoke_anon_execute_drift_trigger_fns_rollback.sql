-- ROLLBACK for 20260926230502_gh1529_p2_revoke_anon_execute_drift_trigger_fns.sql
--
-- Restores EXECUTE to PUBLIC and anon exactly as captured live from
-- pg_proc.proacl before the forward migration, for each of the 3 functions
-- it touches. authenticated and service_role are never revoked or granted
-- here -- the forward file never touches them.
--
-- Live proacl snapshot used to build this file (project yeszghaspzwwstvsrioa,
-- 2026-09-26, before any DDL from this migration runs):
--   notify_admin_new_claim
--   notify_admin_new_partner
--   notify_admin_new_router_lead
--     -- all three carried {=X/postgres,postgres=X/postgres,anon=X/postgres,
--        authenticated=X/postgres,service_role=X/postgres} -- PUBLIC + anon
--        restored for each.

BEGIN;

GRANT EXECUTE ON FUNCTION public.notify_admin_new_claim() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_admin_new_claim() TO anon;

GRANT EXECUTE ON FUNCTION public.notify_admin_new_partner() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_admin_new_partner() TO anon;

GRANT EXECUTE ON FUNCTION public.notify_admin_new_router_lead() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_admin_new_router_lead() TO anon;

COMMIT;
