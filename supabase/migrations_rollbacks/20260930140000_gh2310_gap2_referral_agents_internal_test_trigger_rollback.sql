-- Rollback for 20260930140000_gh2310_gap2_referral_agents_internal_test_trigger.
-- Drops the trigger, then its function, then the helper. No data change: rows already flagged is_test=true
-- by the trigger stay true (revert by exact id if ever needed; none are known to need it).
BEGIN;
DROP TRIGGER IF EXISTS referral_agents_set_is_test_internal ON public.referral_agents;
DROP FUNCTION IF EXISTS public.referral_agents_flag_internal_test();
DROP FUNCTION IF EXISTS public.is_internal_test_email(text);
COMMIT;
