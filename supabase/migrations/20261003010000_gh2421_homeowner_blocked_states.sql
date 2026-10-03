-- gh-2421 (D-344): homeowner state gate flips from "Indiana only" (D-178) to
-- "every state except a blocked list". The blocked list is configuration so a
-- statute search can add a state the same day with no deploy.
--
-- Tier 3A, purely additive: one seeded platform_settings row + one new read
-- function. The RLS allow-list policy on platform_settings is NOT touched
-- (that is a DROP/CREATE POLICY rewrite = tier 3B); the client reads the list
-- through the SECURITY DEFINER function below instead.
--
-- Fail-safe: a missing or malformed row returns the default {FL,LA,TX}; the
-- clients also fall back to the same hard-coded list if the rpc itself fails.
-- A deliberately empty JSON array [] is honored as "nothing blocked".
--
-- Rollback: supabase/migrations_rollbacks/20261003010000_gh2421_homeowner_blocked_states_rollback.sql
-- Pre-flight: 20261003010000_gh2421_homeowner_blocked_states_pre-flight.md
-- NOT APPLIED by the authoring session.

BEGIN;

INSERT INTO public.platform_settings (key, value)
VALUES ('homeowner_blocked_states', '["FL","LA","TX"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_homeowner_blocked_states()
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_default CONSTANT text[] := ARRAY['FL','LA','TX']::text[];
  v_val     jsonb;
  v_codes   text[];
BEGIN
  SELECT value INTO v_val
    FROM public.platform_settings
   WHERE key = 'homeowner_blocked_states';

  -- Missing row or not a JSON array: default.
  IF v_val IS NULL OR jsonb_typeof(v_val) <> 'array' THEN
    RETURN v_default;
  END IF;

  -- Explicit empty array: operator deliberately blocks nothing.
  IF jsonb_array_length(v_val) = 0 THEN
    RETURN ARRAY[]::text[];
  END IF;

  SELECT COALESCE(array_agg(DISTINCT upper(btrim(e)) ORDER BY upper(btrim(e))), ARRAY[]::text[])
    INTO v_codes
    FROM jsonb_array_elements_text(v_val) AS t(e)
   WHERE upper(btrim(e)) ~ '^[A-Z]{2}$';

  -- Non-empty array with no valid 2-letter code is malformed: default.
  IF COALESCE(array_length(v_codes, 1), 0) = 0 THEN
    RETURN v_default;
  END IF;

  RETURN v_codes;
EXCEPTION WHEN OTHERS THEN
  RETURN v_default;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_homeowner_blocked_states() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_homeowner_blocked_states() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_homeowner_blocked_states() TO authenticated;

COMMENT ON FUNCTION public.get_homeowner_blocked_states() IS
  'D-344 / gh-2421: states where homeowners are waitlisted (every other state is open). Reads platform_settings key homeowner_blocked_states; missing/malformed -> {FL,LA,TX}. To add a state, run: UPDATE public.platform_settings SET value = ''["FL","LA","TX","NY"]''::jsonb, updated_at = now() WHERE key = ''homeowner_blocked_states'';';

COMMIT;
