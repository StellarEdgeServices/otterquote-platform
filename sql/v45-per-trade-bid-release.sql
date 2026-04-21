-- ============================================================
-- v45: D-165 — Per-trade bid release timestamps
-- Applied: (pending)
--
-- Context:
--   D-164 (v44) added siding_bid_released_at for the retail
--   siding Hover-design gate. D-165 extends the per-trade
--   release pattern to all four trades so notify-contractors
--   can fire per-trade and contractor-opportunities.html can
--   filter and label per trade.
--
-- What this migration does:
--   1. Adds roofing_bid_released_at, gutters_bid_released_at,
--      windows_bid_released_at TIMESTAMPTZ to claims.
--      (siding_bid_released_at already exists from v44.)
--   2. Adds partial indexes to support future polling queries.
--   3. Backfills roofing/gutters/windows release timestamps for
--      all live claims currently in a bidding/open state.
--   4. Backfills siding_bid_released_at for INSURANCE claims
--      only — retail siding stays under the D-164 Hover-design
--      gate (check-siding-design-completion handles it).
--
-- Safe to re-run: all ADD COLUMN/CREATE INDEX use IF NOT EXISTS;
-- all UPDATE statements guard with COALESCE so already-set
-- values are never overwritten.
-- ============================================================

-- ── 1. Add per-trade release columns ────────────────────────────────────────

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS roofing_bid_released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gutters_bid_released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS windows_bid_released_at TIMESTAMPTZ;

-- siding_bid_released_at already exists from v44 — no-op comment for clarity
-- ALTER TABLE claims ADD COLUMN IF NOT EXISTS siding_bid_released_at TIMESTAMPTZ;

-- ── 2. Partial indexes (efficient polling / NULL-scan queries) ───────────────

-- Note: siding index already created by v44 (idx_claims_siding_pending_release).

CREATE INDEX IF NOT EXISTS idx_claims_roofing_pending_release
  ON claims (roofing_bid_released_at)
  WHERE roofing_bid_released_at IS NULL AND ready_for_bids = true;

CREATE INDEX IF NOT EXISTS idx_claims_gutters_pending_release
  ON claims (gutters_bid_released_at)
  WHERE gutters_bid_released_at IS NULL AND ready_for_bids = true;

CREATE INDEX IF NOT EXISTS idx_claims_windows_pending_release
  ON claims (windows_bid_released_at)
  WHERE windows_bid_released_at IS NULL AND ready_for_bids = true;

-- ── 3. Backfill roofing_bid_released_at ─────────────────────────────────────
-- All live bidding/active claims that include roofing in their selected_trades.
-- Use COALESCE(existing_value, bids_submitted_at, NOW()) so already-set
-- timestamps are preserved and the best available timestamp is used.

UPDATE claims
SET roofing_bid_released_at = COALESCE(
  roofing_bid_released_at,
  bids_submitted_at,
  NOW()
)
WHERE ready_for_bids = true
  AND status IN ('active', 'bidding', 'submitted', 'collecting_bids', 'contract_signed')
  AND trades IS NOT NULL AND 'roofing' = ANY(trades);

-- ── 4. Backfill gutters_bid_released_at ─────────────────────────────────────

UPDATE claims
SET gutters_bid_released_at = COALESCE(
  gutters_bid_released_at,
  bids_submitted_at,
  NOW()
)
WHERE ready_for_bids = true
  AND status IN ('active', 'bidding', 'submitted', 'collecting_bids', 'contract_signed')
  AND trades IS NOT NULL AND 'gutters' = ANY(trades);

-- ── 5. Backfill windows_bid_released_at ─────────────────────────────────────

UPDATE claims
SET windows_bid_released_at = COALESCE(
  windows_bid_released_at,
  bids_submitted_at,
  NOW()
)
WHERE ready_for_bids = true
  AND status IN ('active', 'bidding', 'submitted', 'collecting_bids', 'contract_signed')
  AND trades IS NOT NULL AND 'windows' = ANY(trades);

-- ── 6. Backfill siding_bid_released_at for INSURANCE claims only ─────────────
-- Retail siding is gated by D-164 (check-siding-design-completion sets it
-- once the Hover design is complete). Insurance claims have no design gate —
-- backfill those directly.

UPDATE claims
SET siding_bid_released_at = COALESCE(
  siding_bid_released_at,
  bids_submitted_at,
  NOW()
)
WHERE ready_for_bids = true
  AND funding_type != 'cash'   -- insurance only; retail stays under D-164 gate
  AND status IN ('active', 'bidding', 'submitted', 'collecting_bids', 'contract_signed')
  AND trades IS NOT NULL AND 'siding' = ANY(trades);
