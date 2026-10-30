-- TRUNCATE-CHECK-FIXTURE: EXPECT=FAIL
-- GRANT ... TO PUBLIC reaches anon and authenticated too.
CREATE TABLE public.gh3256_d (id int);
REVOKE TRUNCATE ON public.gh3256_d FROM anon, authenticated;
GRANT TRUNCATE ON public.gh3256_d TO PUBLIC;
