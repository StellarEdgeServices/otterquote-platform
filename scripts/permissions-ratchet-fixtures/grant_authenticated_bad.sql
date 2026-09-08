-- RATCHET-FIXTURE: EXPECT=FAIL
-- Table-level DML grant to authenticated -- rule 1 covers tables/sequences/
-- schemas, not just FUNCTION.
BEGIN;

GRANT SELECT, INSERT ON TABLE public.internal_audit_log TO authenticated;

COMMIT;
