-- RATCHET-FIXTURE: EXPECT=FAIL
-- CREATE POLICY collapsing USING to unconditional true -- the RLS-widening
-- shape from "What to build."
BEGIN;

DROP POLICY IF EXISTS "contractors can read own row" ON public.contractors;
CREATE POLICY "contractors can read own row" ON public.contractors
  FOR SELECT
  USING (true);

COMMIT;
