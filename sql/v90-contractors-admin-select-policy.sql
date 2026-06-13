-- ============================================================================
-- Migration v90 — contractors: admin email SELECT policy (pre-req for DROP)
-- Created: 2026-06-13
-- Status: FILE ONLY — NOT YET APPLIED. Coordinator applies after:
--         (a) bids.html Stripe read moved to service-role EF
--         (b) contract-signing.html contract_templates read moved to service-role EF
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

-- ============================================================================
-- 2. Deferred DROP — run ONLY after bids.html + contract-signing.html EF migration
--
-- DROP POLICY "Authenticated users can read contractors" ON public.contractors;
--
-- Verification checklist before running the DROP:
--   [ ] bids.html:1911 Stripe check moved to service-role EF
--   [ ] contract-signing.html:1218 contract_templates/contract_pdf_url moved to EF
--   [ ] All homeowner-facing reads confirmed on contractors_public
--   [ ] Admin pages verified to work under this new policy
--   [ ] Contractor own-session reads verified under "Contractors can read own record"
-- ============================================================================

COMMIT;
