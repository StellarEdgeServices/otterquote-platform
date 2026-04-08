-- v19-bid-fixes-value-adds.sql
-- Session 78, April 8, 2026
-- Fixes:
--   1. log_bid_submitted trigger: was using contractors.id as activity_log.user_id (wrong — FK to auth.users). Now joins contractors to get user_id.
--   2. Adds value_adds JSONB column to quotes table for contractor distinguishing features.
--   3. Adds auto_bid_value_adds JSONB column to contractors table for auto-bid distinguishing features.

-- ── 1. Fix log_bid_submitted trigger ──
-- Bug: trigger used NEW.contractor_id (contractors PK) as activity_log.user_id,
-- but activity_log.user_id is FK to auth.users(id). Every bid INSERT was rolling back.
CREATE OR REPLACE FUNCTION log_bid_submitted()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO activity_log (user_id, event_type, title, metadata)
    SELECT
        ct.user_id,     -- auth user_id (not contractors.id)
        'bid_submitted',
        'Bid submitted for ' || COALESCE(c.property_address, 'a project'),
        jsonb_build_object(
            'claim_id', NEW.claim_id,
            'quote_id', NEW.id,
            'amount', NEW.total_price
        )
    FROM claims c
    JOIN contractors ct ON ct.id = NEW.contractor_id
    WHERE c.id = NEW.claim_id;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Log errors but never block the bid INSERT
    RAISE WARNING 'log_bid_submitted trigger error: %', SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 2. Add value_adds JSONB to quotes ──
-- Stores contractor distinguishing features submitted with each bid:
-- gutters, chimney_flashing, gutter_guards, skylights, chimney_reflash, other_offers
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS value_adds JSONB DEFAULT NULL;

-- ── 3. Add auto_bid_value_adds JSONB to contractors ──
-- Stores the value_adds configuration for auto-bid submissions
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS auto_bid_value_adds JSONB DEFAULT NULL;

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_quotes_value_adds ON quotes USING GIN (value_adds) WHERE value_adds IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contractors_auto_bid_value_adds ON contractors USING GIN (auto_bid_value_adds) WHERE auto_bid_value_adds IS NOT NULL;
