-- Rollback for 20260829221649_gh1302_track_referral_click_dedupe_and_is_test.sql
-- Restores track_referral_click to its pre-gh-1302 body (no dedupe, is_test
-- always false on insert). Does not touch any referrals rows written while
-- the fix was live -- those keep whatever is_test/dedup outcome they got.

CREATE OR REPLACE FUNCTION public.track_referral_click(p_code text, p_landing_page text DEFAULT NULL::text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_agent_id    uuid;
  v_referral_id uuid;
  v_rate        jsonb;
BEGIN
  -- Defensive validation (swallow-safe: NULL, never RAISE)
  IF p_code IS NULL OR btrim(p_code) = '' OR length(p_code) > 64 THEN
    RETURN NULL;
  END IF;

  -- 1. Resolve an ACTIVE agent by unique_code (checked BEFORE the rate
  --    limiter so bogus-code probes never consume budget)
  SELECT id INTO v_agent_id
  FROM referral_agents
  WHERE unique_code = btrim(p_code)
    AND status = 'active';

  IF v_agent_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- 2. Rate limit via the platform-standard limiter (NULL-caller capable)
  v_rate := public.check_rate_limit(
    p_function_name => 'track_referral_click',
    p_user_id       => auth.uid()
  );
  IF NOT COALESCE((v_rate ->> 'allowed')::boolean, false) THEN
    RETURN NULL;
  END IF;

  -- 3. Insert the clicked row; SECURITY DEFINER reads the id back
  INSERT INTO referrals
    (referral_agent_id, status, landing_page, utm_source, utm_medium, utm_campaign)
  VALUES (
    v_agent_id,
    'clicked',
    NULLIF(left(p_landing_page, 2048), ''),
    NULLIF(left(p_utm_source,   256), ''),
    NULLIF(left(p_utm_medium,   256), ''),
    NULLIF(left(p_utm_campaign, 256), '')
  )
  RETURNING id INTO v_referral_id;

  RETURN v_referral_id;
EXCEPTION WHEN OTHERS THEN
  -- Click tracking must never break the landing flow.
  RETURN NULL;
END;
$function$;
