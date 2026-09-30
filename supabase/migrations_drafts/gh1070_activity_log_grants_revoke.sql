-- STATUS (gh-1438, as of 2026-09-30T12:32Z): NOT APPLIED (this file's SQL). The anon revoke EFFECT is live via a different, shorter migration
-- FILE ROLE: forward file of set gh1070_activity_log_grants_revoke (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: anon has zero privileges on public.activity_log but the SQL that ran is 20260824183229_gh1070_revoke_anon_activity_log: comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); ledger version 20260824183229 is in the 199-row schema_migrations snapshot recorded in supabase/migrations-reconciliation-baseline.json (queried 2026-09-29T20:55Z; comments 5902170993, 5902404090)
-- REPO COPY: supabase/migrations/20260824183229_gh1070_revoke_anon_activity_log.sql -- DIFFERS in SQL statements (comment/whitespace-normalised compare, this session)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- >>> SUPERSEDED (2026-09-26, gh-1438 part 2, corrected) -- the anon-grant-
-- revoke EFFECT this file proposes IS live (anon has zero privileges on
-- public.activity_log, confirmed read-only this session), but this file's
-- own SQL is NOT what ran. The migration that actually ran under a #1070
-- name is supabase/migrations/20260824183229_gh1070_revoke_anon_activity_log.sql
-- -- a single bare REVOKE, structurally different from and much shorter
-- than this draft's broader, more heavily-annotated proposal (which also
-- tightens the INSERT policy's WITH CHECK, an effect that did NOT ship).
-- Do not represent this file as "the applied migration" -- it demonstrably
-- isn't. Kept here, unmodified below this banner, for history. NOTE
-- (self-correction, this commit): an earlier version of this banner+body
-- pushed to this branch (commit 2f706c4) had drifted from this exact text
-- (ASCII "--" substituted for this file's own em dash "—" in several
-- places) -- refetched via get_file_contents and rebuilt from that exact
-- text to fix it. <<<
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
