-- gh-2155 HI-0b: partner-agreement.html bumps to v3-2026-09 (D-333 close-review
-- fix, Ben comment 5824245098 -- 878 IAC 1-2-2 no-referral-fee-for-home-
-- inspectors is already decided; this is the register_partner half).
--
-- CREATE OR REPLACE FUNCTION changing exactly one literal
-- (v_agreement_version CONSTANT text: 'v2-2026-08' -> 'v3-2026-09'), same
-- convention as 20260820195608_gh1075_partner_agreement_v2_version_bump.sql.
-- Every parameter, default, and line of the function body is byte-identical
-- to the LIVE prod definition on yeszghaspzwwstvsrioa, fetched via
-- pg_get_functiondef immediately before authoring this file (NOT the repo's
-- prior 17-arg copy at 20260820195608_..., which P-2/#2159 (PR #2159,
-- 20260924160000_gh2154_p2_partner_attribution_activation.sql) already
-- extended on prod to 20 args: + p_fbclid, p_li_fat_id, p_funnel_id).
-- Pre-flight live md5(pg_get_functiondef(oid)) = 6b44199b9850a1a5116780d95bdd7145
-- (first 8 hex chars, gh-2122 Credential Shape Sweep convention: 6b44199b),
-- proacl = {=X/postgres,postgres=X/postgres,anon=X/postgres,
-- authenticated=X/postgres,service_role=X/postgres}. CREATE OR REPLACE
-- preserves the function's existing ACL/owner, so no explicit GRANT/owner
-- statement is needed here (matches the #2159 rollback's own note).
--
-- Q for Ben (see PR body): stamped for ALL new acceptances (realtor,
-- insurance, home_inspector, adjuster, other), not just home_inspector,
-- because the v3-2026-09 agreement document is the SAME document every
-- track accepts -- realtor/insurance visible text is unchanged, only the
-- inspector track's client-side rendering (partner-agreement.html?track=
-- home_inspector) hides the fee table and the D-266 sentence and drops
-- "home inspectors" from the printed profession list. There is no
-- per-track register_partner variant to split this migration against.
--
-- Tier 3B (Dustin waived the window, #2155 comment 5821055164). READ-ONLY
-- verified against prod inside two aborted transactions (this session,
-- yeszghaspzwwstvsrioa) before authoring this file -- see the PR body for
-- both raw outputs (negative control on the CURRENT v2 function, positive
-- control on this exact forward body). This migration is NOT applied here;
-- Kevin's run-work orchestrator applies it after REVIEW + LEGAL-READ + R-177,
-- and only after this stacks on #2162 (P-1)/#2159 (P-2), per Ben's ordering
-- note in comment 5824245098.

CREATE OR REPLACE FUNCTION public.register_partner(p_agent_type text, p_first_name text, p_last_name text, p_email text, p_phone text DEFAULT NULL::text, p_company text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_service_area text DEFAULT NULL::text, p_referred_by_note text DEFAULT NULL::text, p_recruit_code text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_photo_url text DEFAULT NULL::text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text, p_utm_content text DEFAULT NULL::text, p_is_test boolean DEFAULT false, p_fbclid text DEFAULT NULL::text, p_li_fat_id text DEFAULT NULL::text, p_funnel_id text DEFAULT NULL::text)
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
  v_headers      jsonb;
  v_ip           text;
  v_ua           text;
  v_agreement_version CONSTANT text := 'v3-2026-09';
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

  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;
  v_ip := COALESCE(
    NULLIF(split_part(v_headers->>'x-forwarded-for', ',', 1), ''),
    v_headers->>'cf-connecting-ip',
    v_headers->>'x-real-ip'
  );
  v_ua := v_headers->>'user-agent';

  INSERT INTO referral_agents (
    agent_type, first_name, last_name, email, phone, company, website,
    service_area, photo_url, referred_by_note, metadata,
    recruited_by_id, recruited_at,
    utm_source, utm_medium, utm_campaign, utm_content, is_test,
    partner_agreement_version, partner_agreement_accepted_at,
    partner_agreement_attestation,
    fbclid, li_fat_id, funnel_id
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
    COALESCE(p_is_test, false),
    v_agreement_version,
    now(),
    jsonb_build_object(
      v_agreement_version,
      jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', now())
    ),
    NULLIF(btrim(COALESCE(p_fbclid,    '')), ''),
    NULLIF(btrim(COALESCE(p_li_fat_id, '')), ''),
    NULLIF(btrim(COALESCE(p_funnel_id, '')), '')
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
