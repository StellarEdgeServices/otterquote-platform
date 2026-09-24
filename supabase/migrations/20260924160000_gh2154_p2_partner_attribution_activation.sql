-- gh-2154 P-2: partner attribution columns + first signed-in standalone app launch.
--
-- Parent: #2154 (D-333 shared partner foundation, build item P-2, Marty's
-- build-sequence comment 5816579743). referral_agents already carries
-- utm_source/medium/campaign/content (gh-846) but has nowhere to put a
-- Facebook click id, a LinkedIn first-party ad click id, or a funnel
-- identifier, and no way to know when a partner first opens the installed
-- PWA while signed in. P-1's short signup form (later item, not built here)
-- needs fbclid/li_fat_id/funnel_id to exist on the table before it can write
-- them; P-4's onboarding-sequence stop condition (later item) needs the
-- activation timestamp to exist before it can check it.
--
-- Tier: 3A additive migration, per Marty's sequencing comment. Confirmed
-- live and read-only against production (yeszghaspzwwstvsrioa) before
-- authoring this file: referral_agents has no fbclid/li_fat_id/funnel_id/
-- activation-timestamp column, register_partner's only live overload is
-- byte-identical to the definition in
-- 20260820195608_gh1075_partner_agreement_v2_version_bump.sql (17 args,
-- ending p_is_test), and no record_partner_app_activation function exists.
--
-- Follows the gh-846 precedent (20260814110108_gh846_add_utm_columns_to_
-- referral_agents.sql): additive nullable columns, then register_partner's
-- signature grows by additive trailing DEFAULT NULL params, with the old
-- overload dropped explicitly so PostgREST never has to disambiguate two
-- overlapping signatures. register_partner's function body is otherwise
-- byte-identical to the live definition; only the INSERT column/value lists
-- and the parameter list change. PUBLIC keeps its existing default EXECUTE
-- (unchanged from every prior register_partner revision, none of which have
-- ever revoked it); anon/authenticated/service_role are re-granted
-- explicitly, matching the live grant this migration replaces.
--
-- record_partner_app_activation() is new: SECURITY DEFINER, first-write-wins
-- (only writes when the column is still NULL), scoped to the caller's own
-- referral_agents row via auth.uid() = user_id, so no partner can write
-- another partner's row and a signed-out caller (auth.uid() IS NULL) can
-- never match any row. EXECUTE is revoked from PUBLIC and anon and granted
-- only to authenticated, matching this project's "new function defaults to
-- anon/authenticated/service_role EXECUTE" trap (Claude's Memories
-- supabase-function-grant-defaults.md) — this one intentionally has no
-- anon or service_role access, since only a signed-in partner should ever
-- call it and there is no server-side caller.
--
-- ROLLBACK NOTE (kept in-comment, not a separate file, per this task's file
-- whitelist): to undo this migration, in this order --
--   1. DROP FUNCTION public.record_partner_app_activation();
--   2. DROP FUNCTION public.register_partner(text, text, text, text, text,
--      text, text, text, text, text, jsonb, text, text, text, text, text,
--      boolean, text, text, text);
--   3. Recreate the prior 17-arg register_partner: CREATE FUNCTION with the
--      exact signature and body from
--      20260820195608_gh1075_partner_agreement_v2_version_bump.sql (byte-
--      identical to what was live before this migration), then
--      GRANT EXECUTE ON FUNCTION public.register_partner(text, text, text,
--      text, text, text, text, text, text, text, jsonb, text, text, text,
--      text, text, boolean) TO anon, authenticated, service_role;
--   4. ALTER TABLE public.referral_agents DROP COLUMN IF EXISTS fbclid,
--      DROP COLUMN IF EXISTS li_fat_id, DROP COLUMN IF EXISTS funnel_id,
--      DROP COLUMN IF EXISTS app_first_signed_in_launch_at;
-- Safe because every new column is nullable and no other object references
-- them yet (P-1/P-4, which will, are not built).

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS fbclid text,
  ADD COLUMN IF NOT EXISTS li_fat_id text,
  ADD COLUMN IF NOT EXISTS funnel_id text,
  ADD COLUMN IF NOT EXISTS app_first_signed_in_launch_at timestamptz;

-- Old 17-arg overload dropped explicitly (gh-846 pattern) so the new
-- 20-arg signature never coexists with it.
DROP FUNCTION IF EXISTS public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean
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

GRANT EXECUTE ON FUNCTION public.register_partner(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, text, text, boolean, text, text, text
) TO anon, authenticated, service_role;

-- record_partner_app_activation(): first signed-in standalone launch of the
-- installed partner app. Called from partner-app.html / partner-dashboard.html
-- once display-mode:standalone (or ?source=pwa) is detected and a session is
-- signed in. First-write-wins via the `IS NULL` guard (idempotent — a second
-- call is a harmless no-op), and scoped to the caller's own row via
-- `user_id = auth.uid()` so no partner can ever write another partner's
-- timestamp. Returns whether this call was the one that wrote it.
CREATE FUNCTION public.record_partner_app_activation()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wrote boolean;
BEGIN
  UPDATE public.referral_agents
  SET app_first_signed_in_launch_at = now()
  WHERE user_id = auth.uid()
    AND app_first_signed_in_launch_at IS NULL;

  v_wrote := FOUND;
  RETURN v_wrote;
END;
$function$;

-- Supabase's default is EXECUTE for anon/authenticated/service_role on every
-- new public function (Claude's Memories supabase-function-grant-defaults.md)
-- -- explicitly revoke before granting only what this RPC should ever have.
REVOKE ALL ON FUNCTION public.record_partner_app_activation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_partner_app_activation() FROM anon;
REVOKE ALL ON FUNCTION public.record_partner_app_activation() FROM service_role;
GRANT EXECUTE ON FUNCTION public.record_partner_app_activation() TO authenticated;
