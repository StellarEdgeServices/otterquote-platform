-- ============================================================================
-- Migration v90 — contractors: admin email SELECT policy (pre-req for DROP)
-- Created: 2026-06-13
-- Status: APPLIED to prod 2026-06-13 (migration version 20260613200922). Repo replay file: supabase/migrations/20260613200922_v90_contractors_admin_select_policy.sql
-- ============================================================================
-- Purpose:
--   Adds an explicit admin SELECT policy on public.contractors keyed on the
--   owner email address (auth.jwt()->>'email' = 'dustinstohler1@gmail.com').
--
--   This policy is a REQUIRED PREREQUISITE before dropping the broad
--   "Authenticated users can read contractors" USING(true) policy (see v89
--   deferred DROP comment). Once USING(true) drops, admin-facing pages
--   (admin-contractors.html, admin-cert-verifications.html, admin-cpa.html,
--   admin-incomplete-profiles.html, admin-template-review.html) need this
--   policy to preserve full base-table read access.
--
-- Context:
--   v89 creates the contractors_public view and a "Contractors can read own
--   record" owner policy. It documents the existing admin_select_contractors
--   policy and USING(true). This migration makes the admin access explicit and
--   email-scoped so the USING(true) drop is safe.
--
-- Why email-based (not role-based)?
--   All admin pages authenticate via Supabase's authenticated role; there is
--   no separate Supabase database role for admins. The JWT email claim is the
--   correct discriminator. See js/auth.js and admin-*.html for the pattern.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Admin SELECT policy — full base-table access for owner email
-- ============================================================================
CREATE POLICY "Admin can read all contractors"
  ON public.contractors
  FOR SELECT
  TO authenticated
  USING (auth.jwt()->>'email' = 'dustinstohler1@gmail.com');

-- The companion DROP of "Authenticated users can read contractors" is realized as migration v90b
-- (supabase/migrations/20260613201225_v90b_drop_contractors_authenticated_read_using_true.sql) — applied to prod 2026-06-13.

COMMIT;
