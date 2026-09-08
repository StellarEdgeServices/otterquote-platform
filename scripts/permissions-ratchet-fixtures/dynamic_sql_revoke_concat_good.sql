-- RATCHET-FIXTURE: EXPECT=PASS
-- Negative control for the ||-concatenation merge: REVOKE, not GRANT, split
-- across two concatenated literals -- rule 4 only ever fires on GRANT, so
-- merging spans must not introduce a false positive on the REVOKE
-- direction of the same dynamic-SQL shape.
BEGIN;

EXECUTE 'REVOKE EXECUTE ON FUNCTION public.f() FROM ' || 'anon';

COMMIT;
