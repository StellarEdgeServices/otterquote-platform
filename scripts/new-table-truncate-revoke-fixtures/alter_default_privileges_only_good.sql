-- TRUNCATE-CHECK-FIXTURE: EXPECT=PASS
-- no new table: an ALTER DEFAULT PRIVILEGES statement is out of this gate's scope.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
