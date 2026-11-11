-- TRUNCATE-CHECK-FIXTURE: EXPECT=FAIL
-- negative control: a new public table inherits production's default ACL (arwdDxtm to anon/authenticated) and nothing revokes TRUNCATE.
BEGIN;
CREATE TABLE IF NOT EXISTS public.gh3256_widgets (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gh3256_widgets TO service_role;
COMMIT;
