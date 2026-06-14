-- Migration v90 — contractors: admin email SELECT policy
-- Applied to prod 2026-06-13 (migration version 20260613200922).
-- Committed to repo retroactively to fix prod-vs-repo drift. Idempotent CREATE.
-- Prereq for v90b (drop of the broad "Authenticated users can read contractors" USING(true) policy).
DROP POLICY IF EXISTS "Admin can read all contractors" ON public.contractors;
CREATE POLICY "Admin can read all contractors"
  ON public.contractors
  FOR SELECT
  TO authenticated
  USING (auth.jwt()->>'email' = 'dustinstohler1@gmail.com');
