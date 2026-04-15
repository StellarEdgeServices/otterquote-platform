-- v38: Hover Resend Link Support + Rate Limit Config
-- Adds resend tracking columns to hover_orders so the resend-hover-link
-- Edge Function can enforce the 3-resends-per-claim-per-day limit without
-- touching the global check_rate_limit RPC.
-- Also inserts a rate_limit_config row for global monitoring / kill switch.

-- 1. Add resend tracking to hover_orders
ALTER TABLE hover_orders
  ADD COLUMN IF NOT EXISTS resend_count    INT           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_resend_at  TIMESTAMPTZ;

COMMENT ON COLUMN hover_orders.resend_count   IS 'Number of resend-link emails sent today (resets when last_resend_at::date < NOW()::date)';
COMMENT ON COLUMN hover_orders.last_resend_at IS 'Timestamp of the most recent resend-link email for this order';

-- 2. Insert rate_limit_config row for resend-hover-link
--    Per-claim cap (3/day) is enforced inside the Edge Function.
--    This row provides a global kill switch and system-level monitoring.
INSERT INTO rate_limit_config (
  function_name,
  max_per_hour,
  max_per_day,
  max_per_month,
  enabled,
  monthly_cost_estimate,
  monthly_budget_cap,
  notes
) VALUES (
  'resend-hover-link',
  10,
  50,
  200,
  true,
  0.0000,
  0.00,
  'Re-sends existing Hover capture link via Mailgun. Free (included in $35/mo plan). Per-claim limit (3/day) enforced in Edge Function. This row provides a global kill switch only.'
)
ON CONFLICT (function_name) DO NOTHING;
