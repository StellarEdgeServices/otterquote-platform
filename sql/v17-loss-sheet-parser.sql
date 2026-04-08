-- ============================================================
-- OtterQuote SQL Migration v17
-- Loss Sheet Parser — parsed_line_items, contractor_scope_summary,
-- loss_sheet_parsed_at columns + GIN index + rate_limit_config row
-- ClickUp: 86e0tt3ku
-- Session 75, April 8, 2026
-- ============================================================

-- ----------------------------------------------------------------
-- 1. ADD COLUMNS TO claims TABLE
-- ----------------------------------------------------------------

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS parsed_line_items JSONB,
  ADD COLUMN IF NOT EXISTS contractor_scope_summary TEXT,
  ADD COLUMN IF NOT EXISTS loss_sheet_parsed_at TIMESTAMPTZ;

-- ----------------------------------------------------------------
-- 2. GIN INDEX for JSONB column (efficient containment queries)
-- ----------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_claims_parsed_line_items
  ON claims USING gin (parsed_line_items);

-- ----------------------------------------------------------------
-- 3. RATE LIMIT ROW for parse-loss-sheet
-- Consistent with platform pattern:
--   rate_limit_config(function_name, max_per_day, max_per_month, enabled)
-- ----------------------------------------------------------------

INSERT INTO rate_limit_config (function_name, max_per_day, max_per_month, enabled)
VALUES ('parse-loss-sheet', 10, 50, true)
ON CONFLICT (function_name) DO UPDATE
  SET max_per_day = EXCLUDED.max_per_day,
      max_per_month = EXCLUDED.max_per_month,
      enabled = EXCLUDED.enabled;
