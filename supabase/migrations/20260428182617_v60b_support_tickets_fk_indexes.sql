-- Migration: v60b_support_tickets_fk_indexes
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-28T18:26:17Z, recorded in
-- supabase_migrations.schema_migrations as version 20260428182617, name
-- "v60b_support_tickets_fk_indexes". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

CREATE INDEX IF NOT EXISTS support_tickets_claim_id_idx
  ON public.support_tickets (claim_id)
  WHERE claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS support_tickets_contractor_id_idx
  ON public.support_tickets (contractor_id)
  WHERE contractor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS support_tickets_user_id_idx
  ON public.support_tickets (user_id)
  WHERE user_id IS NOT NULL;
