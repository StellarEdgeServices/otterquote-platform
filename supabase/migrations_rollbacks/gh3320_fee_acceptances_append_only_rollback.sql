-- gh-3320 ROLLBACK: restore the state measured on #3320 (2026-11-02): the admin UPDATE policy, UPDATE and DELETE for authenticated, UPDATE (not DELETE) for anon.
-- Run manually only if the gh-3320 forward change must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- Rows are never touched by either file. The policy text is the baseline's (supabase/migrations/20260101000000_v000_baseline_schema.sql:3626), byte for byte.

DROP POLICY IF EXISTS "Admin can update fee acceptances" ON public.fee_acceptances;
CREATE POLICY "Admin can update fee acceptances" ON public.fee_acceptances AS PERMISSIVE FOR UPDATE TO public
  USING (((auth.jwt() ->> 'email'::text) = 'dustinstohler1@gmail.com'::text));

GRANT UPDATE, DELETE ON TABLE public.fee_acceptances TO authenticated;
GRANT UPDATE ON TABLE public.fee_acceptances TO anon;
