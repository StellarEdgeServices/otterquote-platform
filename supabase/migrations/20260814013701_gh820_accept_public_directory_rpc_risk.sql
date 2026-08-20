-- ============================================================================
-- gh820 — Accept security-advisor risk on public directory RPCs
-- ============================================================================
--
-- get_contractors_public() and get_referral_agents_public() are SECURITY
-- DEFINER, flagged by the live Supabase security advisor as executable by
-- anon/authenticated. Verified live (2026-08-14, #820) this is the intended
-- "public directory" pattern: SECURITY DEFINER is required to expose a
-- curated, RLS-bypassing column subset to anonymous visitors (anon has no
-- RLS grant on the base tables, so SECURITY INVOKER would break both
-- directories outright).
--
-- Column-list review: neither function returns email, phone, full street
-- address, or a government ID. license_number is a public-record credential
-- for a licensed contractor. unique_code/recruit_code on referral_agents are
-- referral codes designed to be shared publicly — they already appear in
-- plain URL parameters across refer-a-friend.html, ref-*.html,
-- partner-*.html, and recruit.html; exposing them via this RPC is not a new
-- disclosure.
--
-- This migration adds no behavior change — comment-only, so the advisor
-- finding is documented as accepted risk instead of being re-litigated on
-- every future advisor run.
-- ============================================================================

COMMENT ON FUNCTION public.get_contractors_public() IS
'Public directory RPC (SECURITY DEFINER required — anon has no RLS grant on contractors). Column list excludes email/phone/full address/government ID; license_number is public-record. Reviewed #820, 2026-08-14 — accepted as intentional design.';

COMMENT ON FUNCTION public.get_referral_agents_public() IS
'Public directory RPC (SECURITY DEFINER required — anon has no RLS grant on referral_agents). unique_code/recruit_code are referral codes meant to be shared publicly (already embedded in URL params on refer-a-friend.html, ref-*.html, partner-*.html, recruit.html). Reviewed #820, 2026-08-14 — accepted as intentional design.';
