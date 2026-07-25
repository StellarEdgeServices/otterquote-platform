-- ============================================================================
-- ROLLBACK: v95-referral-attribution-rpc.sql (GitHub #571)
-- ============================================================================
-- Drops the four SECURITY DEFINER functions, the claims trigger, and the
-- rate_limit_config seed row added by v95. Grants are removed implicitly with
-- the functions (no pre-v95 grants existed on any of these names).
--
-- NOTE: rate_limits log rows written by track_referral_click are historical
-- telemetry and are intentionally left in place.
--
-- WARNING: after rollback, client RPC calls shipped with #571 will fail
-- (function not found). Roll back the client deploy alongside this file.
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_claims_advance_referral ON public.claims;

DROP FUNCTION IF EXISTS public.claims_advance_referral();

DROP FUNCTION IF EXISTS public.advance_referral_registered(uuid);

DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text);

DROP FUNCTION IF EXISTS public.track_referral_click(text, text, text, text, text);

DELETE FROM public.rate_limit_config
 WHERE function_name = 'track_referral_click';

COMMIT;
