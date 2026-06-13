-- ============================================================================
-- Rollback v88 — Remove public view, restore broad policy
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS public.referral_agents_public;

DROP POLICY IF EXISTS "Admin can read all referral agents" ON public.referral_agents;
DROP POLICY IF EXISTS "Partners can read their recruits" ON public.referral_agents;
DROP FUNCTION IF EXISTS public.get_own_referral_agent_id();

-- Restore the original v7 policy
CREATE POLICY "Public can read active agents"
  ON public.referral_agents
  FOR SELECT
  USING (status = 'active');

COMMIT;
