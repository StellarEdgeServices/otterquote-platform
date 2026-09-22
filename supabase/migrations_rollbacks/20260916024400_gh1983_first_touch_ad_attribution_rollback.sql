-- Rollback for 20260916024400_gh1983_first_touch_ad_attribution.sql (gh-1983).
-- Tier 3B when executed (drops columns: the attribution values captured since
-- the forward migration are LOST). Export them first:
--   COPY (SELECT id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
--                fbclid, gclid, first_touch_landing_path, first_touch_referrer,
--                first_touch_at FROM public.profiles WHERE first_touch_at IS NOT NULL) TO STDOUT;
-- Client code calling record_first_touch_attribution() is non-fatal on error,
-- so the frontend tolerates this rollback without a redeploy.
BEGIN;
DROP TRIGGER IF EXISTS trg_claims_copy_first_touch ON public.claims;
DROP FUNCTION IF EXISTS public.claims_copy_first_touch();
DROP FUNCTION IF EXISTS public.record_first_touch_attribution(jsonb);
DROP FUNCTION IF EXISTS public.gh1983_attr_clean(text, int);
ALTER TABLE public.claims
  DROP COLUMN IF EXISTS utm_source, DROP COLUMN IF EXISTS utm_medium,
  DROP COLUMN IF EXISTS utm_campaign, DROP COLUMN IF EXISTS utm_content,
  DROP COLUMN IF EXISTS utm_term, DROP COLUMN IF EXISTS fbclid,
  DROP COLUMN IF EXISTS gclid, DROP COLUMN IF EXISTS first_touch_landing_path,
  DROP COLUMN IF EXISTS first_touch_referrer, DROP COLUMN IF EXISTS first_touch_at;
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS utm_source, DROP COLUMN IF EXISTS utm_medium,
  DROP COLUMN IF EXISTS utm_campaign, DROP COLUMN IF EXISTS utm_content,
  DROP COLUMN IF EXISTS utm_term, DROP COLUMN IF EXISTS fbclid,
  DROP COLUMN IF EXISTS gclid, DROP COLUMN IF EXISTS first_touch_landing_path,
  DROP COLUMN IF EXISTS first_touch_referrer, DROP COLUMN IF EXISTS first_touch_at;
COMMIT;
