-- ============================================================================
-- Rollback v89 — Remove contractors_public view + owner SELECT policy
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS public.contractors_public;
DROP POLICY IF EXISTS "Contractors can read own record" ON public.contractors;

COMMIT;
