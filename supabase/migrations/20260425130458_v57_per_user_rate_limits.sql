-- Migration: v57_per_user_rate_limits
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-25T13:04:58Z, recorded in
-- supabase_migrations.schema_migrations as version 20260425130458, name
-- "v57_per_user_rate_limits". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v57: Per-user rate limits for check_rate_limit()
-- Must DROP before CREATE because PostgreSQL disallows renaming parameters via REPLACE.

CREATE INDEX IF NOT EXISTS idx_rate_limits_fn_caller_time
  ON rate_limits(function_name, caller_id, called_at DESC);

DROP FUNCTION IF EXISTS check_rate_limit(text, uuid);

CREATE FUNCTION check_rate_limit(
  p_function_name TEXT,
  p_user_id       UUID DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  config               rate_limit_config%ROWTYPE;
  hourly_count         int;
  daily_count          int;
  monthly_count        int;
  global_monthly_count int;
  monthly_spend        numeric;
BEGIN
  SELECT * INTO config FROM rate_limit_config WHERE function_name = p_function_name;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'No rate limit config found for function: ' || p_function_name || '. Denying by default.'
    );
  END IF;

  IF NOT config.enabled THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_user_id, true, '{"reason": "function_disabled"}'::jsonb);

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'Function ' || p_function_name || ' is disabled via kill switch.'
    );
  END IF;

  SELECT COUNT(*) INTO hourly_count
  FROM rate_limits
  WHERE function_name = p_function_name
    AND (
      (p_user_id IS NOT NULL AND caller_id = p_user_id) OR
      (p_user_id IS NULL     AND caller_id IS NULL)
    )
    AND called_at > now() - interval '1 hour'
    AND NOT blocked;

  SELECT COUNT(*) INTO daily_count
  FROM rate_limits
  WHERE function_name = p_function_name
    AND (
      (p_user_id IS NOT NULL AND caller_id = p_user_id) OR
      (p_user_id IS NULL     AND caller_id IS NULL)
    )
    AND called_at > now() - interval '1 day'
    AND NOT blocked;

  SELECT COUNT(*) INTO monthly_count
  FROM rate_limits
  WHERE function_name = p_function_name
    AND (
      (p_user_id IS NOT NULL AND caller_id = p_user_id) OR
      (p_user_id IS NULL     AND caller_id IS NULL)
    )
    AND called_at > now() - interval '1 month'
    AND NOT blocked;

  IF hourly_count >= config.max_per_hour THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_user_id, true,
      jsonb_build_object('reason', 'hourly_limit', 'count', hourly_count, 'limit', config.max_per_hour));

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format('Hourly limit reached: %s/%s calls in the last hour.', hourly_count, config.max_per_hour),
      'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count)
    );
  END IF;

  IF daily_count >= config.max_per_day THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_user_id, true,
      jsonb_build_object('reason', 'daily_limit', 'count', daily_count, 'limit', config.max_per_day));

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format('Daily limit reached: %s/%s calls today.', daily_count, config.max_per_day),
      'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count)
    );
  END IF;

  IF monthly_count >= config.max_per_month THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_user_id, true,
      jsonb_build_object('reason', 'monthly_limit', 'count', monthly_count, 'limit', config.max_per_month));

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format('Monthly limit reached: %s/%s calls this month.', monthly_count, config.max_per_month),
      'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count)
    );
  END IF;

  IF config.monthly_budget_cap > 0 THEN
    SELECT COUNT(*) INTO global_monthly_count
    FROM rate_limits
    WHERE function_name = p_function_name
      AND called_at > now() - interval '1 month'
      AND NOT blocked;

    monthly_spend := global_monthly_count * config.monthly_cost_estimate;
    IF monthly_spend >= config.monthly_budget_cap THEN
      INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
      VALUES (p_function_name, p_user_id, true,
        jsonb_build_object('reason', 'budget_cap', 'spend', monthly_spend, 'cap', config.monthly_budget_cap));

      RETURN jsonb_build_object(
        'allowed', false,
        'reason', format('Monthly budget cap reached: $%s/$%s estimated spend.', monthly_spend, config.monthly_budget_cap),
        'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count),
        'estimated_spend', monthly_spend
      );
    END IF;
  END IF;

  INSERT INTO rate_limits (function_name, caller_id, blocked)
  VALUES (p_function_name, p_user_id, false);

  RETURN jsonb_build_object(
    'allowed', true,
    'counts', jsonb_build_object('hour', hourly_count + 1, 'day', daily_count + 1, 'month', monthly_count + 1),
    'estimated_spend', (monthly_count + 1) * config.monthly_cost_estimate
  );
END;
$$;
