-- TRUNCATE-CHECK-FIXTURE: EXPECT=FAIL
-- a later GRANT ALL hands TRUNCATE back to authenticated.
CREATE TABLE public.gh3256_c (id int);
REVOKE TRUNCATE ON public.gh3256_c FROM anon, authenticated;
GRANT ALL ON public.gh3256_c TO authenticated;
