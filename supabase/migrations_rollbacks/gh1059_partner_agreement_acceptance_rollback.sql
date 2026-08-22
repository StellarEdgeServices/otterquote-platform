-- Rollback: gh1059_partner_agreement_acceptance_rollback.sql
-- Reverts: supabase/migrations/20260820004212_gh1059_partner_agreement_acceptance.sql
-- Author: Claude Code (automated, run-work rw-f22-20260820T003631-k7p2)
-- Date: 2026-08-20
--
-- WARNING — read before running: if any partner has registered since the
-- forward migration applied, that row's partner_agreement_version /
-- _accepted_at / _attestation is the ONLY record that partner accepted the
-- agreement. Dropping these columns destroys that record, not just schema.
-- Safe to run ONLY while live exposure is still zero (verify with the query
-- below first). If any row has a non-null partner_agreement_accepted_at,
-- STOP — export those rows before proceeding, this is no longer a
-- consequence-free schema revert.
--
--   SELECT count(*) FROM public.referral_agents
--   WHERE partner_agreement_accepted_at IS NOT NULL;
--   -- Expected before rollback: 0. If nonzero, do not proceed blind.

BEGIN;

DROP FUNCTION IF EXISTS public.record_partner_agreement_reacceptance(uuid, text);

-- Restore register_partner() to its pre-gh1059 definition (byte-identical to
-- the version applied by gh973, 2026-08-18) — no acceptance-column writes,
-- signature unchanged throughout.
CREATE OR REPLACE FUNCTION public.register_partner(p_agent_type text, p_first_name text, p_last_name text, p_email text, p_phone text DEFAULT NULL::text, p_company text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_service_area text DEFAULT NULL::text, p_referred_by_note text DEFAULT NULL::text, p_recruit_code text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_photo_url text DEFAULT NULL::text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text, p_utm_content text DEFAULT NULL::text, p_is_test boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email        text;
  v_recruiter_id uuid;
  v_constraint   text;
  v_row          referral_agents%ROWTYPE;
  v_rate         jsonb;
BEGIN
  v_rate := public.check_rate_limit(
    p_function_name => 'register_partner',
    p_user_id       => auth.uid()
  );
  IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner rate limit exceeded');
  END IF;

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

  IF p_recruit_code IS NOT NULL AND btrim(p_recruit_code) <> '' THEN
    SELECT id INTO v_recruiter_id
    FROM referral_agents
    WHERE recruit_code = btrim(p_recruit_code)
      AND status = 'active';
  END IF;

  INSERT INTO referral_agents (
    agent_type, first_name, last_name, email, phone, company, website,
    service_area, photo_url, referred_by_note, metadata,
    recruited_by_id, recruited_at,
    utm_source, utm_medium, utm_campaign, utm_content, is_test
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
    CASE WHEN v_recruiter_id IS NOT NULL THEN now() END,
    NULLIF(btrim(COALESCE(p_utm_source,   '')), ''),
    NULLIF(btrim(COALESCE(p_utm_medium,   '')), ''),
    NULLIF(btrim(COALESCE(p_utm_campaign, '')), ''),
    NULLIF(btrim(COALESCE(p_utm_content,  '')), ''),
    COALESCE(p_is_test, false)
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
$function$;

ALTER TABLE public.referral_agents
  DROP COLUMN IF EXISTS partner_agreement_version,
  DROP COLUMN IF EXISTS partner_agreement_accepted_at,
  DROP COLUMN IF EXISTS partner_agreement_attestation,
  DROP COLUMN IF EXISTS needs_partner_reacceptance;

COMMIT;
