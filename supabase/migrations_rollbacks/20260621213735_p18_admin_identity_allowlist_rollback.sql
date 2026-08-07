-- ROLLBACK for 20260621213735_p18_admin_identity_allowlist.sql
-- Restores the exact pre-migration policy state. NOTE: this re-introduces the
-- warranty_manifest_drift auth.users permission-denied bug by design (faithful revert).

-- 6) Drop the new referral_agents admin UPDATE policy.
DROP POLICY IF EXISTS "Admin can update referral agents" ON public.referral_agents;

-- 5) referral_agents "Admin can read all referral agents" -> restore single email.
DROP POLICY IF EXISTS "Admin can read all referral agents" ON public.referral_agents;
CREATE POLICY "Admin can read all referral agents" ON public.referral_agents
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'email') = 'dustinstohler1@gmail.com');

-- 4) platform_fee_config -> restore single email.
DROP POLICY IF EXISTS "Admin can manage fee config" ON public.platform_fee_config;
CREATE POLICY "Admin can manage fee config" ON public.platform_fee_config
  FOR ALL TO public
  USING ((auth.jwt() ->> 'email') = 'dustinstohler1@gmail.com')
  WITH CHECK ((auth.jwt() ->> 'email') = 'dustinstohler1@gmail.com');

-- 3) payout_approvals -> restore single email.
DROP POLICY IF EXISTS "Admin full access payout_approvals" ON public.payout_approvals;
CREATE POLICY "Admin full access payout_approvals" ON public.payout_approvals
  FOR ALL TO public
  USING ((auth.jwt() ->> 'email') = 'dustinstohler1@gmail.com');

-- 2) warranty_manifest_drift "Admin read" -> restore prior (buggy) auth.users subquery form.
DROP POLICY IF EXISTS "Admin read" ON public.warranty_manifest_drift;
CREATE POLICY "Admin read" ON public.warranty_manifest_drift
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.contractors c
            WHERE c.user_id = (SELECT auth.uid())
              AND c.template_review_role = 'admin')
    OR ((SELECT users.email FROM auth.users WHERE users.id = (SELECT auth.uid()))::text
         = 'dustinstohler1@gmail.com')
  );

-- 1) Drop the helper.
DROP FUNCTION IF EXISTS public.is_admin_email();
