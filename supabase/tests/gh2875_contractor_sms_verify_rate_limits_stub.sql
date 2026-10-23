-- gh-2875: throwaway-Postgres stub for supabase/tests/gh2875_contractor_sms_verify_rate_limits_proof_run.sh. NEVER run against production.
-- public.rate_limit_config and public.rate_limits as production has them (column list, types, defaults, primary keys: read-only
-- pg_attribute / pg_constraint SELECT 2026-10-23), and public.check_rate_limit(text,uuid) (the overload index.ts L45 calls, named args) VERBATIM from
-- production pg_get_functiondef (2026-10-23). The runner re-checks md5(pg_get_functiondef) = 905e1e5378a90834 (first 16 hex)
-- for the canonical overload, the md5 production reported, so the proof exercises the live limiter body, not a paraphrase.
CREATE TABLE public.rate_limit_config (
  function_name text NOT NULL PRIMARY KEY,
  max_per_hour integer NOT NULL DEFAULT 10,
  max_per_day integer NOT NULL DEFAULT 50,
  max_per_month integer NOT NULL DEFAULT 500,
  enabled boolean DEFAULT true,
  monthly_cost_estimate numeric(10,4),
  monthly_budget_cap numeric(10,2),
  notes text,
  alert_sent_month text,
  notes_alert text
);
CREATE TABLE public.rate_limits (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  function_name text NOT NULL,
  called_at timestamp with time zone DEFAULT now(),
  caller_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  blocked boolean DEFAULT false
);
CREATE INDEX idx_rate_limits_fn_caller_time ON public.rate_limits USING btree (function_name, caller_id, called_at DESC);
CREATE INDEX idx_rate_limits_function_time ON public.rate_limits USING btree (function_name, called_at DESC);
-- An unrelated production row (values as read 2026-10-23). The rollback must leave it alone.
INSERT INTO public.rate_limit_config (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES ('send-sms', 10, 50, 500, true, 0.0079, 4.00, 'Twilio SMS. ~$0.0079/segment. $4/mo budget = ~506 SMS/month.');

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_function_name text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;
