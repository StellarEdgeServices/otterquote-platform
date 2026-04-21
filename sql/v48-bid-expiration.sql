-- ============================================================================
-- Migration v48: Bid Expiration System (D-150)
-- Sessions 213 + 219, Apr 17, 2026
--
-- Adds:
--   quotes.expires_at TIMESTAMPTZ        — 14 days from submission
--   quotes.auto_renew BOOLEAN            — per-bid toggle (default false)
--   quotes.renewed_from_quote_id UUID    — self-FK for renewal chain
--   quotes.bid_status TEXT               — active | expired | superseded | cancelled
--   claims.bid_window_expires_at TIMESTAMPTZ — set on first bid received
--
-- Triggers:
--   trg_set_bid_window_on_first_bid  — sets bid_window_expires_at on claims
--   trg_enforce_bid_window_expiry    — blocks new bids after window closes
--
-- Rate limit:
--   Adds process-bid-expirations to rate_limit_config (48/day, 1500/month)
--
-- pg_cron:
--   Apply schedule separately via Management API (see comment at bottom).
-- ============================================================================

-- ── 1. quotes: expires_at ────────────────────────────────────────────────────
-- Default NULL — set to created_at + 14 days by the application at bid
-- submission (or backfilled below for any existing active quotes).
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

-- Backfill: any existing quote without an expiry, that is not yet cancelled
-- and has no payment recorded, gets 14 days from its created_at.
-- This is conservative: it gives old bids a fresh window rather than
-- immediately expiring them on first cron run.
UPDATE quotes
SET expires_at = created_at + INTERVAL '14 days'
WHERE expires_at IS NULL
  AND cancelled_at IS NULL
  AND (payment_status IS NULL OR payment_status NOT IN ('succeeded', 'refunded'));

-- ── 2. quotes: auto_renew ────────────────────────────────────────────────────
-- Default false (manual bids). Application sets to true for auto-bids.
-- contractor-settings.html writes the contractor default to
-- contractors.default_auto_renew (added below) which seeds this flag.
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN DEFAULT false;

-- ── 3. quotes: renewed_from_quote_id ────────────────────────────────────────
-- Self-referential FK. NULL = original bid. Non-NULL = renewal.
-- ON DELETE SET NULL: if the original bid is deleted (unlikely) don't cascade.
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS renewed_from_quote_id UUID
    REFERENCES quotes(id) ON DELETE SET NULL;

-- ── 3b. quotes: expired_at ──────────────────────────────────────────────────
-- Timestamp written by process-bid-expirations when a bid transitions to
-- 'expired' or 'superseded'. Separate from expires_at (the scheduled deadline)
-- so we can distinguish "was supposed to expire then" from "was actually processed".
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ DEFAULT NULL;

-- ── 4. quotes: bid_status ────────────────────────────────────────────────────
-- Tracks the bid's lifecycle separately from payment_status.
-- 'active'     — bid is live and within its expiry window
-- 'expired'    — 14-day window elapsed; awaiting renewal or removal
-- 'superseded' — replaced by a renewal; the old bid is no longer the live one
-- 'cancelled'  — removed via switch-contractor or admin action
--
-- Note: switch-contractor sets quotes.status = 'cancelled'. That column
-- pre-exists with no CHECK constraint. bid_status is additive and does
-- NOT replace the existing status column.
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS bid_status TEXT
    NOT NULL DEFAULT 'active'
    CHECK (bid_status IN ('active', 'expired', 'superseded', 'cancelled'));

-- Sync existing cancelled quotes
UPDATE quotes
SET bid_status = 'cancelled'
WHERE cancelled_at IS NOT NULL
  AND bid_status = 'active';

-- ── 5. contractors: default_auto_renew ──────────────────────────────────────
-- Per-contractor default for the auto_renew field on new bids.
-- Surfaced in contractor-settings.html (D-150).
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS default_auto_renew BOOLEAN DEFAULT false;

-- ── 6. claims: bid_window_expires_at + bid_window_notified_at ───────────────
-- bid_window_expires_at: NULL until the first bid is received for this claim.
--   Set by trigger trg_set_bid_window_on_first_bid (see below).
--   Represents when the entire competitive bidding window closes.
-- bid_window_notified_at: Written by process-bid-expirations after the homeowner
--   email is sent. Prevents duplicate homeowner emails.
ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS bid_window_expires_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS bid_window_notified_at TIMESTAMPTZ DEFAULT NULL;

-- ── 7. Indexes ───────────────────────────────────────────────────────────────
-- These support the hourly cron scan in process-bid-expirations.

-- Partial index: only quotes that are still active and have an expiry set.
-- This is the primary scan target for the cron function.
CREATE INDEX IF NOT EXISTS idx_quotes_expiry_active
  ON quotes(expires_at)
  WHERE bid_status = 'active' AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claims_bid_window_expires_at
  ON claims(bid_window_expires_at)
  WHERE bid_window_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quotes_renewed_from
  ON quotes(renewed_from_quote_id)
  WHERE renewed_from_quote_id IS NOT NULL;

-- Support claim-level lookups (all bids for a claim)
CREATE INDEX IF NOT EXISTS idx_quotes_claim_id_bid_status
  ON quotes(claim_id, bid_status);

