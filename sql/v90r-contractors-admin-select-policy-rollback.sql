-- ============================================================================
-- Rollback for v90 — drop admin email SELECT policy on contractors
-- ============================================================================
BEGIN;

DROP POLICY IF EXISTS "Admin can read all contractors" ON public.contractors;

-- NOTE: If you ran the deferred DROP from v90 (dropped USING(true) policy),
-- restore it here:
-- CREATE POLICY "Authenticated users can read contractors"
--   ON public.contractors
--   FOR SELECT
--   TO authenticated
--   USING (true);

COMMIT;
