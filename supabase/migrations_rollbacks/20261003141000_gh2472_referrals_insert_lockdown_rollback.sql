-- Rollback for 20261003141000_gh2472_referrals_insert_lockdown.sql (gh-2472).
-- WARNING: this RE-OPENS the #2472 hole (any client can insert a referral at
-- any status for any agent). Run it only if a legitimate client insert path
-- turns out to depend on the direct grant, and re-close it as soon as that
-- path is moved to track_referral_click().
-- Restores exactly the pre-fix state read from production 2026-10-03:
-- policy "Public can insert referral clicks" FOR INSERT TO public WITH CHECK
-- (true), and INSERT held by anon and authenticated.
BEGIN;
DROP POLICY IF EXISTS "Public can insert referral clicks" ON public.referrals;
CREATE POLICY "Public can insert referral clicks" ON public.referrals AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);
GRANT INSERT ON TABLE public.referrals TO anon, authenticated;
COMMIT;
