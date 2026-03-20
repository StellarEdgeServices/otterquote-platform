-- ============================================================================
-- ClaimShield v3 Migration: Rate Limiting & Spending Controls
-- Run this in Supabase SQL Editor
-- ============================================================================

-- Rate limit tracking table
-- Every metered API call is logged here BEFORE it fires.
-- Edge Functions check this table and refuse to execute if limits are exceeded.
CREATE TABLE IF NOT EXISTS rate_limits (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  function_name text NOT NULL,           -- e.g., 'send-sms', 'send-adjuster-email'
  called_at timestamptz DEFAULT now(),
  caller_id uuid,                        -- user/claim ID for debugging
  metadata jsonb DEFAULT '{}'::jsonb,    -- any extra context
  blocked boolean DEFAULT false          -- true if the call was rate-limited
);

-- Fast lookups for rate limit checks
CREATE INDEX IF NOT EXISTS idx_rate_limits_function_time
  ON rate_limits(function_name, called_at DESC);

-- Cleanup: auto-delete entries older than 90 days to keep table small
-- Run this as a Supabase cron job (pg_cron) monthly
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits()
RETURNS void AS $$
BEGIN
  DELETE FROM rate_limits WHERE called_at < now() - interval '90 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Rate limit configuration table
-- Stores per-function limits. Editable in Supabase dashboard without code changes.
-- ============================================================================
CREATE TABLE IF NOT EXISTS rate_limit_config (
  function_name text PRIMARY KEY,
  max_per_hour int NOT NULL DEFAULT 10,
  max_per_day int NOT NULL DEFAULT 50,
  max_per_month int NOT NULL DEFAULT 500,
  enabled boolean DEFAULT true,          -- master kill switch per function
  monthly_cost_estimate numeric(10,4),   -- estimated cost per call for budget tracking
  monthly_budget_cap numeric(10,2),      -- max monthly spend for this function
  notes text
);

-- Seed with ClaimShield's $50/month budget allocation
INSERT INTO rate_limit_config (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes) VALUES
  ('send-sms',                10, 50,  500,  true, 0.0079, 4.00,   'Twilio SMS. ~$0.0079/segment. $4/mo budget = ~506 SMS/month.'),
  ('send-adjuster-email',     20, 100, 1000, true, 0.0000, 0.00,   'Mailgun email. Included in $35/mo plan (50K/month). Rate limit is for abuse prevention, not cost.'),
  ('create-payment-intent',   5,  10,  100,  true, 0.0000, 0.00,   'Stripe. In test mode = free. Production: 2.9% + $0.30 per txn, charged to customer not us.'),
  ('create-hover-order',      1,  2,   10,   true, 30.00,  10.00,  'Hover report. ~$25-40/order. $10/mo budget = 0-1 orders/month. Hard cap at 2/day for testing.'),
  ('create-docusign-envelope', 2, 5,   50,   true, 0.0000, 0.00,   'DocuSign. Sandbox = free. Production pricing TBD. Placeholder limits.')
ON CONFLICT (function_name) DO NOTHING;

-- ============================================================================
-- Rate limit check function
-- Called by Edge Functions before making any metered API call.
-- Returns: { allowed: boolean, reason: text, counts: { hour, day, month } }
-- ============================================================================
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_function_name text,
  p_caller_id uuid DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  config rate_limit_config%ROWTYPE;
  hourly_count int;
  daily_count int;
  monthly_count int;
  monthly_spend numeric;
  result jsonb;
