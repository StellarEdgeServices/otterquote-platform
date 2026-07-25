-- ============================================================================
-- OtterQuote v95a — Referral RPC Grant Hardening (GitHub #571 follow-up)
-- ============================================================================
-- Created: 2026-07-25
-- Applied to production: 2026-07-25 (Supabase migration
-- v95a_referral_rpc_grant_hardening), immediately after v95.
--
-- Why: Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new
-- public-schema function to anon/authenticated/service_role at creation
-- time. v95's REVOKE ... FROM PUBLIC removed only the implicit PUBLIC
-- grant, not those explicit role grants — so the §6 negative probe
-- (BEGIN; SET LOCAL ROLE anon; SELECT advance_referral_registered(...))
-- succeeded when it should have been denied.
--
-- Intended grant matrix (v95 spec):
--   track_referral_click         anon + authenticated  (default grants OK)
--   register_partner             anon + authenticated  (default grants OK)
--   advance_referral_registered  authenticated ONLY
--   claims_advance_referral      trigger-only — no client role
--
-- Verified post-apply: anon call now fails 42501; authenticated advance
-- still returns true.
--
-- Rollback: none needed beyond v95's — the v95 rollback drops all four
-- functions, which removes every grant with them.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.advance_referral_registered(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claims_advance_referral() FROM anon, authenticated;
