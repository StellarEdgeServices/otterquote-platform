-- Migration: gh1070_activity_log_grants_revoke
-- Author: Code lane sub-agent (automated), run-work orchestration
-- Date: 2026-08-21
-- Status: DRAFT ONLY — Tier 3B. NOT APPLIED. This session's standing rail
--         holds Tier 3B to the full R-097 24h notice-then-wait window even
--         though the change is arguably R-134 fast-path eligible (see the
--         R-097 notice on #1070 / #1206 for the explicit call-out). No
--         apply_migration was run against production to produce this file.
-- Rollback: gh1070_activity_log_grants_revoke_rollback.sql
-- Pre-flight: gh1070_activity_log_grants_revoke_pre-flight.md
-- GitHub: #1070 (reopened round-4 finding on #1028; sibling defect to #1041)
--
-- Summary: public.activity_log currently grants anon and authenticated the
-- full 7-privilege set (DELETE, INSERT, REFERENCES, SELECT, TRIGGER,
-- TRUNCATE, UPDATE), live-verified via information_schema.role_table_grants
-- this session. Its only two RLS policies are:
--   "Users can insert own activity"  INSERT  with_check: (auth.uid() = user_id)
--   "Users can view own activity"    SELECT  qual:       (auth.uid() = user_id)
-- anon can never satisfy either predicate (auth.uid() is NULL for an
-- unauthenticated caller) — anon's grant does nothing productive today and
-- is revoked to nothing. authenticated needs SELECT and INSERT only;
-- DELETE, TRIGGER, TRUNCATE, REFERENCES are not defensible for either role
-- (no policy anywhere on this table authorizes them).
--
-- AC3 decision (see pre-flight for full reasoning): the INSERT policy's
-- with_check is tightened to require is_test = false, closing the forgery
-- path an authenticated direct-client insert could otherwise use to plant
-- a permanently-production-flagged row bypassing the 14 Edge Functions
-- #1028 fixed to stamp is_test correctly. Direct-client INSERT itself is
-- NOT revoked (option b was rejected) because four live call sites already
-- write to this table via the browser's authenticated client
-- (react-app/app/contractor/dashboard/page.tsx, react-app/app/contractor/
-- bid/[claimId]/bid-form.tsx, contractor-bid-form.html,
-- contractor-dashboard.html — cpa_accepted and bid_updated activity-feed
-- entries) and none of them ever set is_test, so tightening with_check to
-- require is_test = false does not break any of them while eliminating the
-- forgery risk entirely: an authenticated direct insert can no longer set
-- is_test = true under any circumstance. Server-side writes (the 14 Edge
-- Functions) are unaffected either way — they all authenticate as
-- service_role, which bypasses RLS and table grants entirely, so this
-- migration touches only the browser-facing write path.

BEGIN;

-- anon: no policy on this table can ever be satisfied by an unauthenticated
-- caller (auth.uid() IS NULL). Revoke everything.
REVOKE DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON public.activity_log FROM anon;

-- authenticated: keep only what the two existing policies actually gate.
-- DELETE/TRIGGER/TRUNCATE/REFERENCES/UPDATE have no supporting policy at
-- all on this table for any role.
REVOKE DELETE, REFERENCES, TRIGGER, TRUNCATE, UPDATE
  ON public.activity_log FROM authenticated;
-- SELECT and INSERT intentionally retained for authenticated (policy-backed,
-- and INSERT is a live write path — see AC3 reasoning above).

-- AC3: close the is_test forgery path on the retained direct-client INSERT
-- without touching the ownership predicate the four live call sites depend
-- on (auth.uid() = user_id). A direct insert can no longer set is_test to
-- anything but false; the 14 service-role Edge Functions are unaffected
-- (service_role bypasses RLS and is not subject to this policy at all).
ALTER POLICY "Users can insert own activity" ON public.activity_log
  WITH CHECK (((SELECT auth.uid()) = user_id) AND (is_test = false));

COMMIT;
