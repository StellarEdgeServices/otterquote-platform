-- gh-1302: track_referral_click wrote TWO referrals rows per click (ref.html
-- tracks, redirects to ref-*.html, which tracks again -- 965ms apart, observed
-- live in production) and never inherited the referring agent's is_test flag.
--
-- Fix:
--  1. Dedupe: a repeat click from the same agent within 10 seconds returns the
--     existing 'clicked' row instead of inserting a new one. Chosen over
--     removing either call site because ref-*.html's own call is load-bearing
--     on its own for direct-to-landing-page links that skip ref.html entirely.
--     A genuine second visitor clicking the same agent's link inside 10s is
--     the accepted tradeoff; clicks beyond the window are unaffected.
--  2. is_test is now inherited from referral_agents.is_test at insert time
--     instead of defaulting to false, so test-agent traffic stops polluting
--     real referral metrics.
--
-- Verified live before this file was written (not just on a branch): two
-- back-to-back calls against test agent TVHG079W (is_test=true) returned the
-- SAME referral id both times, and the resulting row has is_test=true. Applied
-- to production first via apply_migration (version 20260829221649, matching
-- this filename exactly -- see gh-1307 for why filename and applied version
-- must agree) so this file is the historical record of what already ran, not
-- a pending change.
--
-- No backfill of the historical mislabeled rows cited in the issue body
-- (both directions: real agents with is_test wrongly true, test agents with
-- is_test wrongly false). That is a judgment call about correcting the
-- historical record, not a schema/behavior fix, and per the issue's own
-- AC3 it must be surfaced explicitly rather than decided by omission --
-- flagged in the issue thread for Dustin/Bridge, not executed here.
--
-- Refs #1302

CREATE OR REPLACE FUNCTION public.track_referral_click(p_code text, p_landing_page text DEFAULT NULL::text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_agent_id      uuid;
  v_agent_is_test boolean;
  v_referral_id   uuid;
  v_rate          jsonb;
BEGIN
  -- Defensive validation (swallow-safe: NULL, never RAISE)
  IF p_code IS NULL OR btrim(p_code) = '' OR length(p_code) > 64 THEN
    RETURN NULL;
  END IF;

  -- 1. Resolve an ACTIVE agent by unique_code (checked BEFORE the rate
  --    limiter so bogus-code probes never consume budget)
  SELECT id, is_test INTO v_agent_id, v_agent_is_test
  FROM referral_agents
  WHERE unique_code = btrim(p_code)
    AND status = 'active';

  IF v_agent_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- gh-1302: ref.html tracks a click, then redirects to ref-*.html, which
  -- tracks the SAME click again (965ms apart, observed live in production).
  -- Neither call site knows about the other, and ref-*.html's own call is
  -- load-bearing on its own for direct-to-landing-page links that skip
  -- ref.html entirely -- so the fix lives here, not by removing either call
  -- site. Collapse repeat clicks from the same agent within a short window
  -- into the earlier row instead of inserting a second one. 10s comfortably
  -- covers the observed redirect latency; a genuine second visitor clicking
  -- the same agent's link inside 10s is the accepted tradeoff, and clicks
  -- beyond this window are unaffected.
  SELECT id INTO v_referral_id
  FROM referrals
  WHERE referral_agent_id = v_agent_id
    AND status = 'clicked'
    AND created_at > now() - interval '10 seconds'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_referral_id IS NOT NULL THEN
    RETURN v_referral_id;
  END IF;

  -- 2. Rate limit via the platform-standard limiter (NULL-caller capable)
  v_rate := public.check_rate_limit(
    p_function_name => 'track_referral_click',
    p_user_id       => auth.uid()
  );
  IF NOT COALESCE((v_rate ->> 'allowed')::boolean, false) THEN
    RETURN NULL;
  END IF;

  -- 3. Insert the clicked row; SECURITY DEFINER reads the id back.
  -- gh-1302: is_test now inherited from the referring agent instead of
  -- defaulting to false, so test-agent traffic no longer pollutes real
  -- referral metrics (and a real agent's is_test=false is still preserved).
  INSERT INTO referrals
    (referral_agent_id, status, landing_page, utm_source, utm_medium, utm_campaign, is_test)
  VALUES (
    v_agent_id,
    'clicked',
    NULLIF(left(p_landing_page, 2048), ''),
    NULLIF(left(p_utm_source,   256), ''),
    NULLIF(left(p_utm_medium,   256), ''),
    NULLIF(left(p_utm_campaign, 256), ''),
    COALESCE(v_agent_is_test, false)
  )
  RETURNING id INTO v_referral_id;

  RETURN v_referral_id;
EXCEPTION WHEN OTHERS THEN
  -- Click tracking must never break the landing flow.
  RETURN NULL;
END;
$function$;
