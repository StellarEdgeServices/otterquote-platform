-- Migration: v87_referrals_rls_update_scope
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-06-13T15:31:59Z, recorded in
-- supabase_migrations.schema_migrations as version 20260613153159, name
-- "v87_referrals_rls_update_scope". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

BEGIN;

DROP POLICY IF EXISTS "Authenticated can update referrals" ON public.referrals;

CREATE POLICY "Authenticated can advance referral status"
  ON public.referrals
  FOR UPDATE
  TO authenticated
  USING  (status = 'clicked')
  WITH CHECK (status = 'registered');

COMMIT;
