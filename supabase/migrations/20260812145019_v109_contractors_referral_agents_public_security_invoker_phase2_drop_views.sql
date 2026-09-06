-- Migration: v109_contractors_referral_agents_public_security_invoker_phase2_drop_views
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-12T14:50:19Z, recorded in
-- supabase_migrations.schema_migrations as version 20260812145019, name
-- "v109_contractors_referral_agents_public_security_invoker_phase2_drop_views".
-- NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- ============================================================================
-- v109 PHASE 2 — Drop the now-unused contractors_public / referral_agents_public
-- SECURITY DEFINER views (GitHub #716). Phase 1 (get_contractors_public(),
-- get_referral_agents_public() functions + grants) applied earlier this
-- session. All 20 call-site files were switched to the RPC functions in PR
-- #740 (merged 9c659ad4, squash), and the Netlify production deploy for
-- that exact commit is confirmed live (deploy 6a7c86a2, state=ready,
-- commit_ref=9c659ad42404e216a5957287d18b52b08a8e05d6, published
-- 2026-08-12T14:44:00Z) — so it is now safe to drop the views without the
-- outage window #704's postmortem flagged.
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS public.contractors_public;
DROP VIEW IF EXISTS public.referral_agents_public;

COMMIT;
