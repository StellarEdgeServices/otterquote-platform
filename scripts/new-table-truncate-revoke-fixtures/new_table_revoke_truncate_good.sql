-- TRUNCATE-CHECK-FIXTURE: EXPECT=PASS
BEGIN;
CREATE TABLE IF NOT EXISTS public.gh3256_widgets (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
REVOKE TRUNCATE ON public.gh3256_widgets FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gh3256_widgets TO service_role;
COMMIT;
