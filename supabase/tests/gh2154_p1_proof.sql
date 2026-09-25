-- gh-2154 P-1 proof script.
--
-- Run the WHOLE file as one statement batch wrapped in BEGIN ... ROLLBACK
-- against production (yeszghaspzwwstvsrioa). Never COMMIT.
--
-- P-1 (short partner signup) has NOT been built yet at the time this file
-- is authored (Ben's bus ruling 2026-09-24T16:25:47Z on #2154: write P-1's
-- working test now, do not start P-1 code until PR #2159 / P-2 merges).
-- This proof therefore assumes P-2 is already applied to the target
-- database (it inlines P-2's migration first, exactly as
-- supabase/tests/gh2154_p2_proof.sql does, so this file can be run
-- standalone against a database that has not yet had P-2 applied either).
-- P-1 itself adds no new schema -- it only changes which of
-- register_partner's already-existing (post-P-2) parameters a short
-- 4-field form actually populates. So this proof calls TODAY's (post-P-2)
-- register_partner with only the fields the P-1 short form will collect
-- (first/last name, email, phone, company, agent_type) plus the three
-- P-2 attribution params, and asserts the resulting row. It is not
-- expected to fail once P-2 is applied -- it exists so the P-1 builder
-- has a green baseline to diff against and so this task's "write P-1's
-- test now" instruction produces something runnable today, not just the
-- JS test.
--
-- Everything this script writes is rolled back by the ROLLBACK that must
-- follow it -- no synthetic row may be left behind.

-- ── 1. Apply P-2's migration inline (idempotent CREATE/ALTER) ──────────
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS fbclid text,
  ADD COLUMN IF NOT EXISTS li_fat_id text,
  ADD COLUMN IF NOT EXISTS funnel_id text,
  ADD COLUMN IF NOT EXISTS app_first_signed_in_launch_at timestamptz;

DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean
);

