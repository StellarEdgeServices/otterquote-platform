-- ============================================================================
-- v105 — Pin search_path on 15 functions that drifted since the May 9 baseline
-- (GitHub #530 — checkpoint 1 of 4, due 2026-08-13)
-- ============================================================================
--
-- Same class and same fix as v76b (fix_security_definer_search_paths, May 9):
-- these 15 functions were created after that migration and never got an
-- explicit search_path, leaving them vulnerable to search_path hijacking.
-- Tier 3A per Dustin's 2026-08-11 checkpoint ruling (issue comment
-- 5252851924) — additive, no call-site changes, proven pattern, no CHECK
-- constraint or behavior change.
--
-- Rollback: sql/v105-rollback-search-path-hardening-batch2.sql
-- ============================================================================

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
