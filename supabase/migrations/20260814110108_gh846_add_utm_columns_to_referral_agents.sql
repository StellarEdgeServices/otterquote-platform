-- gh-846: partner signup drops all UTM attribution.
--
-- referral_agents had no utm_* columns at all -- referrals does (utm_source,
-- utm_medium, utm_campaign), but that table only exists once a partner is
-- already recruiting *homeowners*, not when the partner themselves signs up.
-- The warm outreach kit's 16 per-contact links carry utm_source/medium/
-- campaign/content on the partner *application* URL, and register_partner()
-- had nowhere to put them.
--
-- Additive-only (new nullable columns) -- Tier 3A per the issue's own AC.

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS utm_source   text,
  ADD COLUMN IF NOT EXISTS utm_medium   text,
  ADD COLUMN IF NOT EXISTS utm_campaign text,
  ADD COLUMN IF NOT EXISTS utm_content  text;

-- register_partner() signature changes (new trailing optional params), so the
-- old 12-arg overload is dropped explicitly rather than left to coexist --
-- PostgREST resolves named-parameter RPC calls by matching the available
-- signatures, and two overloads where one is a strict subset of the other's
-- optional params is exactly the shape that produces "function name is not
-- unique" errors on real traffic.
DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text
);

CREATE FUNCTION public.register_partner(
  p_agent_type       text,
  p_first_name       text,
  p_last_name        text,
  p_email            text,
  p_phone            text DEFAULT NULL,
  p_company          text DEFAULT NULL,
  p_website          text DEFAULT NULL,
  p_service_area     text DEFAULT NULL,
  p_referred_by_note text DEFAULT NULL,
  p_recruit_code     text DEFAULT NULL,
  p_metadata         jsonb DEFAULT '{}'::jsonb,
  p_photo_url        text DEFAULT NULL,
  p_utm_source       text DEFAULT NULL,
  p_utm_medium       text DEFAULT NULL,
  p_utm_campaign     text DEFAULT NULL,
  p_utm_content      text DEFAULT NULL,
  p_is_test          boolean DEFAULT false
)
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

GRANT EXECUTE ON FUNCTION public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean
) TO anon, authenticated, service_role;
