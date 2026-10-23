-- Rollback for supabase/migrations_drafts/gh3002_first_touch_untagged.sql (gh-3002).
-- Restores the gh-1983 tagged-only record_first_touch_attribution() body and
-- drops the two helpers. No data is lost: rows already written keep their
-- (now untagged) first_touch_* values, which are valid columns either way.
BEGIN;
CREATE OR REPLACE FUNCTION public.record_first_touch_attribution(p_attr jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_user_created timestamptz;
  v_meta        jsonb;
  v_attr        jsonb;
  v_source      text;
  v_ts          timestamptz;
  v_profile_n   int := 0;
  v_claims_n    int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'no_session');
  END IF;

  SELECT u.created_at, u.raw_user_meta_data->'oq_attribution'
    INTO v_user_created, v_meta
    FROM auth.users u
   WHERE u.id = v_uid;

  -- Pick the first payload that carries at least one tracked key.
  IF p_attr IS NOT NULL AND jsonb_typeof(p_attr) = 'object' AND (
       public.gh1983_attr_clean(p_attr->>'utm_source')   IS NOT NULL OR
       public.gh1983_attr_clean(p_attr->>'utm_medium')   IS NOT NULL OR
       public.gh1983_attr_clean(p_attr->>'utm_campaign') IS NOT NULL OR
       public.gh1983_attr_clean(p_attr->>'utm_content')  IS NOT NULL OR
       public.gh1983_attr_clean(p_attr->>'utm_term')     IS NOT NULL OR
       public.gh1983_attr_clean(p_attr->>'fbclid')       IS NOT NULL OR
       public.gh1983_attr_clean(p_attr->>'gclid')        IS NOT NULL) THEN
    v_attr := p_attr; v_source := 'client';
  ELSIF v_meta IS NOT NULL AND jsonb_typeof(v_meta) = 'object' AND (
       public.gh1983_attr_clean(v_meta->>'utm_source')   IS NOT NULL OR
       public.gh1983_attr_clean(v_meta->>'utm_medium')   IS NOT NULL OR
       public.gh1983_attr_clean(v_meta->>'utm_campaign') IS NOT NULL OR
       public.gh1983_attr_clean(v_meta->>'utm_content')  IS NOT NULL OR
       public.gh1983_attr_clean(v_meta->>'utm_term')     IS NOT NULL OR
       public.gh1983_attr_clean(v_meta->>'fbclid')       IS NOT NULL OR
       public.gh1983_attr_clean(v_meta->>'gclid')        IS NOT NULL) THEN
    v_attr := v_meta; v_source := 'user_metadata';
  ELSE
    RETURN jsonb_build_object('recorded', false, 'reason', 'no_tagged_touch');
  END IF;

  -- Touch timestamp: trusted only inside [now()-100 days, now()]; else now().
  BEGIN
    v_ts := (v_attr->>'ts')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_ts := NULL;
  END;
  IF v_ts IS NULL OR v_ts > now() OR v_ts < now() - interval '100 days' THEN
    v_ts := now();
  END IF;

  -- First touch must precede the account (1 h skew tolerance).
  IF v_user_created IS NOT NULL AND v_ts > v_user_created + interval '1 hour' THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'touch_after_signup');
  END IF;

  UPDATE public.profiles p
     SET utm_source               = public.gh1983_attr_clean(v_attr->>'utm_source'),
         utm_medium               = public.gh1983_attr_clean(v_attr->>'utm_medium'),
         utm_campaign             = public.gh1983_attr_clean(v_attr->>'utm_campaign'),
         utm_content              = public.gh1983_attr_clean(v_attr->>'utm_content'),
         utm_term                 = public.gh1983_attr_clean(v_attr->>'utm_term'),
         fbclid                   = public.gh1983_attr_clean(v_attr->>'fbclid', 1000),
         gclid                    = public.gh1983_attr_clean(v_attr->>'gclid', 1000),
         first_touch_landing_path = public.gh1983_attr_clean(v_attr->>'landing_path'),
         first_touch_referrer     = public.gh1983_attr_clean(v_attr->>'referrer'),
         first_touch_at           = v_ts
   WHERE p.id = v_uid
     AND p.first_touch_at IS NULL;
  GET DIAGNOSTICS v_profile_n = ROW_COUNT;

  -- Backfill the caller's claims that have no attribution yet, from whatever
  -- the profile now holds (this run's write or an earlier one).
  UPDATE public.claims c
     SET utm_source               = p.utm_source,
         utm_medium               = p.utm_medium,
         utm_campaign             = p.utm_campaign,
         utm_content              = p.utm_content,
         utm_term                 = p.utm_term,
         fbclid                   = p.fbclid,
         gclid                    = p.gclid,
         first_touch_landing_path = p.first_touch_landing_path,
         first_touch_referrer     = p.first_touch_referrer,
         first_touch_at           = p.first_touch_at
    FROM public.profiles p
   WHERE p.id = v_uid
     AND p.first_touch_at IS NOT NULL
     AND c.user_id = v_uid
     AND c.first_touch_at IS NULL;
  GET DIAGNOSTICS v_claims_n = ROW_COUNT;

  RETURN jsonb_build_object(
    'recorded', v_profile_n > 0,
    'reason', CASE WHEN v_profile_n > 0 THEN 'recorded' ELSE 'already_recorded_or_no_profile' END,
    'source', v_source,
    'claims_backfilled', v_claims_n
  );
END;
$$;

-- Privileges on record_first_touch_attribution are untouched (CREATE OR REPLACE keeps them).

DROP FUNCTION IF EXISTS public.gh3002_attr_is_tagged(jsonb);
DROP FUNCTION IF EXISTS public.gh3002_attr_has_path(jsonb);
COMMIT;
