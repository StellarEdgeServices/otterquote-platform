-- gh-3002: record the first touch of UNTAGGED visits too (landing path +
-- referrer host), so organic signups trace to the page they entered on.
-- Requested-by exec:cro (Sloane). Rollback:
-- supabase/migrations_rollbacks/20261023150000_gh3002_first_touch_untagged_rollback.sql
--
-- Root cause (measured 2026-10-23, prod): #1983 recorded a touch only when the
-- landing URL carried utm_*/fbclid/gclid ("first TAGGED touch"), in three
-- places: the browser parse, the edge/middleware cookie, and this RPC
-- ('no_tagged_touch'). Organic traffic therefore never produced a record, and
-- 24 of 25 non-test signups since 2026-09-16 have first_touch_landing_path NULL.
-- The one non-null row is a utm_source=chatgpt.com landing, i.e. capture works
-- for tagged touches and nothing else was ever attempted.
--
-- Semantics after this migration:
--   * A payload is usable if it is TAGGED (any tracked key) or carries a
--     landing_path. Tagged payloads are preferred (client, then user_metadata),
--     then untagged ones.
--   * Profile is written once (first_touch_at IS NULL) and NEVER overwritten,
--     tagged or not (same as #1983). Consequence: a visitor whose first page
--     was organic and who later clicks an ad is not re-credited to the ad.
--   * Claims backfill only where first_touch_at IS NULL (unchanged).
--   * The "touch must precede the account (+1 h)" rule is unchanged.
-- Additive: CREATE OR REPLACE of one function, two new helpers. No column,
-- policy or trigger is touched. claims_copy_first_touch already copies any row
-- whose profile first_touch_at IS NOT NULL, so untagged touches flow to claims.

CREATE OR REPLACE FUNCTION public.gh3002_attr_is_tagged(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'object' AND (
    public.gh1983_attr_clean(p->>'utm_source')   IS NOT NULL OR
    public.gh1983_attr_clean(p->>'utm_medium')   IS NOT NULL OR
    public.gh1983_attr_clean(p->>'utm_campaign') IS NOT NULL OR
    public.gh1983_attr_clean(p->>'utm_content')  IS NOT NULL OR
    public.gh1983_attr_clean(p->>'utm_term')     IS NOT NULL OR
    public.gh1983_attr_clean(p->>'fbclid')       IS NOT NULL OR
    public.gh1983_attr_clean(p->>'gclid')        IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION public.gh3002_attr_has_path(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'object'
     AND public.gh1983_attr_clean(p->>'landing_path') IS NOT NULL;
$$;

-- Default privileges grant EXECUTE to anon/authenticated explicitly.
REVOKE ALL ON FUNCTION public.gh3002_attr_is_tagged(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gh3002_attr_has_path(jsonb)  FROM PUBLIC, anon, authenticated;

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
  v_tagged      boolean;
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

  -- Prefer a tagged payload (browser, then user_metadata); else any payload
  -- that at least names a landing path.
  IF public.gh3002_attr_is_tagged(p_attr) THEN
    v_attr := p_attr; v_source := 'client'; v_tagged := true;
  ELSIF public.gh3002_attr_is_tagged(v_meta) THEN
    v_attr := v_meta; v_source := 'user_metadata'; v_tagged := true;
  ELSIF public.gh3002_attr_has_path(p_attr) THEN
    v_attr := p_attr; v_source := 'client'; v_tagged := false;
  ELSIF public.gh3002_attr_has_path(v_meta) THEN
    v_attr := v_meta; v_source := 'user_metadata'; v_tagged := false;
  ELSE
    RETURN jsonb_build_object('recorded', false, 'reason', 'no_touch');
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
    'tagged', v_tagged,
    'claims_backfilled', v_claims_n
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_first_touch_attribution(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_first_touch_attribution(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_first_touch_attribution(jsonb) TO authenticated;
