-- RATCHET-FIXTURE: EXPECT=FAIL
-- Rule 2: ALTER FUNCTION ... SECURITY DEFINER newly appearing alongside a
-- GRANT to a non-service role in the SAME file's diff. Distinct from rule 1
-- -- "non-service role" is broader than just anon/PUBLIC/authenticated.
BEGIN;

ALTER FUNCTION public.some_existing_fn() SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.some_existing_fn() TO authenticated;

COMMIT;
