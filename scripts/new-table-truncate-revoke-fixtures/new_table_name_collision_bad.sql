-- TRUNCATE-CHECK-FIXTURE: EXPECT=FAIL
-- the REVOKE names a different table whose name contains this one.
CREATE TABLE public.gh3256_f (id int);
REVOKE TRUNCATE ON public.gh3256_f_archive FROM anon, authenticated;
