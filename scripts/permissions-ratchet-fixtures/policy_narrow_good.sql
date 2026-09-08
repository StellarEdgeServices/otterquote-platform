-- RATCHET-FIXTURE: EXPECT=PASS
-- CREATE POLICY with a real predicate -- must not be mistaken for a
-- widening just because it is a new policy.
BEGIN;

DROP POLICY IF EXISTS "contractors can read own row" ON public.contractors;
CREATE POLICY "contractors can read own row" ON public.contractors
  FOR SELECT
  USING (auth.uid() = owner_id);

COMMIT;
