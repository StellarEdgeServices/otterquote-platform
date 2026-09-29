-- GH #1529 close-review 5868970662 must-fix items, under the tier:3b-approved
-- window (notice 5526298002, approval 5540927972, closed 2026-09-04 no objection).
-- Trigger functions below picked up default PUBLIC EXECUTE on creation; nothing
-- calls them over RPC (grep of main confirmed no .rpc() callers, and
-- claims_guard_measurement_shape/contractors_inherit_profile_is_test/
-- set_is_test_for_internal_test_domain are all BEFORE trigger functions).
-- Proven safe in a BEGIN...ROLLBACK first: triggers still fire and the
-- measurement_shape guard still raises 42501 after these revokes.

REVOKE EXECUTE ON FUNCTION public.claims_guard_measurement_shape() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.contractors_inherit_profile_is_test() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_is_test_for_internal_test_domain() FROM PUBLIC, anon, authenticated;

-- Migration 20260927150342 narrowed the quotes INSERT policy to {authenticated}
-- but left anon's table-level INSERT grant in place (RLS still blocked it, but
-- the grant itself is surface that should not exist).
REVOKE INSERT ON public.quotes FROM anon;
