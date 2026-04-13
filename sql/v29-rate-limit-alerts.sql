-- Migration v29: Add rate limit alert tracking
-- Adds alert_sent_month column to track when threshold alerts were sent
-- This prevents duplicate emails for the same month

ALTER TABLE rate_limit_config
ADD COLUMN IF NOT EXISTS alert_sent_month TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS notes_alert TEXT DEFAULT NULL;

-- Initialize all rows with NULL (no alerts sent yet)
UPDATE rate_limit_config SET alert_sent_month = NULL WHERE alert_sent_month IS NULL;

-- Comment on new columns
COMMENT ON COLUMN rate_limit_config.alert_sent_month IS 'YYYY-MM format of last alert sent (e.g., "2026-04"). Used to prevent duplicate alerts per month.';
COMMENT ON COLUMN rate_limit_config.notes_alert IS 'Alert-specific notes (e.g., escalation contacts, threshold changes)';
