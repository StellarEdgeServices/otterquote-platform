-- Rollback for v16-partner-rls.sql
-- Generated 2026-06-08 | Tier 3 deploy required (D-182)
-- Run ONLY after confirming the forward migration is what you're rolling back.
-- Verified 2026-06-08: all 4 policies exist in production before this rollback was written.

-- Drop RLS policies added by v16 (partner signup + referral click tracking)

DROP POLICY IF EXISTS "Public can register as partner"
  ON public.referral_agents;

DROP POLICY IF EXISTS "Authenticated can claim unclaimed partner record"
  ON public.referral_agents;

DROP POLICY IF EXISTS "Public can insert referral clicks"
  ON public.referrals;

DROP POLICY IF EXISTS "Authenticated can update referrals"
  ON public.referrals;
