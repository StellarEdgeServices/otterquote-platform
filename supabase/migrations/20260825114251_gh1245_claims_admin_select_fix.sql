-- gh-1438 reconciliation part 3 (2026-09-27T13:34:45Z): renamed from 20260825114153_* to the REAL
-- applied version. Live ledger row: supabase_migrations.schema_migrations version=20260825114251
-- name=gh1245_claims_admin_select_fix (SELECT-only verified: normalized-statement md5 of this file's body
-- equals the ledger's recorded statements md5 for this version). Executable SQL body
-- byte-for-byte unchanged; only the filename's version prefix and this banner changed.
-- ============================================================================
-- ============================================================================
-- gh1245_claims_admin_select_fix
--
-- Corrects a bug in the immediately-prior migration
-- (20260825113728_gh1245_admin_measurements_rls.sql), caught by live
-- verification before closing gh-1245, not by inspection.
--
-- That migration added `claims_admin_update` — an UPDATE-only admin policy,
-- deliberately scoped narrow (no SELECT, no ALL) to keep the grant minimal.
-- Verified live: it does nothing. An UPDATE's row-visibility for matching
-- the WHERE clause is governed by SELECT-policy visibility; a table with no
-- permissive SELECT policy that covers a row leaves that row invisible to
-- UPDATE regardless of an UPDATE policy's own USING/WITH CHECK. claims has
-- only owner-scoped SELECT policies, so the admin UPDATE matched zero rows
-- for any claim admin doesn't personally own — SILENTLY: no error, no rows
-- affected, exactly the failure mode admin-measurements.html's own comments
-- explicitly worry about elsewhere ("Getting these key names wrong is the
-- silent failure here").
--
-- Fix: add a matching admin SELECT policy. Still not FOR ALL — INSERT and
-- DELETE on claims remain admin's-own-row-only, unchanged from before either
-- of these two migrations. SELECT is a strictly lower-risk grant than UPDATE
-- (already granted) and is what makes the UPDATE actually functional.
-- ============================================================================

CREATE POLICY "claims_admin_select" ON public.claims
  FOR SELECT
  USING (is_admin_email());
