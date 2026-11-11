-- TRUNCATE-CHECK-FIXTURE: EXPECT=FAIL
-- a schema-wide REVOKE before the CREATE cannot reach a table that does not exist yet.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
CREATE TABLE public.gh3256_a (id int);