-- ── 8. Trigger: set_bid_window_on_first_bid ──────────────────────────────────
-- Fires AFTER INSERT on quotes. On the first bid for a given claim
-- (bid_window_expires_at IS NULL), sets it to NOW() + 14 days.
-- Idempotent: the WHERE clause guards against double-setting.

CREATE OR REPLACE FUNCTION public.set_bid_window_on_first_bid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE claims
  SET bid_window_expires_at = NOW() + INTERVAL '14 days'
  WHERE id = NEW.claim_id
    AND bid_window_expires_at IS NULL;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_bid_window_on_first_bid IS
  'D-150: Sets claims.bid_window_expires_at = NOW() + 14 days on the first bid received for a claim. Idempotent — only fires when the window has not been set yet.';

DROP TRIGGER IF EXISTS trg_set_bid_window_on_first_bid ON quotes;
CREATE TRIGGER trg_set_bid_window_on_first_bid
  AFTER INSERT ON quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_bid_window_on_first_bid();

-- ── 9. Trigger: enforce_bid_window_expiry ────────────────────────────────────
-- Fires BEFORE INSERT on quotes. Blocks insertion if:
--   (a) the claim's bid_window_expires_at is in the past, AND
--   (b) the new quote is NOT a renewal (renewed_from_quote_id IS NULL).
--
-- Renewals are always permitted — the cron function issues them and sets
-- renewed_from_quote_id to the expired quote's ID.

CREATE OR REPLACE FUNCTION public.enforce_bid_window_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_expires_at TIMESTAMPTZ;
BEGIN
  SELECT bid_window_expires_at
  INTO v_window_expires_at
  FROM claims
  WHERE id = NEW.claim_id;

  IF v_window_expires_at IS NOT NULL
    AND v_window_expires_at < NOW()
    AND NEW.renewed_from_quote_id IS NULL
  THEN
    RAISE EXCEPTION
      'Bid window for claim % expired at %. Only renewal bids (renewed_from_quote_id set) are accepted after window expiry.',
      NEW.claim_id, v_window_expires_at
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_bid_window_expiry IS
  'D-150: Blocks new quote INSERTs after a claim''s bid_window_expires_at has passed, unless renewed_from_quote_id is set (renewal path). Enforces the constraint that fresh bids cannot be submitted on an expired bid window.';

DROP TRIGGER IF EXISTS trg_enforce_bid_window_expiry ON quotes;
CREATE TRIGGER trg_enforce_bid_window_expiry
  BEFORE INSERT ON quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_bid_window_expiry();

-- ── 10. Rate limit config ────────────────────────────────────────────────────
-- process-bid-expirations runs hourly = 24 invocations/day in steady state.
-- Daily limit of 48 gives a 2× buffer (manual triggers, retry bursts).
INSERT INTO rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, notes)
VALUES
  (
    'process-bid-expirations',
    2,
    48,
    1500,
    true,
    'D-150 bid expiration cron — hourly via pg_cron. Marks expired bids, sends contractor notifications, emails homeowner when full bid window closes.'
  )
ON CONFLICT (function_name) DO NOTHING;

-- ── 11. Column comments ──────────────────────────────────────────────────────
COMMENT ON COLUMN quotes.expires_at IS
  'D-150: Bid expiration timestamp. Set to created_at + 14 days at bid submission. NULL = expiration not yet assigned.';
COMMENT ON COLUMN quotes.auto_renew IS
  'D-150: Auto-renew on expiry. Default false (manual bids). Set to true for auto-bids or when contractor enables it in settings. Caps at 3 renewals (42 days total from original submission).';
COMMENT ON COLUMN quotes.renewed_from_quote_id IS
  'D-150: Self-FK. Set to the expired quote ID when this quote is a renewal. NULL = original bid.';
COMMENT ON COLUMN quotes.bid_status IS
  'D-150: Bid lifecycle. active = live bid within window; expired = 14-day window elapsed; superseded = replaced by a renewal; cancelled = removed.';
COMMENT ON COLUMN claims.bid_window_expires_at IS
  'D-150: When the bidding window for this claim closes entirely. Set by trigger on first bid received (first bid received + 14 days). NULL = no bids yet.';
COMMENT ON COLUMN contractors.default_auto_renew IS
  'D-150: Contractor-level default for auto_renew on new bids. Surfaced in contractor-settings.html. False = bids expire without renewal unless toggled per-bid.';

-- ── 12. pg_cron schedule ─────────────────────────────────────────────────────
-- Apply this block separately via the Supabase Management API after migration.
-- Replace <SUPABASE_PROJECT_REF> and <SERVICE_ROLE_KEY> with actual values.
--
-- SELECT cron.schedule(
--   'process-bid-expirations',
--   '0 * * * *',
--   $$
--     SELECT net.http_post(
--       url     := 'https://yeszghaspzwwstvsrioa.functions.supabase.co/process-bid-expirations',
--       headers := jsonb_build_object(
--         'Authorization', 'Bearer ' || current_setting('app.service_role_key', true),
--         'Content-Type', 'application/json'
--       ),
--       body    := '{}'::jsonb
--     )
--   $$
-- );
