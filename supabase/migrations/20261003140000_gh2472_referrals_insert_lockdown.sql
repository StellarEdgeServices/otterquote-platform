-- Migration: 20261003140000_gh2472_referrals_insert_lockdown
-- GitHub: #2472 (sideways finding from the #2345 close-review). Referral/commission path (D-301).
-- Tier: 3B (DROP POLICY + REVOKE on a table: RLS/grant change). Protective only (R-134).
-- NOT APPLIED by the authoring session. R-097 notice applies.
-- Rollback: supabase/migrations_rollbacks/20261003140000_gh2472_referrals_insert_lockdown_rollback.sql
-- Pre-flight: 20261003140000_gh2472_referrals_insert_lockdown_pre-flight.md
--
-- Problem: public.referrals carries the policy "Public can insert referral
-- clicks" (FOR INSERT TO public WITH CHECK (true)) and anon/authenticated
-- hold the INSERT privilege. A browser client can therefore insert a row that
-- starts at any status (registered .. commission_paid) for any
-- referral_agent_id, skipping track_referral_click() and the 30-day
-- attribution check #2345 put on the advance functions.
--
-- Insert-path map (repo, 2026-10-03):
--   * public.track_referral_click(text,text,text,text,text) -- SECURITY
--     DEFINER (v95, gh1302). Inserts status='clicked' only. Called by ref.html,
--     ref-re.html, ref-inspector.html, ref-insurance.html. It runs as its
--     owner (postgres, which also owns public.referrals), so it needs neither
--     this policy nor the anon/authenticated table grant.
--   * Edge Functions: approve-payout, get-payout-completion-status,
--     mark-job-complete, mark-payout-paid, send-partner-status-email,
--     get-business-lines-dashboard read/update referrals with the service
--     role; none inserts. Service role is unaffected by this file.
--   * Browser code (refer-a-friend.html, partner-dashboard.html,
--     react-app/app/refer/page.tsx, react-app/app/partner/dashboard/page.tsx):
--     SELECT only. No browser path inserts or upserts referrals directly.
--
-- So the narrower safe option is to remove the client INSERT surface
-- entirely: drop the permissive INSERT policy and revoke the INSERT grant.
-- "Service role full access" (USING/WITH CHECK auth.role() = 'service_role')
-- and "Agents can read own referrals" (SELECT) are left untouched.
--
-- Idempotent: DROP POLICY IF EXISTS; REVOKE of a privilege not held is a
-- no-op.

BEGIN;

DROP POLICY IF EXISTS "Public can insert referral clicks" ON public.referrals;

REVOKE INSERT ON TABLE public.referrals FROM PUBLIC, anon, authenticated;

COMMIT;
