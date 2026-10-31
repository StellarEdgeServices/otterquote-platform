-- TRUNCATE-CHECK-FIXTURE: EXPECT=FAIL
-- a partition is its own relation with its own ACL; the parent's REVOKE does not cover it.
CREATE TABLE public.gh3256_p (id int, k int) PARTITION BY LIST (k);
REVOKE TRUNCATE ON public.gh3256_p FROM anon, authenticated;
CREATE TABLE public.gh3256_p1 PARTITION OF public.gh3256_p FOR VALUES IN (1);
