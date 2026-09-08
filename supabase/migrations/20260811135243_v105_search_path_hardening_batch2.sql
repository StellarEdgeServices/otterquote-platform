-- Migration: v105_search_path_hardening_batch2
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-11T13:52:43Z, recorded in
-- supabase_migrations.schema_migrations as version 20260811135243, name
-- "v105_search_path_hardening_batch2". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

BEGIN;

ALTER FUNCTION public.update_modified_column() SET search_path = 'public';
ALTER FUNCTION public.update_hover_tokens_updated_at() SET search_path = 'public';
ALTER FUNCTION public.generate_recruit_code() SET search_path = 'public';
ALTER FUNCTION public.set_updated_at() SET search_path = 'public';
ALTER FUNCTION public.warranty_options_set_updated_at() SET search_path = 'public';
ALTER FUNCTION public.contractor_templates_set_updated_at() SET search_path = 'public';
ALTER FUNCTION public.sync_contractor_profile_role() SET search_path = 'public';
ALTER FUNCTION public.set_dispute_updated_at() SET search_path = 'public';
ALTER FUNCTION public.referral_agents_generate_recruit_code() SET search_path = 'public';
ALTER FUNCTION public.home_profiles_set_updated_at() SET search_path = 'public';
ALTER FUNCTION public.generate_referral_code() SET search_path = 'public';
ALTER FUNCTION public.update_referral_stats() SET search_path = 'public';
ALTER FUNCTION public.referral_agents_generate_code() SET search_path = 'public';
ALTER FUNCTION public.update_updated_at() SET search_path = 'public';
ALTER FUNCTION public.touch_ccv_updated_at() SET search_path = 'public';

COMMIT;
