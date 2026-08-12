-- ============================================================================
-- OtterQuote Legacy Seed-Claim Stamping — GitHub #564 secondary finding
-- ============================================================================
-- Created: 2026-07-27
-- Executed: 2026-07-27 via Supabase MCP in canary waves per R-024
--
-- Purpose (CEO decision 2, #564 decision comment 2026-07-13 — APPROVED):
--   The June #543 purge cleaned test CONTRACTORS, not claims. The E2E seed
--   corpus ("100 E Test St, Zionsville, IN 46077") accumulated as
--   is_test=false biddable claims — visible to ANY active contractor as fake
--   opportunities. Stamp them is_test = true (metadata-only, reversible, no
--   deletion). With v96 live they vanish from every real contractor's
--   opportunity list instantly, and remain visible inside the test world.
--
--   Root cause of accumulation (fixed in the same PR): tests/e2e/seed/seed.mjs
--   inserted claims WITHOUT is_test, so every CI run minted new real-looking
--   biddable claims and teardown misses left them behind.
--
-- PREFLIGHT EVIDENCE (live prod, 2026-07-27, pre-stamp):
--   * Biddable-shaped claims (ready_for_bids = true AND status IN
--     ('active','bidding','pending')): 133 total — 131 is_test=false,
--     2 is_test=true (walk claim 474af0fc-908f-40f0-a9de-1df4c1fa26e1 +
--     73208937-a1c2-4db5-b402-3e7ec76374ae, both already stamped, untouched).
--   * Stamp set: property_address ILIKE '100 E Test St%' AND is_test = false
--     → 130 rows (issue #564 counted 124 on 2026-07-13; +6 from CI seed runs
--     since — all 130 belong to ONE user_id, the seeded E2E test homeowner;
--     oldest 2026-07-07, newest 2026-07-25).
--   * Rows already is_test=true matching the pattern: 0 → the pattern-based
--     rollback below restores EXACTLY the stamped set.
--   * Legitimate real claims — the ONLY is_test=false rows in the entire
--     claims table NOT matching the pattern, positively identified by ID and
--     excluded from the predicate by construction:
--       9978d5dc-64d3-43f4-aa17-6f72022b42e6 (7680 SW 182ND PL,
--         documents_needed, not biddable)
--       38ffb84a-5c27-4d73-8bfc-9915a3956e0d (6562 Yorkshire Cir,
--         Zionsville IN, active + biddable)
--
-- Companion rollback: 2026-07-27-stamp-legacy-seed-claims-564-rollback.sql
-- GitHub: #564
-- ============================================================================

-- ── Wave 0: preflight (read-only) ───────────────────────────────────────────
-- SELECT count(*) FROM public.claims
--  WHERE property_address ILIKE '100 E Test St%' AND is_test = false;
--   → expected 130
-- SELECT id, property_address, status, ready_for_bids FROM public.claims
--  WHERE is_test = false AND property_address NOT ILIKE '100 E Test St%';
--   → expected exactly the 2 legitimate claims listed above

-- ── Wave 1: 5-row canary (oldest first, deterministic order) ────────────────
UPDATE public.claims
   SET is_test = true
 WHERE id IN (
   SELECT id
     FROM public.claims
    WHERE property_address ILIKE '100 E Test St%'
      AND is_test = false
    ORDER BY created_at ASC
    LIMIT 5
 );

-- Canary verification (between waves):
--   * pattern AND is_test=true count = 5; pattern AND is_test=false = 125
--   * both legitimate claim IDs still is_test = false
--   * contractor-visible biddable count (real contractor probe) drops by
--     the canary's biddable overlap

-- ── Wave 2: remainder ───────────────────────────────────────────────────────
UPDATE public.claims
   SET is_test = true
 WHERE property_address ILIKE '100 E Test St%'
   AND is_test = false;

-- ── Final verification ──────────────────────────────────────────────────────
-- SELECT count(*) FROM public.claims
--  WHERE property_address ILIKE '100 E Test St%' AND is_test = false;  → 0
-- SELECT id, is_test FROM public.claims
--  WHERE id IN ('9978d5dc-64d3-43f4-aa17-6f72022b42e6',
--               '38ffb84a-5c27-4d73-8bfc-9915a3956e0d');
--   → both is_test = false (untouched)
-- Real-contractor visibility probe (SET LOCAL ROLE authenticated + real
-- contractor sub): visible biddable claims = real claims only
-- (38ffb84a and nothing matching '100 E Test St%').
-- ============================================================================
