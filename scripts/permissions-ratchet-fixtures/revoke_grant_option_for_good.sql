-- RATCHET-FIXTURE: EXPECT=PASS
-- The one legitimate REVOKE statement whose text contains the literal word
-- GRANT (as part of the "GRANT OPTION FOR" clause) -- must still pass
-- unconditionally under the now-unanchored rule 1: a statement that starts
-- with REVOKE is REVOKE-shaped regardless of what appears later in it.
BEGIN;

REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.f() FROM anon;

COMMIT;
