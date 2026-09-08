-- Migration: v95_referral_attribution_rpc
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-07-25T18:00:03Z, recorded in
-- supabase_migrations.schema_migrations as version 20260725180003, name
-- "v95_referral_attribution_rpc". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- ============================================================================
-- OtterQuote Referral Attribution RPC Layer Migration
-- v95 — GitHub #571 (Tier 3A additive: new functions + one trigger)
-- Mirror of sql/v95-referral-attribution-rpc.sql @ cd627ee
-- Companion rollback: sql/v95-rollback-referral-attribution-rpc.sql
-- ============================================================================

BEGIN;

INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month,
   enabled, monthly_budget_cap, monthly_cost_estimate, notes)
VALUES
  ('track_referral_click', 300, 2000, 20000,
   true, 0.00, 0.0000,
   'v95 (#571): referral click-tracking RPC. caller_id NULL = shared global anon bucket. enabled=false is the kill switch.')
ON CONFLICT (function_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.track_referral_click(
  p_code         text,
  p_landing_page text DEFAULT NULL,
  p_utm_source   text DEFAULT NULL,
  p_utm_medium   text DEFAULT NULL,
  p_utm_campaign text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.track_referral_click(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.track_referral_click(text, text, text, text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.register_partner(
  p_agent_type       text,
  p_first_name       text,
  p_last_name        text,
  p_email            text,
  p_phone            text  DEFAULT NULL,
  p_company          text  DEFAULT NULL,
  p_website          text  DEFAULT NULL,
  p_service_area     text  DEFAULT NULL,
  p_referred_by_note text  DEFAULT NULL,
  p_recruit_code     text  DEFAULT NULL,
  p_metadata         jsonb DEFAULT '{}'::jsonb,
  p_photo_url        text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_email        text;
  v_recruiter_id uuid;
  v_constraint   text;
  v_row          referral_agents%ROWTYPE;
BEGIN
  IF p_agent_type IS NULL OR p_agent_type NOT IN
     ('re_agent', 'insurance_agent', 'home_inspector', 'customer', 'adjuster', 'other') THEN
    RAISE EXCEPTION 'invalid_agent_type: % is not a recognized partner type',
      COALESCE(p_agent_type, '(null)');
  END IF;

  v_email := lower(btrim(COALESCE(p_email, '')));
  IF btrim(COALESCE(p_first_name, '')) = ''
     OR btrim(COALESCE(p_last_name, '')) = ''
     OR v_email = '' THEN
    RAISE EXCEPTION 'missing_required_fields: first name, last name, and email are required';
  END IF;
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(v_email) > 320 THEN
    RAISE EXCEPTION 'invalid_email: please provide a valid email address';
  END IF;

  IF EXISTS (SELECT 1 FROM referral_agents WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'partner_exists';
  END IF;

  -- D-143: resolve recruit code -> recruiter; unknown ignored silently
  IF p_recruit_code IS NOT NULL AND btrim(p_recruit_code) <> '' THEN
    SELECT id INTO v_recruiter_id
    FROM referral_agents
    WHERE recruit_code = btrim(p_recruit_code)
      AND status = 'active';
  END IF;

  INSERT INTO referral_agents (
    agent_type, first_name, last_name, email, phone, company, website,
    service_area, photo_url, referred_by_note, metadata,
    recruited_by_id, recruited_at
  ) VALUES (
    p_agent_type,
    btrim(p_first_name),
    btrim(p_last_name),
    v_email,
    NULLIF(btrim(COALESCE(p_phone,        '')), ''),
    NULLIF(btrim(COALESCE(p_company,      '')), ''),
    NULLIF(btrim(COALESCE(p_website,      '')), ''),
    NULLIF(btrim(COALESCE(p_service_area, '')), ''),
    NULLIF(btrim(COALESCE(p_photo_url,    '')), ''),
    NULLIF(btrim(COALESCE(p_referred_by_note, '')), ''),
    COALESCE(p_metadata, '{}'::jsonb),
    v_recruiter_id,
    CASE WHEN v_recruiter_id IS NOT NULL THEN now() END
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id',           v_row.id,
    'unique_code',  v_row.unique_code,
    'recruit_code', v_row.recruit_code
  );
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'referral_agents_email_key' THEN
      RAISE EXCEPTION 'partner_exists';
    END IF;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.register_partner(text, text, text, text, text, text, text, text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_partner(text, text, text, text, text, text, text, text, text, text, jsonb, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.advance_referral_registered(p_referral_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_email text;
BEGIN
  IF p_referral_id IS NULL THEN
    RETURN false;
  END IF;

  v_email := NULLIF(auth.jwt() ->> 'email', '');

  UPDATE referrals
     SET status          = 'registered',
         homeowner_email = COALESCE(v_email, homeowner_email)
   WHERE id = p_referral_id
     AND status = 'clicked';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_referral_registered(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.advance_referral_registered(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.claims_advance_referral()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  BEGIN
    UPDATE referrals
       SET status = 'claim_submitted'
     WHERE id = NEW.referral_id
       AND status IN ('clicked', 'registered');
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never break the claim write
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.claims_advance_referral() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_claims_advance_referral ON public.claims;
CREATE TRIGGER trg_claims_advance_referral
  AFTER INSERT OR UPDATE OF referral_id ON public.claims
  FOR EACH ROW
  WHEN (NEW.referral_id IS NOT NULL)
  EXECUTE FUNCTION public.claims_advance_referral();

COMMIT;
