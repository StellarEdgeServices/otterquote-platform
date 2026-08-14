-- ============================================================================
-- v105 ROLLBACK — restores mutable search_path on the 15 functions pinned by
-- v105-search-path-hardening-batch2.sql (GitHub #530)
-- ============================================================================

BEGIN;

ALTER FUNCTION public.update_modified_column() RESET search_path;
ALTER FUNCTION public.update_hover_tokens_updated_at() RESET search_path;
ALTER FUNCTION public.generate_recruit_code() RESET search_path;
ALTER FUNCTION public.set_updated_at() RESET search_path;
ALTER FUNCTION public.warranty_options_set_updated_at() RESET search_path;
ALTER FUNCTION public.contractor_templates_set_updated_at() RESET search_path;
ALTER FUNCTION public.sync_contractor_profile_role() RESET search_path;
ALTER FUNCTION public.set_dispute_updated_at() RESET search_path;
ALTER FUNCTION public.referral_agents_generate_recruit_code() RESET search_path;
ALTER FUNCTION public.home_profiles_set_updated_at() RESET search_path;
ALTER FUNCTION public.generate_referral_code() RESET search_path;
ALTER FUNCTION public.update_referral_stats() RESET search_path;
ALTER FUNCTION public.referral_agents_generate_code() RESET search_path;
ALTER FUNCTION public.update_updated_at() RESET search_path;
ALTER FUNCTION public.touch_ccv_updated_at() RESET search_path;

COMMIT;
