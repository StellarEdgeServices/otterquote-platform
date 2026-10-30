-- STATUS (as of 2026-10-30): NOT APPLIED -- DRAFT
-- FILE ROLE: rollback file of set gh3212_freeze_claims_is_test
-- EVIDENCE: the forward file adds only the trigger and function below; before it, no claims trigger or function named claims_freeze_is_test existed (read-only 2026-10-30, project yeszghaspzwwstvsrioa).
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: drops the trigger and its function. Restores the pre-gh-3212 state (client roles can UPDATE claims.is_test). Changes no row.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS claims_freeze_is_test ON public.claims;
DROP FUNCTION IF EXISTS public.claims_freeze_is_test();

COMMIT;
