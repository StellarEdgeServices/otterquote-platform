-- Rollback for supabase/migrations/20260917203831_gh2010_leads_authenticated_insert.sql
-- Issue #2010.
--
-- Restores "Allow anonymous inserts" on public.leads to TO anon only,
-- undoing the authenticated-role widening. WITH CHECK (true) is unchanged
-- throughout -- this migration only ever touches the policy's role list.
--
-- Verify before running: this re-breaks the signed-in /start path (returns
-- it to the exact 42501 this migration fixed) -- only run this if #2010
-- must be reverted.
--
-- Post-rollback verification query (expect roles={anon} only):
--   select polname, polcmd, polroles::regrole[]::text[] as roles
--   from pg_policy where polrelid = 'public.leads'::regclass;

BEGIN;

ALTER POLICY "Allow anonymous inserts" ON public.leads
  TO anon;

COMMIT;
