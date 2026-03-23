-- ============================================================
-- OtterQuote v6 Migration: Hover OAuth Token Storage
-- Run in Supabase SQL Editor
-- ============================================================

-- Hover OAuth tokens (org-level, not per-user)
CREATE TABLE IF NOT EXISTS hover_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type TEXT DEFAULT 'Bearer',
  expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT DEFAULT 'all',
  owner_id INTEGER,
  owner_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one active token row (org-level auth)
-- If you need per-user tokens later, add a user_id column

-- RLS: Only service role can read/write tokens (Edge Functions use service role)
ALTER TABLE hover_tokens ENABLE ROW LEVEL SECURITY;

-- No public policies — tokens are only accessed by Edge Functions via service role key
-- Service role bypasses RLS automatically

-- Update hover_orders table to include capture_request fields
ALTER TABLE hover_orders
  ADD COLUMN IF NOT EXISTS capture_request_id INTEGER,
  ADD COLUMN IF NOT EXISTS capture_request_identifier TEXT,
  ADD COLUMN IF NOT EXISTS capture_link TEXT,
  ADD COLUMN IF NOT EXISTS deliverable_type_id INTEGER DEFAULT 2,
  ADD COLUMN IF NOT EXISTS model_id INTEGER,
  ADD COLUMN IF NOT EXISTS capturing_user_email TEXT,
  ADD COLUMN IF NOT EXISTS capturing_user_phone TEXT;

-- Index for looking up orders by capture request
CREATE INDEX IF NOT EXISTS idx_hover_orders_capture_request_id
  ON hover_orders(capture_request_id);

-- Index for webhook lookups by job_id
CREATE INDEX IF NOT EXISTS idx_hover_orders_hover_job_id
  ON hover_orders(hover_job_id);

-- Trigger to auto-update updated_at on hover_tokens
CREATE OR REPLACE FUNCTION update_hover_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hover_tokens_updated_at ON hover_tokens;
CREATE TRIGGER hover_tokens_updated_at
  BEFORE UPDATE ON hover_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_hover_tokens_updated_at();

-- ============================================================
-- DONE. Next: Set Supabase secrets and deploy Edge Functions.
-- ============================================================