BEGIN
  -- Get config for this function
  SELECT * INTO config FROM rate_limit_config WHERE function_name = p_function_name;

  -- If no config exists, deny by default (fail closed)
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'No rate limit config found for function: ' || p_function_name || '. Denying by default.'
    );
  END IF;

  -- Check master kill switch
  IF NOT config.enabled THEN
    -- Log the blocked attempt
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_caller_id, true, '{"reason": "function_disabled"}'::jsonb);

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'Function ' || p_function_name || ' is disabled via kill switch.'
    );
  END IF;

  -- Count recent calls (non-blocked only)
  SELECT COUNT(*) INTO hourly_count
  FROM rate_limits
  WHERE function_name = p_function_name
    AND called_at > now() - interval '1 hour'
    AND NOT blocked;

  SELECT COUNT(*) INTO daily_count
  FROM rate_limits
  WHERE function_name = p_function_name
    AND called_at > now() - interval '1 day'
    AND NOT blocked;

  SELECT COUNT(*) INTO monthly_count
  FROM rate_limits
  WHERE function_name = p_function_name
    AND called_at > now() - interval '1 month'
    AND NOT blocked;

  -- Check limits
  IF hourly_count >= config.max_per_hour THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_caller_id, true,
      jsonb_build_object('reason', 'hourly_limit', 'count', hourly_count, 'limit', config.max_per_hour));

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format('Hourly limit reached: %s/%s calls in the last hour.', hourly_count, config.max_per_hour),
      'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count)
    );
  END IF;

  IF daily_count >= config.max_per_day THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_caller_id, true,
      jsonb_build_object('reason', 'daily_limit', 'count', daily_count, 'limit', config.max_per_day));

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format('Daily limit reached: %s/%s calls today.', daily_count, config.max_per_day),
      'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count)
    );
  END IF;

  IF monthly_count >= config.max_per_month THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_caller_id, true,
      jsonb_build_object('reason', 'monthly_limit', 'count', monthly_count, 'limit', config.max_per_month));

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format('Monthly limit reached: %s/%s calls this month.', monthly_count, config.max_per_month),
      'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count)
    );
  END IF;

  -- Check estimated monthly budget
  IF config.monthly_budget_cap > 0 THEN
    monthly_spend := monthly_count * config.monthly_cost_estimate;
    IF monthly_spend >= config.monthly_budget_cap THEN
      INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
      VALUES (p_function_name, p_caller_id, true,
        jsonb_build_object('reason', 'budget_cap', 'spend', monthly_spend, 'cap', config.monthly_budget_cap));

      RETURN jsonb_build_object(
        'allowed', false,
        'reason', format('Monthly budget cap reached: $%s/$%s estimated spend.', monthly_spend, config.monthly_budget_cap),
        'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count),
        'estimated_spend', monthly_spend
      );
    END IF;
  END IF;

  -- All checks passed — log the call and allow it
  INSERT INTO rate_limits (function_name, caller_id, blocked)
  VALUES (p_function_name, p_caller_id, false);

  RETURN jsonb_build_object(
    'allowed', true,
    'counts', jsonb_build_object('hour', hourly_count + 1, 'day', daily_count + 1, 'month', monthly_count + 1),
    'estimated_spend', (monthly_count + 1) * config.monthly_cost_estimate
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- RLS Policies
-- rate_limits: service role only (Edge Functions use service role key)
-- rate_limit_config: service role only (admin edits via Supabase dashboard)
-- ============================================================================
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_config ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (Edge Functions)
CREATE POLICY "Service role full access on rate_limits"
  ON rate_limits FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on rate_limit_config"
  ON rate_limit_config FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================================
-- USAGE NOTES:
--
-- From any Edge Function, call:
--   const { data } = await supabase.rpc('check_rate_limit', {
--     p_function_name: 'send-sms',
--     p_caller_id: claimId  // optional
--   });
--   if (!data.allowed) {
--     return new Response(JSON.stringify({ error: data.reason }), { status: 429 });
--   }
--
-- To adjust limits without code changes:
--   UPDATE rate_limit_config SET max_per_day = 100 WHERE function_name = 'send-sms';
--
-- To emergency-kill a function:
--   UPDATE rate_limit_config SET enabled = false WHERE function_name = 'send-sms';
--
-- To view current usage:
--   SELECT function_name,
--     COUNT(*) FILTER (WHERE called_at > now() - interval '1 hour' AND NOT blocked) as last_hour,
--     COUNT(*) FILTER (WHERE called_at > now() - interval '1 day' AND NOT blocked) as last_day,
--     COUNT(*) FILTER (WHERE called_at > now() - interval '1 month' AND NOT blocked) as last_month,
--     COUNT(*) FILTER (WHERE blocked) as blocked_total
--   FROM rate_limits GROUP BY function_name;
-- ============================================================================
