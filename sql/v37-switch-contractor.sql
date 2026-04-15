-- v37: Switch Contractor Feature (D-025 / D-041 / D-137)
-- Adds audit-trail columns so each contractor switch is recorded on the claim,
-- and adds cancellation tracking to the quotes table.
-- The Edge Function (switch-contractor) handles the full flow:
--   voiding the quote, refunding the Stripe fee, notifying the original
--   contractor, and re-opening the project to bidding.

-- 1. Audit columns on claims
ALTER TABLE claims ADD COLUMN IF NOT EXISTS contractor_switched_at  TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS contractor_switch_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN claims.contractor_switched_at  IS 'Timestamp of the most recent contractor switch (D-025/D-041)';
COMMENT ON COLUMN claims.contractor_switch_count IS 'Running count of how many times the homeowner has switched contractors on this claim';

-- 2. Cancellation tracking on quotes
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS cancellation_reason  TEXT;

COMMENT ON COLUMN quotes.cancelled_at        IS 'Timestamp when quote was cancelled (e.g. homeowner switched contractors)';
COMMENT ON COLUMN quotes.cancellation_reason IS 'Reason code for cancellation (homeowner_switched_contractor, etc.)';

-- 3. Add 'refunded' to the payment_status check constraint
-- Drop the old constraint and recreate it with the new value.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotes_payment_status_check'
  ) THEN
    ALTER TABLE quotes DROP CONSTRAINT quotes_payment_status_check;
  END IF;

  ALTER TABLE quotes ADD CONSTRAINT quotes_payment_status_check
    CHECK (payment_status IN ('succeeded', 'failed', 'pending', 'dunning', 'refunded'));
END $$;
