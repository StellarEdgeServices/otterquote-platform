-- ============================================================================
-- OtterQuote Legacy Seed-Claim Stamping — ROLLBACK (flag reset)
-- ============================================================================
-- Created: 2026-07-27
-- Companion to: 2026-07-27-stamp-legacy-seed-claims-564.sql
--
-- Reverses the #564 seed-claim stamping by resetting is_test = false on the
-- stamped set. EXACTNESS: at stamp time (2026-07-27 preflight) ZERO claims
-- matching property_address ILIKE '100 E Test St%' were already
-- is_test = true, so the pattern predicate below restores precisely the
-- 130 stamped rows and nothing else. In particular it can NOT touch the
-- walk claim 474af0fc-908f-40f0-a9de-1df4c1fa26e1 ("1234 Pre-Flight Walk
-- Ln") or 73208937-a1c2-4db5-b402-3e7ec76374ae ("1290 Maple Grove Lane") —
-- neither matches the pattern.
--
-- ⚠️  CONSEQUENCE: resetting the flags re-exposes the seed corpus as fake
--   opportunities to every active real contractor (the #564 secondary
--   finding). Run only under an explicit CEO directive.
--
-- ⚠️  SCOPE DRIFT GUARD: E2E seed claims created AFTER this stamping are
--   born is_test = true (seed.mjs fix in PR for #564) and ALSO match the
--   pattern. Running this rollback later than 2026-07-27 will reset those
--   newer rows too — check created_at against the stamp date if precision
--   matters.
--
-- GitHub: #564
-- ============================================================================

UPDATE public.claims
   SET is_test = false
 WHERE property_address ILIKE '100 E Test St%'
   AND is_test = true;

-- Verification:
--   SELECT count(*) FROM public.claims
--    WHERE property_address ILIKE '100 E Test St%' AND is_test = true;  → 0
-- ============================================================================
