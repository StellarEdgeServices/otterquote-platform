-- Migration: v101_referral_agents_public_directory_optin
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-08T13:44:06Z, recorded in
-- supabase_migrations.schema_migrations as version 20260808134406, name
-- "v101_referral_agents_public_directory_optin". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS public_directory_optin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.referral_agents.public_directory_optin IS
  'Partner has opted in to appear in the public referral-agent directory. Default false = not listed. Added v101 (GitHub #402), Tier 3A per D-261.';
