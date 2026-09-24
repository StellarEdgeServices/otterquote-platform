-- gh-2154 P-5: Meta Lead Ads webhook — partner path only.
--
-- Adds a nullable, UNIQUE meta_lead_id text column to referral_agents (the
-- dedupe key for meta-leadgen-webhook: a re-delivered Meta webhook event for
-- the same leadgen_id must never create a second partner row), and extends
-- register_partner() with an additive trailing p_meta_lead_id parameter,
-- following the exact gh-846 / P-2 pattern already used twice on this
-- function: old signature DROPped explicitly, new signature CREATEd with
-- the new param appended DEFAULT NULL, function body otherwise
-- byte-identical to P-2's 20-arg definition
-- (20260924160000_gh2154_p2_partner_attribution_activation.sql).
--
-- meta_lead_id is nullable because register_partner() is also called by
-- P-1's browser signup flow and any other future caller that has no Meta
-- lead to attach — only meta-leadgen-webhook ever passes a non-null value.
-- UNIQUE (allowing multiple NULLs, standard Postgres unique-constraint
-- semantics) is the actual dedupe guarantee at the database level;
-- meta-leadgen-webhook's own isDuplicate() pre-check is a defense-in-depth
-- read, not the sole guard — a race between two concurrent deliveries of
-- the same leadgen_id is caught here as a unique_violation, surfaced to the
-- caller as 'duplicate_meta_lead' (never a raw constraint-name error, same
-- convention as the existing 'partner_exists' branch on the email unique
-- index).
--
-- PIN QUESTION (see this build's report): P-2's referral_agents_guard_
-- payout_columns() trigger pins fbclid/li_fat_id/funnel_id against partner
-- self-service UPDATE (RLS still allows an authenticated partner to UPDATE
-- their own row). meta_lead_id is attribution-shaped the same way, but this
-- migration does NOT touch that trigger — pinning it is left as an explicit
-- QUESTION for Kevin/Ben rather than an unreviewed change to a live guard
-- trigger bundled into this PR.
--
-- rate_limit_config: meta-leadgen-webhook calls check_rate_limit() (same
-- convention as record-lead-details / check-email-exists), so it needs a
-- config row or the RPC denies by default (fail-closed) on every call —
-- see gh1724's own note about exactly this trap.
--
-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260924210000_gh2154_p5_meta_lead_id_rollback.sql
-- — drops the 21-arg register_partner, recreates the pre-migration 20-arg
-- definition byte-identical to P-2's migration, drops the rate_limit_config
-- row, then drops meta_lead_id (which also drops its unique constraint).

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS meta_lead_id text UNIQUE;

-- Old 20-arg overload dropped explicitly (gh-846 / P-2 pattern) so the new
-- 21-arg signature never coexists with it.
DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean, text, text, text
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
  p_funnel_id        text DEFAULT NULL,
  p_meta_lead_id     text DEFAULT NULL
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
    COALESCE(p_is_test, false),
    v_agreement_version,
    now(),
    jsonb_build_object(
      v_agreement_version,
      jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', now())
    ),
    NULLIF(btrim(COALESCE(p_fbclid,    '')), ''),
    NULLIF(btrim(COALESCE(p_li_fat_id, '')), ''),
    NULLIF(btrim(COALESCE(p_funnel_id, '')), ''),
    NULLIF(btrim(COALESCE(p_meta_lead_id, '')), '')
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

-- No explicit GRANT here — same reasoning as P-2's migration: this
-- project's schema already runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public
-- GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`, so the
-- new function already has the same grants as the one it replaces with no
-- explicit GRANT line for CI's permissions-ratchet to flag.

INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('meta-leadgen-webhook', 120, 1000, 20000, true, 0.0000, 0.00,
   'gh2154 P-5: Meta Lead Ads webhook, partner path only. Keyed on a per-IP synthetic UUID (Meta''s own webhook delivery IPs, not an end user) since the caller is server-to-server with no real user_id. Rate-limits AFTER signature verification only, so a forged/unsigned request never reaches this check. Limits are a starting judgment call sized for webhook burst delivery, not human traffic -- raise if legitimate Meta delivery volume is ever throttled.')
ON CONFLICT (function_name) DO NOTHING;
