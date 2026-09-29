-- ROLLBACK for 20260928114011_gh1529_revoke_anon_trigger_fns_and_quotes_insert.sql
--
-- Restores EXECUTE to PUBLIC, anon and authenticated on the 3 trigger
-- functions, and restores anon's table-level INSERT on public.quotes,
-- exactly as they stood before that migration. Unlike the earlier gh1529
-- rounds, the forward file here also revoked from `authenticated` (these are
-- pure trigger functions; nothing legitimate calls them via RPC as either
-- role), so authenticated must be re-granted here too or this rollback is
-- incomplete.
--
-- Live proacl snapshot used to build this file (project yeszghaspzwwstvsrioa,
-- 2026-09-28, before any DDL from the forward migration ran):
--   claims_guard_measurement_shape
--   contractors_inherit_profile_is_test
--   set_is_test_for_internal_test_domain
--     -- all three carried {=X/postgres,postgres=X/postgres,anon=X/postgres,
--        authenticated=X/postgres,service_role=X/postgres} -- PUBLIC, anon
--        and authenticated all restored for each.
-- quotes: anon INSERT restored (RLS policy "Contractors can insert quotes"
-- is unaffected either way -- it already scopes to {authenticated}).
--
-- Proven in a forced BEGIN...ROLLBACK against production on 2026-09-28
-- (issue #1529, comment 5869205819): after running this file's GRANTs,
-- has_function_privilege('anon'/'authenticated'/'public', ..., 'EXECUTE') was
-- true for all 3 functions and has_table_privilege('anon','public.quotes',
-- 'INSERT') was true, matching the pre-image; re-running the forward REVOKEs
-- reproduced today's live state exactly (proacl string-equal).

BEGIN;

GRANT EXECUTE ON FUNCTION public.claims_guard_measurement_shape() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contractors_inherit_profile_is_test() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_is_test_for_internal_test_domain() TO PUBLIC, anon, authenticated;

GRANT INSERT ON public.quotes TO anon;

COMMIT;
