-- Rollback for: gh2154_register_partner_rate_limit_fix.sql
-- GitHub: refs #2154
-- WARNING: restores the PRE-FIX behavior -- register_partner() goes back to
-- ONE global anon bucket (keyed by auth.uid(), NULL for every anonymous
-- caller), shared by ALL real signups AND all is_test/QA traffic. This is
-- the exact defect this fix closes (QA exhausted the shared 30/day cap on
-- 2026-09-26 and blocked every real partner signup platform-wide for the
-- rest of the UTC day) -- only run this rollback if the fix itself is found
-- to have broken something worse than that.
--
-- register_partner()'s body below is SEMANTICALLY IDENTICAL (comments
-- stripped) to the version pulled live via pg_get_functiondef() against
-- yeszghaspzwwstvsrioa immediately before this fix was authored (2026-09-26),
-- i.e. the gh-2154 P-5r / gh-2155 HI-0b version (service-role webhook bucket
-- + v3-2026-09 agreement + meta_lead_id handling) -- NOT gh973's original
-- single-bucket version, which predates several since-shipped fixes this
-- rollback must not silently undo. (D5, REVIEW FAIL 5850688286: this file
-- previously called itself "byte-identical", which was wrong once comments
-- were dropped -- corrected here to "semantically identical (comments
-- stripped)"; the CONSTRAINT_NAME/hash comparison in the review's own
-- verification, 41233bc9d29429bbeb1a4bff9af91e4a, is unaffected -- only the
-- wording of this comment changed.)
--
-- Nothing in the current forward migration creates a pg_cron job or a
-- standalone alert-reconciler function (D2, REVIEW FAIL 5850688286: that
-- design was replaced with a check inside supabase/functions/
-- platform-health-check/index.ts's existing fireAlert() path before this
-- PR was re-reviewed), so there is nothing of that shape to unschedule or
-- drop here. Reverting the platform-health-check Edge Function's added
-- alert checks is a plain code revert of that file, not part of this SQL
-- rollback.

BEGIN;

CREATE OR REPLACE FUNCTION public.register_partner(p_agent_type text, p_first_name text, p_last_name text, p_email text, p_phone text DEFAULT NULL::text, p_company text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_service_area text DEFAULT NULL::text, p_referred_by_note text DEFAULT NULL::text, p_recruit_code text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_photo_url text DEFAULT NULL::text, p_utm_source text DEFAULT NULL::text, p_utm_medium text DEFAULT NULL::text, p_utm_campaign text DEFAULT NULL::text, p_utm_content text DEFAULT NULL::text, p_is_test boolean DEFAULT false, p_fbclid text DEFAULT NULL::text, p_li_fat_id text DEFAULT NULL::text, p_funnel_id text DEFAULT NULL::text, p_meta_lead_id text DEFAULT NULL::text)
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
  v_is_test      boolean;
  v_is_service_role boolean;
  v_meta_lead_id text;
  v_status       text;
  v_agreement_version_to_write text;
  v_agreement_accepted_at      timestamptz;
  v_agreement_attestation      jsonb;
  v_agreement_version CONSTANT text := 'v3-2026-09';
BEGIN
  v_is_service_role := COALESCE(auth.role() = 'service_role', false);

  v_rate := public.check_rate_limit(
    p_function_name => CASE WHEN v_is_service_role THEN 'register_partner_service_role' ELSE 'register_partner' END,
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

  v_is_test := public.is_test_email(v_email)
               OR (COALESCE(p_is_test, false)
                   AND COALESCE(auth.role() = 'service_role', false));

  v_meta_lead_id := CASE WHEN v_is_service_role
                         THEN NULLIF(btrim(COALESCE(p_meta_lead_id, '')), '')
                         ELSE NULL
                    END;

  v_status := CASE WHEN v_is_service_role THEN 'pending' ELSE 'active' END;
  v_agreement_version_to_write := CASE WHEN v_is_service_role THEN NULL ELSE v_agreement_version END;
  v_agreement_accepted_at      := CASE WHEN v_is_service_role THEN NULL ELSE now() END;
  v_agreement_attestation      := CASE WHEN v_is_service_role THEN '{}'::jsonb ELSE
    jsonb_build_object(
      v_agreement_version,
      jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', now())
    )
  END;

  INSERT INTO referral_agents (
    agent_type, first_name, last_name, email, phone, company, website,
    service_area, photo_url, referred_by_note, metadata,
    recruited_by_id, recruited_at,
    utm_source, utm_medium, utm_campaign, utm_content, is_test,
    status,
    partner_agreement_version, partner_agreement_accepted_at,
    partner_agreement_attestation,
    fbclid, li_fat_id, funnel_id, meta_lead_id
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
    v_is_test,
    v_status,
    v_agreement_version_to_write,
    v_agreement_accepted_at,
    v_agreement_attestation,
    NULLIF(btrim(COALESCE(p_fbclid,    '')), ''),
    NULLIF(btrim(COALESCE(p_li_fat_id, '')), ''),
    NULLIF(btrim(COALESCE(p_funnel_id, '')), ''),
    v_meta_lead_id
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
    ELSIF v_constraint = 'referral_agents_meta_lead_id_key' THEN
      RAISE EXCEPTION 'duplicate_meta_lead';
    END IF;
    RAISE;
END;
$function$;

-- Restore the pre-fix single-bucket config row. Note: this is a rolling
-- 24h window (check_rate_limit() uses now() - interval '1 day'), NOT a
-- fixed reset "until 00:00 UTC" -- D5 also corrects that wording in the PR
-- body; it was never a property of the SQL itself.
UPDATE public.rate_limit_config
   SET max_per_hour = 10,
       max_per_day = 30,
       max_per_month = 300,
       notes = 'gh973: partner self-serve signup RPC (#571/v95 family, sibling of track_referral_click). Rate-limit gate added to close unbounded-registration abuse vector (no config row existed before this migration). Limits are a starting judgment call, not traffic-validated - raise if legitimate signup volume is ever throttled.'
 WHERE function_name = 'register_partner';

-- Remove the two new buckets this fix introduced.
DELETE FROM public.rate_limit_config WHERE function_name = 'register_partner_test';
DELETE FROM public.rate_limit_config WHERE function_name = 'register_partner_global';

-- Drop the per-client key helper -- nothing else references it once
-- register_partner() no longer calls it. (The Vault secret
-- 'rate_limit_ip_salt' is intentionally left in place -- it is inert once
-- nothing reads it, and deleting Vault secrets from an automated rollback
-- is unnecessary risk for zero benefit.)
DROP FUNCTION IF EXISTS public.rate_limit_client_key(text);

COMMIT;
