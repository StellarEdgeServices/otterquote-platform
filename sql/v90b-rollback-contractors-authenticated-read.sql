-- Rollback v90b — restore the legacy broad authenticated read policy on contractors.
-- WARNING: re-grants full base-table read to every authenticated user. Use only to revert v90b.
CREATE POLICY "Authenticated users can read contractors"
  ON public.contractors
  FOR SELECT
  TO authenticated
  USING (true);
