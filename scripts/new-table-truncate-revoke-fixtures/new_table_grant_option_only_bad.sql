-- TRUNCATE-CHECK-FIXTURE: EXPECT=FAIL
-- REVOKE GRANT OPTION FOR leaves the privilege itself in place.
CREATE TABLE public.gh3256_e (id int);
REVOKE GRANT OPTION FOR TRUNCATE ON public.gh3256_e FROM anon, authenticated;
