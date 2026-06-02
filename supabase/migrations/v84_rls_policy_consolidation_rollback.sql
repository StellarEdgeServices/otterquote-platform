-- Rollback: v84_rls_policy_consolidation_rollback.sql
-- Reverts: v84_rls_policy_consolidation.sql
-- Author: migration-author (Cowork reconciliation 2026-06-02)
-- Date: 2026-06-02
-- WARNING: Only run if v84_rls_policy_consolidation needs to be undone in production.
--          This restores the pre-(select auth.uid()) pattern and recreates the 5
--          duplicate policies that were intentionally dropped in Phase 1A.
--          Restoring duplicates is safe — they were redundant, not functional.

BEGIN;

-- ============================================================
-- PHASE 1B REVERSAL: Restore direct auth.uid() pattern
-- (Reverts (select auth.uid()) back to auth.uid() direct call)
-- ============================================================

-- activity_log
DROP POLICY IF EXISTS "Users can view own activity" ON public.activity_log;
CREATE POLICY "Users can view own activity" ON public.activity_log
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own activity" ON public.activity_log;
CREATE POLICY "Users can insert own activity" ON public.activity_log
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- adjuster_email_requests
DROP POLICY IF EXISTS "aer_user_read" ON public.adjuster_email_requests;
CREATE POLICY "aer_user_read" ON public.adjuster_email_requests
  FOR SELECT TO authenticated
  USING (claim_id IN (
    SELECT id FROM public.claims WHERE user_id = auth.uid()
  ));

-- claims
DROP POLICY IF EXISTS "Contractors can view biddable claims" ON public.claims;
CREATE POLICY "Contractors can view biddable claims" ON public.claims
  FOR SELECT
  USING (
    (ready_for_bids = true)
    AND (status = ANY (ARRAY['active'::text, 'bidding'::text, 'pending'::text]))
    AND (auth.uid() IN (
      SELECT user_id FROM public.contractors WHERE status = 'active'::text
    ))
  );

DROP POLICY IF EXISTS "Contractors can view claims for their quotes" ON public.claims;
CREATE POLICY "Contractors can view claims for their quotes" ON public.claims
  FOR SELECT TO authenticated
  USING (id IN (SELECT get_contractor_quote_claim_ids(auth.uid())));

DROP POLICY IF EXISTS "Users can view own claims" ON public.claims;
CREATE POLICY "Users can view own claims" ON public.claims
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own claims" ON public.claims;
CREATE POLICY "Users can insert own claims" ON public.claims
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own claims" ON public.claims;
CREATE POLICY "Users can update own claims" ON public.claims
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own claims" ON public.claims;
CREATE POLICY "Users can delete own claims" ON public.claims
  FOR DELETE
  USING (user_id = auth.uid());

-- contractor_cert_verifications
DROP POLICY IF EXISTS "ccv contractor read own" ON public.contractor_cert_verifications;
CREATE POLICY "ccv contractor read own" ON public.contractor_cert_verifications
  FOR SELECT TO authenticated
  USING (contractor_id = auth.uid());

DROP POLICY IF EXISTS "ccv contractor insert pending own" ON public.contractor_cert_verifications;
CREATE POLICY "ccv contractor insert pending own" ON public.contractor_cert_verifications
  FOR INSERT
  WITH CHECK (
    (contractor_id = auth.uid())
    AND (status = 'pending'::text)
    AND (source = 'admin_upload'::text)
  );

