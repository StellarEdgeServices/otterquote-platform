-- Rollback for: supabase/migrations/20261003130000_gh2421_out_of_state_claim_alert.sql
-- GitHub: #2421 (D-344). Tier 3B.
-- Effect: no more out-of-state alerts. No claim data is touched except dropping the
-- new dedupe column (it exists only for this alert). To stop the alerts while keeping the
-- stamps (so a later re-apply does not re-alert already-alerted claims), run only steps 1-2
-- and skip step 3.
-- The Edge Function can stay deployed: without the trigger nothing posts out_of_state_claim.

BEGIN;

-- 1. Stop the alerts
DROP TRIGGER IF EXISTS trg_notify_admin_out_of_state_claim ON public.claims;
DROP FUNCTION IF EXISTS public.notify_admin_out_of_state_claim();

-- 2. Remove the suppression guard
DROP TRIGGER IF EXISTS trg_claims_guard_out_of_state_alerted_at ON public.claims;
DROP FUNCTION IF EXISTS public.claims_guard_out_of_state_alerted_at();

-- 3. Drop the dedupe column (optional, see header)
ALTER TABLE public.claims DROP COLUMN IF EXISTS out_of_state_alerted_at;

COMMIT;
