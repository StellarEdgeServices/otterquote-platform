-- v13-activity-log.sql
-- Activity log for contractor dashboard feed
-- Tracks: bid_submitted, bid_accepted, opportunity_matched, profile_updated

-- ── Create activity_log table ──
CREATE TABLE IF NOT EXISTS activity_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'bid_submitted',
        'bid_accepted',
        'bid_rejected',
        'opportunity_matched',
        'profile_updated',
        'settings_updated',
        'contract_signed'
    )),
    title TEXT NOT NULL,           -- Human-readable summary, e.g. "Bid submitted for 123 Oak St"
    metadata JSONB DEFAULT '{}',   -- Flexible payload: claim_id, quote_id, amount, etc.
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_user_created ON activity_log(user_id, created_at DESC);

-- ── RLS ──
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- Contractors can only read their own activity
CREATE POLICY "Users can view own activity"
    ON activity_log FOR SELECT
    USING (auth.uid() = user_id);

-- Contractors can insert their own activity (client-side logging)
CREATE POLICY "Users can insert own activity"
    ON activity_log FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Service role can insert activity for any user (Edge Functions / triggers)
-- (Service role bypasses RLS by default, no policy needed)

-- ── Trigger: Auto-log when a quote is inserted ──
CREATE OR REPLACE FUNCTION log_bid_submitted()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO activity_log (user_id, event_type, title, metadata)
    SELECT
        NEW.contractor_id,
        'bid_submitted',
        'Bid submitted for ' || COALESCE(
            NULLIF(CONCAT_WS(', ', c.address_line1, c.address_city, c.address_state, c.address_zip), ''),
            'a project'
        ),
        jsonb_build_object(
            'claim_id', NEW.claim_id,
            'quote_id', NEW.id,
            'amount', NEW.total_price
        )
    FROM claims c
    WHERE c.id = NEW.claim_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_bid_submitted ON quotes;
CREATE TRIGGER trg_log_bid_submitted
    AFTER INSERT ON quotes
    FOR EACH ROW
    EXECUTE FUNCTION log_bid_submitted();

-- ── Trigger: Auto-log when a quote status changes to awarded ──
CREATE OR REPLACE FUNCTION log_bid_accepted()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'awarded' AND (OLD.status IS NULL OR OLD.status != 'awarded') THEN
        INSERT INTO activity_log (user_id, event_type, title, metadata)
        SELECT
            NEW.contractor_id,
            'bid_accepted',
            'Your bid was accepted for ' || COALESCE(
                NULLIF(CONCAT_WS(', ', c.address_line1, c.address_city, c.address_state, c.address_zip), ''),
                'a project'
            ),
            jsonb_build_object(
                'claim_id', NEW.claim_id,
                'quote_id', NEW.id,
                'amount', NEW.total_price
            )
        FROM claims c
        WHERE c.id = NEW.claim_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_bid_accepted ON quotes;
CREATE TRIGGER trg_log_bid_accepted
    AFTER UPDATE ON quotes
    FOR EACH ROW
    EXECUTE FUNCTION log_bid_accepted();

-- ── Done ──
-- Client-side events (profile_updated, settings_updated, opportunity_matched)
-- are inserted directly from the frontend via Supabase client.
