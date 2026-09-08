-- RATCHET-FIXTURE: EXPECT=FAIL
-- Same evasion class as alter_default_privileges_grant_anon_bad.sql (PR
-- #1836 comment 5578401122 probe (f)), the exact fixture text requested in
-- the follow-up work order: `FOR ROLE postgres` prefix, TABLES object type,
-- authenticated target role -- proving rule 1's unanchored scan is not
-- keyed to any one specific ALTER DEFAULT PRIVILEGES phrasing.
BEGIN;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;

COMMIT;
