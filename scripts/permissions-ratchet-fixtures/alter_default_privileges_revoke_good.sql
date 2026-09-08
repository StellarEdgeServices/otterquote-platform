-- RATCHET-FIXTURE: EXPECT=PASS
-- Mirror image of alter_default_privileges_grant_anon_bad.sql: the REVOKE
-- direction of the same ALTER DEFAULT PRIVILEGES phrasing must keep passing
-- unconditionally -- rule 1's unanchored GRANT scan must not be so broad
-- that it starts flagging REVOKE-shaped ALTER DEFAULT PRIVILEGES statements
-- just because they don't start with the literal word REVOKE.
BEGIN;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

COMMIT;
