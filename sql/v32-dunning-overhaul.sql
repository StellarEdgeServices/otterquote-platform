-- v32: Dunning System Overhaul — April 14, 2026
-- Adds contractor timezone support and new dunning phase columns.
-- Matches new notification cadence: 1-hour frequency, contractor-local quiet hours,
-- 8 AM next-business-day warning, 10 AM homeowner notification with CTAs.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add timezone to contractors table
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York';

COMMENT ON COLUMN contractors.timezone IS
  'IANA timezone string (e.g. America/Chicago). Used for dunning quiet hours '
  'and scheduled messages. Defaults to America/New_York. Auto-derived from '
  'address_state on first dunning trigger if NULL.';

-- Backfill timezone from address_state for any existing contractors.
-- This mapping covers all 50 states + DC using the most common/majority timezone.
UPDATE contractors SET timezone = CASE address_state
  WHEN 'AL' THEN 'America/Chicago'
  WHEN 'AK' THEN 'America/Anchorage'
  WHEN 'AZ' THEN 'America/Phoenix'
  WHEN 'AR' THEN 'America/Chicago'
  WHEN 'CA' THEN 'America/Los_Angeles'
  WHEN 'CO' THEN 'America/Denver'
  WHEN 'CT' THEN 'America/New_York'
  WHEN 'DE' THEN 'America/New_York'
  WHEN 'FL' THEN 'America/New_York'
  WHEN 'GA' THEN 'America/New_York'
  WHEN 'HI' THEN 'Pacific/Honolulu'
  WHEN 'ID' THEN 'America/Denver'
  WHEN 'IL' THEN 'America/Chicago'
  WHEN 'IN' THEN 'America/Indiana/Indianapolis'
  WHEN 'IA' THEN 'America/Chicago'
  WHEN 'KS' THEN 'America/Chicago'
  WHEN 'KY' THEN 'America/New_York'
  WHEN 'LA' THEN 'America/Chicago'
  WHEN 'ME' THEN 'America/New_York'
  WHEN 'MD' THEN 'America/New_York'
  WHEN 'MA' THEN 'America/New_York'
  WHEN 'MI' THEN 'America/New_York'
  WHEN 'MN' THEN 'America/Chicago'
  WHEN 'MS' THEN 'America/Chicago'
  WHEN 'MO' THEN 'America/Chicago'
  WHEN 'MT' THEN 'America/Denver'
  WHEN 'NE' THEN 'America/Chicago'
  WHEN 'NV' THEN 'America/Los_Angeles'
  WHEN 'NH' THEN 'America/New_York'
  WHEN 'NJ' THEN 'America/New_York'
  WHEN 'NM' THEN 'America/Denver'
  WHEN 'NY' THEN 'America/New_York'
  WHEN 'NC' THEN 'America/New_York'
  WHEN 'ND' THEN 'America/Chicago'
  WHEN 'OH' THEN 'America/New_York'
  WHEN 'OK' THEN 'America/Chicago'
  WHEN 'OR' THEN 'America/Los_Angeles'
  WHEN 'PA' THEN 'America/New_York'
  WHEN 'RI' THEN 'America/New_York'
  WHEN 'SC' THEN 'America/New_York'
  WHEN 'SD' THEN 'America/Chicago'
  WHEN 'TN' THEN 'America/Chicago'
  WHEN 'TX' THEN 'America/Chicago'
  WHEN 'UT' THEN 'America/Denver'
  WHEN 'VT' THEN 'America/New_York'
  WHEN 'VA' THEN 'America/New_York'
  WHEN 'WA' THEN 'America/Los_Angeles'
  WHEN 'WV' THEN 'America/New_York'
  WHEN 'WI' THEN 'America/Chicago'
  WHEN 'WY' THEN 'America/Denver'
  WHEN 'DC' THEN 'America/New_York'
  ELSE 'America/New_York'
END
WHERE timezone = 'America/New_York' AND address_state IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add new phase columns to payment_failures
-- ─────────────────────────────────────────────────────────────────────────────

-- Denormalized timezone (to avoid joins in cron hot path)
ALTER TABLE payment_failures ADD COLUMN IF NOT EXISTS contractor_timezone TEXT DEFAULT 'America/New_York';

