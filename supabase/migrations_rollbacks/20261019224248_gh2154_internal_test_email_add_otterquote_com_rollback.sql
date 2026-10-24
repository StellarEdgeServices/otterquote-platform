-- Rollback for 20261019224248_gh2154_internal_test_email_add_otterquote_com (#2154).
-- Restores public.is_internal_test_email(text) to the gh-2310 Gap 2 rule (4 domains, no otterquote.com),
-- re-deriving Stacy's base local part at apply time exactly as the forward migration does. No data change:
-- rows already born is_test = true under the widened rule stay as they are (flip them by hand if wanted).
BEGIN;

DO $rb$
DECLARE
  c_stacy_id constant uuid := '0a934e11-5cac-4607-a63c-7446fe446f81'::uuid;
  v_email    text;
  v_base     text;
BEGIN
  SELECT email INTO v_email FROM public.referral_agents WHERE id = c_stacy_id;
  IF NOT FOUND OR v_email IS NULL OR btrim(v_email) = '' THEN
    RAISE EXCEPTION 'gh2154 rollback: referral_agents row % missing or blank email', c_stacy_id;
  END IF;
  IF split_part(lower(btrim(v_email)), '@', 2) <> 'gmail.com' THEN
    RAISE EXCEPTION 'gh2154 rollback: referral_agents row % email domain is not gmail.com', c_stacy_id;
  END IF;
  v_base := split_part(split_part(lower(btrim(v_email)), '@', 1), '+', 1);
  IF v_base = '' OR v_base !~ '^[a-z0-9.]+$' THEN
    RAISE EXCEPTION 'gh2154 rollback: referral_agents row % base local part empty or outside [a-z0-9.]', c_stacy_id;
  END IF;

  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION public.is_internal_test_email(p_email text)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $body$
      SELECT CASE
        WHEN p_email IS NULL THEN false
        ELSE
          split_part(lower(btrim(p_email)), '@', 2) IN ('stellaredgeservices.com', 'tryotterquote.com', 'stohlerroof.com', 'otterquote-internal.test')
          OR (
            split_part(lower(btrim(p_email)), '@', 2) = 'gmail.com'
            AND split_part(split_part(lower(btrim(p_email)), '@', 1), '+', 1) IN ('dustinstohler1', %L)
          )
      END
    $body$
  $fn$, v_base);

  IF public.is_internal_test_email('sloane+walk1@otterquote.com') THEN
    RAISE EXCEPTION 'gh2154 rollback: otterquote.com still accepted';
  END IF;
END
$rb$;

REVOKE ALL ON FUNCTION public.is_internal_test_email(text) FROM PUBLIC, anon, authenticated;

COMMIT;