-- contractor_certifications
DROP POLICY IF EXISTS "Contractors can view own certifications" ON public.contractor_certifications;
CREATE POLICY "Contractors can view own certifications" ON public.contractor_certifications
  FOR SELECT
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Contractors can insert own certifications" ON public.contractor_certifications;
CREATE POLICY "Contractors can insert own certifications" ON public.contractor_certifications
  FOR INSERT
  WITH CHECK (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Contractors can delete own certifications" ON public.contractor_certifications;
CREATE POLICY "Contractors can delete own certifications" ON public.contractor_certifications
  FOR DELETE
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

-- contractor_licenses
DROP POLICY IF EXISTS "Contractors can view own licenses" ON public.contractor_licenses;
CREATE POLICY "Contractors can view own licenses" ON public.contractor_licenses
  FOR SELECT
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Contractors can insert own licenses" ON public.contractor_licenses;
CREATE POLICY "Contractors can insert own licenses" ON public.contractor_licenses
  FOR INSERT
  WITH CHECK (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Contractors can update own licenses" ON public.contractor_licenses;
CREATE POLICY "Contractors can update own licenses" ON public.contractor_licenses
  FOR UPDATE
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

-- contractor_payment_methods
DROP POLICY IF EXISTS "Contractors can view own payment methods" ON public.contractor_payment_methods;
CREATE POLICY "Contractors can view own payment methods" ON public.contractor_payment_methods
  FOR SELECT
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Contractors can insert own payment methods" ON public.contractor_payment_methods;
CREATE POLICY "Contractors can insert own payment methods" ON public.contractor_payment_methods
  FOR INSERT
  WITH CHECK (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Contractors can update own payment methods" ON public.contractor_payment_methods;
CREATE POLICY "Contractors can update own payment methods" ON public.contractor_payment_methods
  FOR UPDATE
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Contractors can delete own payment methods" ON public.contractor_payment_methods;
CREATE POLICY "Contractors can delete own payment methods" ON public.contractor_payment_methods
  FOR DELETE
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

-- contractor_templates
DROP POLICY IF EXISTS "contractor_templates_admin" ON public.contractor_templates;
CREATE POLICY "contractor_templates_admin" ON public.contractor_templates
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.contractors
    WHERE user_id = auth.uid() AND template_review_role = 'admin'::text
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.contractors
    WHERE user_id = auth.uid() AND template_review_role = 'admin'::text
  ));

DROP POLICY IF EXISTS "contractor_templates_self" ON public.contractor_templates;
CREATE POLICY "contractor_templates_self" ON public.contractor_templates
  FOR ALL
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ))
  WITH CHECK (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

-- contractors
DROP POLICY IF EXISTS "Contractors can insert own profile" ON public.contractors;
CREATE POLICY "Contractors can insert own profile" ON public.contractors
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Contractors can update own profile" ON public.contractors;
CREATE POLICY "Contractors can update own profile" ON public.contractors
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- expansion_waitlist
DROP POLICY IF EXISTS "Users read own waitlist entry" ON public.expansion_waitlist;
CREATE POLICY "Users read own waitlist entry" ON public.expansion_waitlist
  FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users insert own waitlist entry" ON public.expansion_waitlist;
CREATE POLICY "Users insert own waitlist entry" ON public.expansion_waitlist
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users update own waitlist entry" ON public.expansion_waitlist;
CREATE POLICY "Users update own waitlist entry" ON public.expansion_waitlist
  FOR UPDATE
  USING (user_id = auth.uid());

-- fee_acceptances
DROP POLICY IF EXISTS "Contractors can read own fee acceptances" ON public.fee_acceptances;
CREATE POLICY "Contractors can read own fee acceptances" ON public.fee_acceptances
  FOR SELECT
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Contractors can insert own fee acceptances" ON public.fee_acceptances;
CREATE POLICY "Contractors can insert own fee acceptances" ON public.fee_acceptances
  FOR INSERT
  WITH CHECK (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

-- home_profiles
DROP POLICY IF EXISTS "Homeowners can view own home profile" ON public.home_profiles;
CREATE POLICY "Homeowners can view own home profile" ON public.home_profiles
  FOR SELECT
  USING (homeowner_user_id = auth.uid());

DROP POLICY IF EXISTS "Homeowners can create own home profile" ON public.home_profiles;
CREATE POLICY "Homeowners can create own home profile" ON public.home_profiles
  FOR INSERT
  WITH CHECK (homeowner_user_id = auth.uid());

DROP POLICY IF EXISTS "Homeowners can update own home profile" ON public.home_profiles;
CREATE POLICY "Homeowners can update own home profile" ON public.home_profiles
  FOR UPDATE
  USING (homeowner_user_id = auth.uid());

-- hover_orders
DROP POLICY IF EXISTS "hover_user_read" ON public.hover_orders;
CREATE POLICY "hover_user_read" ON public.hover_orders
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- messages
DROP POLICY IF EXISTS "contractor_messages" ON public.messages;
CREATE POLICY "contractor_messages" ON public.messages
  FOR ALL
  USING (claim_id IN (
    SELECT quotes.claim_id FROM public.quotes
    WHERE quotes.contractor_id = (
      SELECT id FROM public.contractors WHERE user_id = auth.uid()
    )
  ))
  WITH CHECK (
    (sender_id = auth.uid())
    AND (sender_role = 'contractor'::text)
    AND (claim_id IN (
      SELECT quotes.claim_id FROM public.quotes
      WHERE quotes.contractor_id = (
        SELECT id FROM public.contractors WHERE user_id = auth.uid()
      )
    ))
  );

DROP POLICY IF EXISTS "homeowner_messages" ON public.messages;
CREATE POLICY "homeowner_messages" ON public.messages
  FOR ALL
  USING (claim_id IN (
    SELECT id FROM public.claims WHERE user_id = auth.uid()
  ))
  WITH CHECK (
    (sender_id = auth.uid())
    AND (sender_role = 'homeowner'::text)
    AND (claim_id IN (
      SELECT id FROM public.claims WHERE user_id = auth.uid()
    ))
  );

-- notifications
DROP POLICY IF EXISTS "notifications_user_read" ON public.notifications;
CREATE POLICY "notifications_user_read" ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
CREATE POLICY "Users can update own notifications" ON public.notifications
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- payment_failures
DROP POLICY IF EXISTS "contractor_select_own_payment_failures" ON public.payment_failures;
CREATE POLICY "contractor_select_own_payment_failures" ON public.payment_failures
  FOR SELECT
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "contractor_update_own_payment_failures" ON public.payment_failures;
CREATE POLICY "contractor_update_own_payment_failures" ON public.payment_failures
  FOR UPDATE
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

-- payout_approvals
DROP POLICY IF EXISTS "Partners read own payout_approvals" ON public.payout_approvals;
CREATE POLICY "Partners read own payout_approvals" ON public.payout_approvals
  FOR SELECT
  USING (partner_id IN (
    SELECT id FROM public.referral_agents WHERE user_id = auth.uid()
  ));

-- profiles
DROP POLICY IF EXISTS "profiles_user_read" ON public.profiles;
CREATE POLICY "profiles_user_read" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "profiles_user_insert" ON public.profiles;
CREATE POLICY "profiles_user_insert" ON public.profiles
  FOR INSERT
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "profiles_user_update" ON public.profiles;
CREATE POLICY "profiles_user_update" ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own profile" ON public.profiles;
CREATE POLICY "Users can delete own profile" ON public.profiles
  FOR DELETE
  USING (id = auth.uid());

-- quotes
DROP POLICY IF EXISTS "Contractors can insert quotes" ON public.quotes;
CREATE POLICY "Contractors can insert quotes" ON public.quotes
  FOR INSERT
  WITH CHECK (
    (contractor_id IN (
      SELECT id FROM public.contractors WHERE user_id = auth.uid()
    ))
    AND contractor_can_bid(contractor_id)
  );

DROP POLICY IF EXISTS "Contractors can read own quotes" ON public.quotes;
CREATE POLICY "Contractors can read own quotes" ON public.quotes
  FOR SELECT TO authenticated
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Homeowners can read quotes for their claims" ON public.quotes;
CREATE POLICY "Homeowners can read quotes for their claims" ON public.quotes
  FOR SELECT TO authenticated
  USING (claim_id IN (
    SELECT id FROM public.claims WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Contractors can update own quotes" ON public.quotes;
CREATE POLICY "Contractors can update own quotes" ON public.quotes
  FOR UPDATE TO authenticated
  USING (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ))
  WITH CHECK (contractor_id IN (
    SELECT id FROM public.contractors WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Homeowners can update quotes for their claims" ON public.quotes;
CREATE POLICY "Homeowners can update quotes for their claims" ON public.quotes
  FOR UPDATE TO authenticated
  USING (claim_id IN (
    SELECT id FROM public.claims WHERE user_id = auth.uid()
  ))
  WITH CHECK (claim_id IN (
    SELECT id FROM public.claims WHERE user_id = auth.uid()
  ));

-- referral_agents
DROP POLICY IF EXISTS "Agents can manage own profile" ON public.referral_agents;
CREATE POLICY "Agents can manage own profile" ON public.referral_agents
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Authenticated can claim unclaimed partner record" ON public.referral_agents;
CREATE POLICY "Authenticated can claim unclaimed partner record" ON public.referral_agents
  FOR UPDATE
  USING ((user_id IS NULL) AND (email = (auth.jwt() ->> 'email'::text)))
  WITH CHECK (user_id = auth.uid());

-- referrals
DROP POLICY IF EXISTS "Agents can read own referrals" ON public.referrals;
CREATE POLICY "Agents can read own referrals" ON public.referrals
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.referral_agents
    WHERE id = referrals.referral_agent_id
      AND user_id = auth.uid()
  ));

-- warranty_manifest_drift
DROP POLICY IF EXISTS "Admin read" ON public.warranty_manifest_drift;
CREATE POLICY "Admin read" ON public.warranty_manifest_drift
  FOR SELECT TO authenticated
  USING (
    (EXISTS (
      SELECT 1 FROM public.contractors c
      WHERE c.user_id = auth.uid()
        AND c.template_review_role = 'admin'::text
    ))
    OR (
      (SELECT email FROM auth.users WHERE id = auth.uid())::text
        = 'dustinstohler1@gmail.com'::text
    )
  );

-- ============================================================
-- PHASE 1A RESTORATION: Recreate the 5 duplicate policies
-- that were intentionally dropped in v84. These were redundant
-- but some clients may have depended on them by name.
-- ============================================================

-- 1. "Users can view own notifications" (duplicate of notifications_user_read)
CREATE POLICY "Users can view own notifications" ON public.notifications
  FOR SELECT
  USING (user_id = auth.uid());

-- 2. "Contractors can update own record" (duplicate of "Contractors can update own profile")
CREATE POLICY "Contractors can update own record" ON public.contractors
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 3. "Contractors can view own record" (duplicate read policy)
CREATE POLICY "Contractors can view own record" ON public.contractors
  FOR SELECT
  USING (user_id = auth.uid());

-- 4. "admin_select_contractors" (admin read policy)
CREATE POLICY "admin_select_contractors" ON public.contractors
  FOR SELECT
  USING ((auth.jwt() ->> 'email'::text) = 'dustinstohler1@gmail.com'::text);

-- 5. "Contractors can insert own quotes" (duplicate of "Contractors can insert quotes")
CREATE POLICY "Contractors can insert own quotes" ON public.quotes
  FOR INSERT
  WITH CHECK (
    contractor_id IN (
      SELECT id FROM public.contractors WHERE user_id = auth.uid()
    )
  );

COMMIT;