-- Scheduled time for 8 AM warning message (contractor local time, stored as UTC)
ALTER TABLE payment_failures ADD COLUMN IF NOT EXISTS warning_at TIMESTAMPTZ;

-- Scheduled time for 10 AM homeowner notification (contractor local time, stored as UTC)
ALTER TABLE payment_failures ADD COLUMN IF NOT EXISTS homeowner_notify_at TIMESTAMPTZ;

COMMENT ON COLUMN payment_failures.contractor_timezone IS
  'IANA timezone of the contractor at time of failure. Denormalized for cron efficiency.';
COMMENT ON COLUMN payment_failures.warning_at IS
  '8 AM contractor-local time on next business day (Mon-Fri). '
  'When cron crosses this time, send the 8 AM warning and stop hourly reminders.';
COMMENT ON COLUMN payment_failures.homeowner_notify_at IS
  '10 AM contractor-local time on next business day. '
  'When cron crosses this time, send homeowner notification with CTAs.';
COMMENT ON COLUMN payment_failures.next_reminder_at IS
  'When the next hourly dunning reminder should be sent. '
  'NULL after the 8 AM warning is sent (hourly phase is over).';
COMMENT ON COLUMN payment_failures.reminder_count IS
  'Number of hourly reminders sent so far (excludes the 8 AM warning message).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Expand dunning_status check constraint to include new states
-- ─────────────────────────────────────────────────────────────────────────────
-- Drop the existing constraint, then recreate with new values.
-- The new states:
--   active           → hourly reminders are being sent
--   warning_sent     → 8 AM warning sent; waiting for 10 AM homeowner notification
--   homeowner_notified → homeowner has been emailed with CTAs; awaiting their choice
--   contractor_out   → homeowner chose a different contractor; claim reset to bidding
--   resolved         → contractor paid; dunning closed
--   escalated        → legacy escalation (kept for backward compat with v31 records)
--   expired          → abandoned after too long

ALTER TABLE payment_failures DROP CONSTRAINT IF EXISTS payment_failures_dunning_status_check;

ALTER TABLE payment_failures ADD CONSTRAINT payment_failures_dunning_status_check
  CHECK (dunning_status IN (
    'active',
    'warning_sent',
    'homeowner_notified',
    'contractor_out',
    'resolved',
    'escalated',
    'expired'
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. New indexes for the two-pass cron query
-- ─────────────────────────────────────────────────────────────────────────────

-- Pass 1: active records ready for hourly reminder or warning transition
-- (existing idx_payment_failures_active covers this — keep it; just add columns)
DROP INDEX IF EXISTS idx_payment_failures_active;
CREATE INDEX idx_payment_failures_active
  ON payment_failures(next_reminder_at)
  WHERE dunning_status = 'active';

-- Pass 2: warning_sent records ready for homeowner notification
CREATE INDEX IF NOT EXISTS idx_payment_failures_warning_sent
  ON payment_failures(homeowner_notify_at)
  WHERE dunning_status = 'warning_sent';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Backfill existing active records with sensible defaults
--    (so legacy records from v31 don't break under the new code)
-- ─────────────────────────────────────────────────────────────────────────────
-- For any existing 'active' records missing warning_at/homeowner_notify_at,
-- set them to 8 AM / 10 AM ET tomorrow (safe fallback).
UPDATE payment_failures
SET
  warning_at = COALESCE(
    warning_at,
    (date_trunc('day', NOW() AT TIME ZONE 'America/New_York') + INTERVAL '1 day' + INTERVAL '8 hours')
      AT TIME ZONE 'America/New_York'
  ),
  homeowner_notify_at = COALESCE(
    homeowner_notify_at,
    (date_trunc('day', NOW() AT TIME ZONE 'America/New_York') + INTERVAL '1 day' + INTERVAL '10 hours')
      AT TIME ZONE 'America/New_York'
  ),
  contractor_timezone = COALESCE(contractor_timezone, 'America/New_York')
WHERE dunning_status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- DONE
-- Changes:
--   contractors: +1 column (timezone TEXT, backfilled from address_state)
--   payment_failures: +3 columns (contractor_timezone, warning_at, homeowner_notify_at)
--   payment_failures: dunning_status constraint expanded with 3 new states
--   indexes: idx_payment_failures_active rebuilt; idx_payment_failures_warning_sent added
-- ─────────────────────────────────────────────────────────────────────────────
