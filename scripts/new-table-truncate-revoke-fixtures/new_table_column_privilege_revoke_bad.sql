-- TRUNCATE-CHECK-FIXTURE: EXPECT=FAIL
-- a column-level REVOKE (SELECT (col)) is never TRUNCATE.
CREATE TABLE public.gh3256_g (id int, secret text);
REVOKE SELECT (secret) ON public.gh3256_g FROM anon, authenticated;
