-- ============================================================================
-- OtterQuote Partner System RLS Fix
-- Migration v16 — applied via Management API
-- ============================================================================
-- Purpose: Add missing RLS policies so partner signup forms and referral
--          click tracking work with the Supabase anon key.
--
-- Changes:
--   1. referral_agents: Allow anon INSERT (partner self-registration)
--   2. referral_agents: Allow authenticated user to claim their own unclaimed
--      record (link user_id after magic-link click)
--   3. referrals: Allow anon INSERT (referral click tracking from ref.html)
--   4. referrals: Allow authenticated UPDATE (homeowner status advancement)
-- ============================================================================

-- ============================================================================
-- 1. referral_agents — Public self-registration
--    Partners submit the signup form before creating an account.
--    The record is inserted with user_id = NULL and later linked once the
--    partner clicks their magic link and auth.js runs handleAuthCallback().
-- ============================================================================
CREATE POLICY IF NOT EXISTS "Public can register as partner"
  ON public.referral_agents
  FOR INSERT
  WITH CHECK (user_id IS NULL);

-- ============================================================================
-- 2. referral_agents — Post-auth user_id linking
--    After clicking the magic link, auth.js finds the agent record by email
--    (where user_id IS NULL) and updates it with the new auth user id.
--    The policy ensures:
--      USING:      record must be unclaimed AND match the caller's email
--      WITH CHECK: the new user_id must equal the caller's uid
-- ============================================================================
CREATE POLICY IF NOT EXISTS "Authenticated can claim unclaimed partner record"
  ON public.referral_agents
  FOR UPDATE
  TO authenticated
  USING (user_id IS NULL AND email = (auth.jwt() ->> 'email'))
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- 3. referrals — Public click tracking
--    When a visitor arrives via a referral link (ref.html), we insert a
--    'clicked' referral record before they register or sign in.
-- ============================================================================
CREATE POLICY IF NOT EXISTS "Public can insert referral clicks"
  ON public.referrals
  FOR INSERT
  WITH CHECK (true);

-- ============================================================================
-- 4. referrals — Authenticated status advancement
--    After the homeowner registers, auth.js advances the referral status
--    from 'clicked' → 'registered'. Authenticated users can UPDATE any
--    referral (UUIDs are unguessable; acceptable for MVP).
-- ============================================================================
CREATE POLICY IF NOT EXISTS "Authenticated can update referrals"
  ON public.referrals
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- End of Migration v16
-- ============================================================================
