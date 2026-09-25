-- GRANT-CHECK-FIXTURE: EXPECT=PASS
-- Positive control: a migration that touches an EXISTING table only (no
-- CREATE TABLE at all) must never trip this detector -- it has nothing to
-- say about column/index changes.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_contractor_verified BOOLEAN DEFAULT false NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_contractor_verified
  ON public.profiles (is_contractor_verified)
  WHERE is_contractor_verified = true;

COMMIT;
