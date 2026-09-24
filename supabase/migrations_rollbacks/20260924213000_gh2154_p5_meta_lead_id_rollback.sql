-- Rollback for 20260924213000_gh2154_p5_meta_lead_id.sql
--
-- Order matters: drop the 21-arg register_partner FIRST, recreate the
-- pre-migration 20-arg definition (byte-identical to
-- 20260924160000_gh2154_p2_partner_attribution_activation.sql, md5 first-8
-- = 6b44199b, confirmed live before this migration was authored) SECOND,
-- remove the rate_limit_config row THIRD, restore
-- referral_agents_guard_payout_columns() to its exact pre-migration body
-- (md5 first-8 = 81c6af22, i.e. the meta_lead_id clause removed) FOURTH,
-- drop meta_lead_id FIFTH — dropping the column while either the 21-arg
-- register_partner or the meta_lead_id-referencing guard clause still
-- exists would break both — and only THEN drop public.is_test_email()
-- LAST (the P-5 should-fix server-side is_test derivation helper; the
-- restored 20-arg register_partner above no longer calls it, same as it
-- never did pre-migration).

DELETE FROM public.rate_limit_config WHERE function_name = 'meta-leadgen-webhook';

DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean, text, text, text, text
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

-- Restore the guard trigger to its exact pre-P-5 (post-P-2 live) body --
-- md5(pg_get_functiondef(...)) first 8 hex = 81c6af22 -- BEFORE dropping
-- meta_lead_id below, same ordering reasoning P-2's own rollback used for
-- this same function.
CREATE OR REPLACE FUNCTION public.referral_agents_guard_payout_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if is_admin_email() then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    -- Defense in depth only: register_partner() (SECURITY DEFINER) never sets these on insert
    -- and bypasses table grants/RLS entirely, so this branch only matters if some future path
    -- inserts directly. recruited_at/recruited_by_id/status/is_test are deliberately NOT forced
    -- here -- register_partner() legitimately sets recruited_at/recruited_by_id for the
    -- recruiter-linking flow (always now(), never caller-backdated), and forcing them would
    -- break that flow.
    new.payments_blocked           := true;
    new.w9_verified_at             := null;
    new.w9_file_url                := null;
    new.w9_submitted_at            := null;
    new.total_commission_earned    := 0;
    new.total_commission_paid      := 0;
    new.recruit_earnings           := 0;
    return new;
  end if;

  -- gh-2154 column lock: attribution can never change post-insert except by
  -- service_role/admin (already returned above); activation timestamp can
  -- only move NULL -> NOT NULL, and only through record_partner_app_activation().
  --
  -- REVIEW FAIL 5819691427 (three-valued-logic fail-open): current_setting(x,
  -- true) returns SQL NULL, not '', on any backend where this GUC has never
  -- been set in that session/connection -- so `... = '1'` evaluates to NULL,
  -- `not (NULL and ...)` is NULL, and the whole allow-clause's negation is
  -- NULL. `if NULL then raise` never raises: plpgsql's IF only branches into
  -- THEN on a true boolean, so a NULL condition silently falls through as if
  -- it were false, and a partner on a fresh PostgREST/Supavisor backend
  -- (which is most of them) could PATCH their own unactivated
  -- app_first_signed_in_launch_at straight past this guard. Fixed two ways,
  -- belt and braces, so a NULL here can never again mean "allowed": (1) the
  -- GUC read itself is coalesced to '' so `= '1'` is always a real boolean,
  -- never NULL; (2) the entire allow-clause is wrapped in
  -- coalesce(..., true), so if any future edit reintroduces a NULL-producing
  -- expression here, the guard fails CLOSED (raises) instead of failing
  -- open. Proof: supabase/tests/gh2154_p2_proof.sql, top of the column-lock
  -- section.
  if coalesce(
       (new.fbclid    is distinct from old.fbclid)
       or (new.li_fat_id is distinct from old.li_fat_id)
       or (new.funnel_id is distinct from old.funnel_id)
       or (
         (new.app_first_signed_in_launch_at is distinct from old.app_first_signed_in_launch_at)
         and not (
           coalesce(current_setting('oq.gh2154_activation_write', true), '') = '1'
           and old.app_first_signed_in_launch_at is null
           and new.app_first_signed_in_launch_at is not null
         )
       ),
       true
     )
  then
    raise exception
      'referral_agents: attribution/activation columns can only be changed by service_role, an admin, or record_partner_app_activation() (gh-2154)'
      using errcode = '42501';
  end if;

  -- UPDATE: pin every payout-governing / compliance column to its stored value.
  if (new.payments_blocked           is distinct from old.payments_blocked)
     or (new.w9_verified_at          is distinct from old.w9_verified_at)
     or (new.w9_file_url             is distinct from old.w9_file_url)
     or (new.w9_submitted_at         is distinct from old.w9_submitted_at)
     or (new.recruited_at            is distinct from old.recruited_at)
     or (new.recruited_by_id         is distinct from old.recruited_by_id)
     or (new.total_commission_earned is distinct from old.total_commission_earned)
     or (new.total_commission_paid   is distinct from old.total_commission_paid)
     or (new.recruit_earnings        is distinct from old.recruit_earnings)
     or (new.status                  is distinct from old.status)
     or (new.is_test                 is distinct from old.is_test)
  then
    raise exception
      'referral_agents: payout-governing columns can only be changed by service_role or an admin (gh-886)'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

ALTER TABLE public.referral_agents
  DROP COLUMN IF EXISTS meta_lead_id;

DROP FUNCTION IF EXISTS public.is_test_email(text);
