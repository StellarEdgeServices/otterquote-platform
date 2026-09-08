-- RATCHET-FIXTURE: EXPECT=PASS
-- Positive control for the ||-concatenation merge: the role half of the
-- concatenation resolves to the ALLOWLISTED service_role, not just any
-- disallowed role -- proves the merge logic actually resolves a role and
-- checks it against the allowlist, rather than fail-closing on every
-- concatenated GRANT unconditionally.
BEGIN;

EXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO ' || 'service_role';

COMMIT;
