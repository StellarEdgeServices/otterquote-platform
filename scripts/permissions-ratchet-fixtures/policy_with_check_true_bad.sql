-- RATCHET-FIXTURE: EXPECT=FAIL
-- WITH CHECK (true) half of the same rule -- an unconditional INSERT/UPDATE
-- policy is just as dangerous as an unconditional USING.
BEGIN;

DROP POLICY IF EXISTS "contractors can insert own row" ON public.contractors;
CREATE POLICY "contractors can insert own row" ON public.contractors
  FOR INSERT
  WITH CHECK (true);

COMMIT;