CREATE OR REPLACE FUNCTION public.register_partner(
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
  p_is_test          boolean DEFAULT false,
  p_fbclid           text DEFAULT NULL,
  p_li_fat_id        text DEFAULT NULL,
  p_funnel_id        text DEFAULT NULL
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
  v_rate         jsonb;
  v_headers      jsonb;
  v_ip           text;
  v_ua           text;
  v_agreement_version CONSTANT text := 'v2-2026-08';
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

-- ── 2. Assertions ────────────────────────────────────────────────────────
DO $proof$
DECLARE
  v_failures    text[] := '{}';
  v_result      jsonb;
  v_row_re      referral_agents%ROWTYPE;
  v_row_ins     referral_agents%ROWTYPE;
  v_row_insp    referral_agents%ROWTYPE;
  v_count       int;
  v_raised      boolean := false;
BEGIN
  -- (a) A short-form-shaped call (first/last name, email, phone, company,
  -- agent_type, plus the three P-2 attribution params, is_test=true)
  -- creates exactly one referral_agents row, correctly flagged.
  v_result := public.register_partner(
    p_agent_type => 're_agent',
    p_first_name => 'GH2154P1',
    p_last_name  => 'ProofRe',
    p_email      => 'gh2154-p1-proof-re@example.invalid',
    p_phone      => '3175551111',
    p_company    => 'Proof Realty Co',
    p_is_test    => true,
    p_fbclid     => 'fb.p1.proof',
    p_li_fat_id  => 'li.p1.proof',
    p_funnel_id  => 're-1'
  );
  SELECT count(*) INTO v_count
  FROM referral_agents
  WHERE email = 'gh2154-p1-proof-re@example.invalid';
  IF v_count <> 1 THEN
    v_failures := array_append(v_failures, format('expected exactly 1 referral_agents row for the short-form re_agent call, found %s', v_count));
  END IF;

  SELECT * INTO v_row_re FROM referral_agents WHERE id = (v_result->>'id')::uuid;
  IF v_row_re.is_test IS DISTINCT FROM true THEN
    v_failures := array_append(v_failures, 'short-form call: is_test was not stored as true');
  END IF;
  IF v_row_re.fbclid IS DISTINCT FROM 'fb.p1.proof' THEN
    v_failures := array_append(v_failures, 'short-form call: fbclid was not stored as supplied');
  END IF;
  IF v_row_re.funnel_id IS DISTINCT FROM 're-1' THEN
    v_failures := array_append(v_failures, 'short-form call: funnel_id was not stored as ''re-1''');
  END IF;
  IF v_row_re.agent_type IS DISTINCT FROM 're_agent' THEN
    v_failures := array_append(v_failures, 'short-form call: agent_type was not stored as re_agent');
  END IF;

  -- (b) Same shape for insurance_agent and home_inspector -- each of the
  -- three P-1 partner types can register through the same short call.
  v_result := public.register_partner(
    p_agent_type => 'insurance_agent',
    p_first_name => 'GH2154P1',
    p_last_name  => 'ProofIns',
    p_email      => 'gh2154-p1-proof-ins@example.invalid',
    p_phone      => '3175552222',
    p_company    => 'Proof Insurance Co',
    p_is_test    => true,
    p_funnel_id  => 're-1'
  );
  SELECT * INTO v_row_ins FROM referral_agents WHERE id = (v_result->>'id')::uuid;
  IF v_row_ins.agent_type IS DISTINCT FROM 'insurance_agent' THEN
    v_failures := array_append(v_failures, 'short-form call: insurance_agent row has the wrong agent_type');
  END IF;

  v_result := public.register_partner(
    p_agent_type => 'home_inspector',
    p_first_name => 'GH2154P1',
    p_last_name  => 'ProofInsp',
    p_email      => 'gh2154-p1-proof-insp@example.invalid',
    p_phone      => '3175553333',
    p_company    => 'Proof Inspections Co',
    p_is_test    => true,
    p_funnel_id  => 're-1'
  );
  SELECT * INTO v_row_insp FROM referral_agents WHERE id = (v_result->>'id')::uuid;
  IF v_row_insp.agent_type IS DISTINCT FROM 'home_inspector' THEN
    v_failures := array_append(v_failures, 'short-form call: home_inspector row has the wrong agent_type');
  END IF;

  -- (c) NEGATIVE CONTROL: an invalid agent_type raises and writes zero rows.
  BEGIN
    v_raised := false;
    PERFORM public.register_partner(
      p_agent_type => 'bogus',
      p_first_name => 'GH2154P1',
      p_last_name  => 'ProofBogus',
      p_email      => 'gh2154-p1-proof-bogus@example.invalid',
      p_phone      => '3175554444',
      p_company    => 'Should Never Exist LLC',
      p_is_test    => true,
      p_funnel_id  => 're-1'
    );
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    IF SQLERRM NOT LIKE 'invalid_agent_type%' THEN
      v_failures := array_append(v_failures, format('NEGATIVE CONTROL: expected invalid_agent_type exception, got: %s', SQLERRM));
    END IF;
  END;
  IF NOT v_raised THEN
    v_failures := array_append(v_failures, 'NEGATIVE CONTROL FAILED: agent_type=''bogus'' did not raise');
  END IF;
  SELECT count(*) INTO v_count FROM referral_agents WHERE email = 'gh2154-p1-proof-bogus@example.invalid';
  IF v_count <> 0 THEN
    v_failures := array_append(v_failures, format('NEGATIVE CONTROL FAILED: agent_type=''bogus'' wrote %s row(s), expected 0', v_count));
  END IF;

  -- ── Verdict ──
  IF array_length(v_failures, 1) IS NULL THEN
    RAISE NOTICE 'GH2154_P1_PROOF: ALL ASSERTIONS PASSED';
  ELSE
    RAISE EXCEPTION 'GH2154_P1_PROOF: % FAILURE(S): %', array_length(v_failures, 1), array_to_string(v_failures, ' | ');
  END IF;
END;
$proof$;

-- This script never COMMITs. The caller must issue ROLLBACK immediately
-- after, whether the DO block above raised or not, and then read back that
-- no synthetic row persisted.
