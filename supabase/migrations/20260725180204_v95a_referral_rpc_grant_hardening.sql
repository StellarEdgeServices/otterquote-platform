-- Migration: v95a_referral_rpc_grant_hardening
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-07-25T18:02:04Z, recorded in
-- supabase_migrations.schema_migrations as version 20260725180204, name
-- "v95a_referral_rpc_grant_hardening". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v95a (#571 follow-up): Supabase ALTER DEFAULT PRIVILEGES grants EXECUTE on
-- new public functions to anon/authenticated/service_role at creation, so
-- v95's REVOKE ... FROM PUBLIC did not remove those explicit grants. Caught
-- by the §6 negative probe (SET LOCAL ROLE anon could call the advance).
-- Enforce the intended matrix:
--   track_referral_click        anon + authenticated   (unchanged, correct)
--   register_partner            anon + authenticated   (unchanged, correct)
--   advance_referral_registered authenticated only
--   claims_advance_referral     trigger-only (no client role)

REVOKE EXECUTE ON FUNCTION public.advance_referral_registered(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claims_advance_referral() FROM anon, authenticated;
