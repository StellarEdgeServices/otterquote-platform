-- gh-1983: persist first-touch ad attribution (UTM + fbclid/gclid) on
-- profiles and claims, so a signed contract traces back to the ad that
-- produced it. Requested-by exec:cro (#1982). Additive only: new nullable
-- columns, one new helper, one new SECURITY DEFINER RPC, one new BEFORE
-- INSERT trigger on claims. No existing column, policy, trigger or function
-- is altered or dropped. Rollback:
-- supabase/migrations_rollbacks/20260916024400_gh1983_first_touch_ad_attribution_rollback.sql
--
-- Semantics — "first TAGGED touch":
--   * The browser records a touch only when the landing URL carries at least
--     one of utm_source/medium/campaign/content/term, fbclid, gclid. Untagged
--     visits never create or overwrite the record (cookie oq_ft, 90 days,
--     Domain=.otterquote.com, set server-side by the Netlify edge function /
--     Next middleware, with a client-side fallback).
--   * record_first_touch_attribution() writes a profile ONCE (only while
--     profiles.first_touch_at IS NULL). A later touch never overwrites it.
--   * A touch that happened after the account was created (a returning user
--     clicking an ad months later) is refused: first_touch_at must be no
--     later than auth.users.created_at + 1 hour (clock-skew tolerance).
--   * Payload source order: the p_attr argument (browser cookie/localStorage),
--     else auth.users.raw_user_meta_data->'oq_attribution' (written by the
--     password signUp, so a confirmation link opened on another device or
--     browser still carries it).
--   * Claims inherit the owner's profile attribution at INSERT (trigger
--     below), and the RPC backfills any of the caller's claims still NULL.

-- 1. Columns -----------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS utm_source               text,
  ADD COLUMN IF NOT EXISTS utm_medium               text,
  ADD COLUMN IF NOT EXISTS utm_campaign             text,
  ADD COLUMN IF NOT EXISTS utm_content              text,
  ADD COLUMN IF NOT EXISTS utm_term                 text,
  ADD COLUMN IF NOT EXISTS fbclid                   text,
  ADD COLUMN IF NOT EXISTS gclid                    text,
  ADD COLUMN IF NOT EXISTS first_touch_landing_path text,
  ADD COLUMN IF NOT EXISTS first_touch_referrer     text,
  ADD COLUMN IF NOT EXISTS first_touch_at           timestamptz;

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS utm_source               text,
  ADD COLUMN IF NOT EXISTS utm_medium               text,
  ADD COLUMN IF NOT EXISTS utm_campaign             text,
  ADD COLUMN IF NOT EXISTS utm_content              text,
  ADD COLUMN IF NOT EXISTS utm_term                 text,
  ADD COLUMN IF NOT EXISTS fbclid                   text,
  ADD COLUMN IF NOT EXISTS gclid                    text,
  ADD COLUMN IF NOT EXISTS first_touch_landing_path text,
  ADD COLUMN IF NOT EXISTS first_touch_referrer     text,
  ADD COLUMN IF NOT EXISTS first_touch_at           timestamptz;

COMMENT ON COLUMN public.profiles.first_touch_at IS
  'gh-1983: time of the first TAGGED landing (utm_*/fbclid/gclid) before signup; NULL = no tagged touch recorded. Written once by record_first_touch_attribution().';
COMMENT ON COLUMN public.claims.first_touch_at IS
  'gh-1983: copied from the owner''s profiles row at claim INSERT (trg_claims_copy_first_touch) or backfilled by record_first_touch_attribution().';

-- 2. Sanitiser ------------------------------------------------------------------
-- Printable characters only, trimmed, capped at 255; empty -> NULL.
CREATE OR REPLACE FUNCTION public.gh1983_attr_clean(p text, p_max int DEFAULT 255)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT NULLIF(left(btrim(regexp_replace(COALESCE(p, ''), '[[:cntrl:]]', '', 'g')), p_max), '');
$$;

-- 3. The RPC --------------------------------------------------------------------
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
         fbclid                   = public.gh1983_attr_clean(v_attr->>'fbclid'),
         gclid                    = public.gh1983_attr_clean(v_attr->>'gclid'),
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

REVOKE ALL ON FUNCTION public.record_first_touch_attribution(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_first_touch_attribution(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_first_touch_attribution(jsonb) TO authenticated;

-- 4. Claims inherit at INSERT ------------------------------------------------------
-- Covers every claims insert site (React trade-selector, dashboard, repair
-- intake; static trade-selector.html, dashboard.html, repair-intake.html)
-- without touching any of them. Exception-safe: attribution bookkeeping must
-- never block a claim write.
CREATE OR REPLACE FUNCTION public.claims_copy_first_touch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_p public.profiles%ROWTYPE;
BEGIN
  IF NEW.first_touch_at IS NULL AND NEW.user_id IS NOT NULL THEN
    BEGIN
      SELECT * INTO v_p
        FROM public.profiles p
       WHERE p.id = NEW.user_id
         AND p.first_touch_at IS NOT NULL;
      IF FOUND THEN
        NEW.utm_source               := v_p.utm_source;
        NEW.utm_medium               := v_p.utm_medium;
        NEW.utm_campaign             := v_p.utm_campaign;
        NEW.utm_content              := v_p.utm_content;
        NEW.utm_term                 := v_p.utm_term;
        NEW.fbclid                   := v_p.fbclid;
        NEW.gclid                    := v_p.gclid;
        NEW.first_touch_landing_path := v_p.first_touch_landing_path;
        NEW.first_touch_referrer     := v_p.first_touch_referrer;
        NEW.first_touch_at           := v_p.first_touch_at;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'claims_copy_first_touch: skipped for claim % (%)', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.claims_copy_first_touch() FROM PUBLIC;

CREATE OR REPLACE TRIGGER trg_claims_copy_first_touch
  BEFORE INSERT ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.claims_copy_first_touch();
