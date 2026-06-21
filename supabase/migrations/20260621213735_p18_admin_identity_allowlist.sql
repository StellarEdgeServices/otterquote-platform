-- p18_admin_identity_allowlist  (D-211 Phase 18, Units 1a + 3)
-- Applied to prod via apply_migration on 2026-06-21 (version 20260621213735).
-- Tier-3 RLS. Reversible (see *_rollback.sql). CTO-reviewed; Dustin-approved (D-220).
-- ClickUp: 86e1xrwq2 (warranty-drift RLS) + 86e1xvj4f (admin-identity consolidation).

-- 1) Shared admin predicate = the react-app ADMIN_EMAILS allow-list.
CREATE OR REPLACE FUNCTION public.is_admin_email()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT (auth.jwt() ->> 'email') IN (
    'dustinstohler1@gmail.com',
    'dustin@otterquote.com'
  );
$$;

-- 2) warranty_manifest_drift "Admin read": drop the auth.users subquery (permission-denied),
--    keep the contractor reviewer branch, widen admin to the allow-list.
DROP POLICY IF EXISTS "Admin read" ON public.warranty_manifest_drift;
CREATE POLICY "Admin read" ON public.warranty_manifest_drift
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.contractors c
            WHERE c.user_id = (SELECT auth.uid())
              AND c.template_review_role = 'admin')
    OR public.is_admin_email()
  );

-- 3) payout_approvals "Admin full access" -> allow-list (USING-only, mirrors original).
DROP POLICY IF EXISTS "Admin full access payout_approvals" ON public.payout_approvals;
CREATE POLICY "Admin full access payout_approvals" ON public.payout_approvals
  FOR ALL TO public
  USING (public.is_admin_email());

-- 4) platform_fee_config "Admin can manage fee config" -> allow-list (USING + WITH CHECK).
DROP POLICY IF EXISTS "Admin can manage fee config" ON public.platform_fee_config;
CREATE POLICY "Admin can manage fee config" ON public.platform_fee_config
  FOR ALL TO public
  USING (public.is_admin_email())
  WITH CHECK (public.is_admin_email());

-- 5) referral_agents "Admin can read all referral agents" -> allow-list.
DROP POLICY IF EXISTS "Admin can read all referral agents" ON public.referral_agents;
CREATE POLICY "Admin can read all referral agents" ON public.referral_agents
  FOR SELECT TO authenticated
  USING (public.is_admin_email());

-- 6) NEW: referral_agents admin UPDATE -- so Verify-W9 / Unblock actually persist
--    (today there is no admin UPDATE policy -> silent 0-row no-op).
DROP POLICY IF EXISTS "Admin can update referral agents" ON public.referral_agents;
CREATE POLICY "Admin can update referral agents" ON public.referral_agents
  FOR UPDATE TO authenticated
  USING (public.is_admin_email())
  WITH CHECK (public.is_admin_email());
