-- STATUS (gh-1438, as of 2026-10-30T13:30:00Z): NOT APPLIED
-- EVIDENCE: drafted 2026-10-30 under #3232 (P18 routing). Read-only production reads the same day (yeszghaspzwwstvsrioa): public.resolve_partner_slug does not exist; referral_agents.status holds only 'active' (74) and 'pending' (1) and there is no separate suspended column, so "active, not suspended" is status = 'active'; the P18 data layer (vanity_slug, reserved_slugs, p18_slug_is_reserved, referral_agent_slug_history) from PR #3223 is itself NOT APPLIED, so THIS FILE CANNOT RUN until #3223 is applied.
-- REPO COPY: none (draft). Rollback: p18_resolve_partner_slug_rollback.sql. Tier 3A (one new read-only function, no table change), but it is granted to anon, so REVIEW first.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- P18: resolve_partner_slug(p) -- the lookup behind the /<slug> edge function (netlify/edge-functions/vanity-redirect.ts).
-- Returns ONLY the partner's unique_code (so the caller redirects to /ref/<code> and credits exactly as /ref does), or NULL.
--
-- Resolution order:
--   1. the CURRENT holder of the slug (lower(vanity_slug) = lower(p)). If that partner's status is 'active' return unique_code;
--      if the holder is not active (pending / suspended / anything else) return NULL. A non-active current holder does NOT fall
--      through to history: the slug is still theirs, and a suspended partner's link must not credit them via the back door.
--   2. otherwise the NEWEST history row (retired_at DESC, id DESC) for that slug whose retired_at is inside the window. The row's
--      partner must be 'active' too, else NULL (the newest row decides; an older active partner's row is not used).
--      The window is platform_settings.partner_attribution_window_days, 90 when absent or not a whole number of days 1-3650:
--      the same expression as set_partner_slug() (#3223) and referral_attribution_window() (#3226).
-- NULL for: NULL input, malformed input (not ^[a-z0-9]+(-[a-z0-9]+)*$ after lower(), not 3-30 chars, all digits), and reserved
-- names (p18_slug_is_reserved: a reserved_slugs row or the `home-` prefix). Case-insensitive.
--
-- SECURITY DEFINER, search_path pinned. anon may execute it (the edge function calls it with the public publishable key); it
-- exposes only unique_code for a slug the caller already knows, which is what visiting /ref/<code> exposes anyway.

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_partner_slug(p text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  s       text;
  v_days  int;
  v_found boolean;
  v_code  text;
  v_stat  text;
BEGIN
  IF p IS NULL THEN
    RETURN NULL;
  END IF;
  s := lower(p);

  IF char_length(s) < 3 OR char_length(s) > 30
     OR s !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     OR s ~ '^[0-9]+$' THEN
    RETURN NULL;
  END IF;

  IF public.p18_slug_is_reserved(s) THEN
    RETURN NULL;
  END IF;

  -- 1. current holder
  SELECT true, a.unique_code, a.status
    INTO v_found, v_code, v_stat
    FROM public.referral_agents a
   WHERE lower(a.vanity_slug) = s
   LIMIT 1;
  IF COALESCE(v_found, false) THEN
    IF v_stat IS NOT DISTINCT FROM 'active' THEN
      RETURN v_code;
    END IF;
    RETURN NULL;
  END IF;

  -- 2. newest history row inside the window
  v_days := COALESCE(
    (SELECT CASE WHEN (st.value #>> '{}') ~ '^[0-9]{1,4}$'
                 THEN CASE WHEN (st.value #>> '{}')::int BETWEEN 1 AND 3650 THEN (st.value #>> '{}')::int END
            END
       FROM public.platform_settings st
      WHERE st.key = 'partner_attribution_window_days'),
    90);

  v_found := NULL; v_code := NULL; v_stat := NULL;
  SELECT true, a.unique_code, a.status
    INTO v_found, v_code, v_stat
    FROM public.referral_agent_slug_history h
    JOIN public.referral_agents a ON a.id = h.referral_agent_id
   WHERE lower(h.slug) = s
     AND h.retired_at > now() - make_interval(days => v_days)
   ORDER BY h.retired_at DESC, h.id DESC
   LIMIT 1;
  IF COALESCE(v_found, false) AND v_stat IS NOT DISTINCT FROM 'active' THEN
    RETURN v_code;
  END IF;
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.resolve_partner_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_partner_slug(text) TO anon, authenticated, service_role;

COMMIT;
