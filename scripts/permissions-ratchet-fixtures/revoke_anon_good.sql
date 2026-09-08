-- RATCHET-FIXTURE: EXPECT=PASS
-- REVOKE always passes, unconditionally -- this is the asymmetry gh-1767
-- exists to encode. Modeled directly on #1634's forward migration shape.
BEGIN;

REVOKE EXECUTE ON FUNCTION public.some_orphaned_trigger_fn() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.some_orphaned_trigger_fn() FROM anon;

COMMIT;
