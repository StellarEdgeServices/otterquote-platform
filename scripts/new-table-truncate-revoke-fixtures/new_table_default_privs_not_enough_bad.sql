-- TRUNCATE-CHECK-FIXTURE: EXPECT=FAIL
-- ALTER DEFAULT PRIVILEGES does not count: it does not cover tables created as supabase_admin, nor this one if run in another role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
CREATE TABLE public.gh3256_i (id int);
