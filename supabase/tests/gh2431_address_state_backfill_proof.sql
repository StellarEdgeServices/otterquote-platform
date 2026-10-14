-- gh-2431 proof: backfill and rollback of gh2431_profiles_address_state_backfill, on production, in ONE statement.
-- Single DO block ending in a deliberate RAISE EXCEPTION, so fixtures and the repair roll back whatever the client does;
-- the findings are the exception text. The dollar-quoted bodies are the forward and rollback files without header
-- comments and BEGIN/COMMIT (regenerate if those files change). Fixtures use the otterquote-internal.test domain;
-- ids are generated at run time and never printed. Each starts from a real signup through the auth trigger.
--   A homeowner, IN, untouched since signup      expect cleared by forward, restored by rollback
--   B homeowner, IN, has a city                  expect kept (negative control: the rule must not touch it)
--   C homeowner, IN, updated long after signup   expect kept
--   D homeowner, WA, untouched                   expect kept
-- The report also gives the count of real (non-test) rows the forward rule clears inside the block.
DO $proof$
DECLARE
  v_report text := '';
  v_a uuid := gen_random_uuid(); v_b uuid := gen_random_uuid(); v_c uuid := gen_random_uuid(); v_d uuid := gen_random_uuid();
  v_n_before bigint; v_n_inside bigint; v_real_in_before bigint; v_real_in_after bigint; v_audit bigint;
  v_fwd text := $fwd$
CREATE TABLE IF NOT EXISTS public.gh2431_profiles_state_backfill_audit (
  profile_id  uuid PRIMARY KEY,
  prior_state text NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.gh2431_profiles_state_backfill_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gh2431_profiles_state_backfill_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.gh2431_profiles_state_backfill_audit TO service_role;

WITH hit AS (
  UPDATE public.profiles
     SET address_state = NULL
   WHERE role = 'homeowner'
     AND address_state = 'IN'
     AND address_street IS NULL
     AND address_city IS NULL
     AND address_zip IS NULL
     AND updated_at <= created_at + interval '1 minute'
  RETURNING id
)
INSERT INTO public.gh2431_profiles_state_backfill_audit (profile_id, prior_state)
SELECT id, 'IN' FROM hit;
$fwd$;
  v_rb text := $rb$
UPDATE public.profiles p
   SET address_state = a.prior_state
  FROM public.gh2431_profiles_state_backfill_audit a
 WHERE a.profile_id = p.id
   AND p.address_state IS NULL;

DROP TABLE public.gh2431_profiles_state_backfill_audit;
$rb$;
  v_ids uuid[];
  i int;
  v_s text;
BEGIN
  SELECT count(*) INTO v_n_before FROM public.profiles;
  v_ids := ARRAY[v_a, v_b, v_c, v_d];
  FOR i IN 1..4 LOOP
    INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (v_ids[i], 'authenticated', 'authenticated', 'gh2431-backfill-' || i || '@otterquote-internal.test',
            jsonb_build_object('full_name', 'Proof Fixture'), now(), now());
  END LOOP;
  UPDATE public.profiles SET role = 'homeowner', address_state = 'IN', created_at = now() - interval '5 days', updated_at = now() - interval '5 days' WHERE id = v_a;
  UPDATE public.profiles SET role = 'homeowner', address_state = 'IN', address_city = 'Proofville', created_at = now() - interval '5 days', updated_at = now() - interval '5 days' WHERE id = v_b;
  UPDATE public.profiles SET role = 'homeowner', address_state = 'IN', created_at = now() - interval '5 days', updated_at = now() - interval '1 day' WHERE id = v_c;
  UPDATE public.profiles SET role = 'homeowner', address_state = 'WA', created_at = now() - interval '5 days', updated_at = now() - interval '5 days' WHERE id = v_d;

  SELECT count(*) INTO v_real_in_before FROM public.profiles WHERE role='homeowner' AND address_state='IN' AND NOT coalesce(is_test,false)
     AND address_street IS NULL AND address_city IS NULL AND address_zip IS NULL AND updated_at <= created_at + interval '1 minute';

  v_report := v_report || format(E'\nBEFORE  : A=%s B=%s C=%s D=%s', (SELECT address_state FROM public.profiles WHERE id=v_a),
     (SELECT address_state FROM public.profiles WHERE id=v_b), (SELECT address_state FROM public.profiles WHERE id=v_c), (SELECT address_state FROM public.profiles WHERE id=v_d));

  EXECUTE v_fwd;
  SELECT count(*) INTO v_audit FROM public.gh2431_profiles_state_backfill_audit;
  SELECT count(*) INTO v_real_in_after FROM public.profiles WHERE role='homeowner' AND address_state='IN' AND NOT coalesce(is_test,false)
     AND address_street IS NULL AND address_city IS NULL AND address_zip IS NULL AND updated_at <= created_at + interval '1 minute';
  v_report := v_report || format(E'\nAUDIT ACL: anon_select=%s anon_truncate=%s authenticated_truncate=%s service_role_truncate=%s',
     has_table_privilege('anon','public.gh2431_profiles_state_backfill_audit','SELECT'), has_table_privilege('anon','public.gh2431_profiles_state_backfill_audit','TRUNCATE'),
     has_table_privilege('authenticated','public.gh2431_profiles_state_backfill_audit','TRUNCATE'), has_table_privilege('service_role','public.gh2431_profiles_state_backfill_audit','TRUNCATE'));
  v_report := v_report || format(E'\nFORWARD : A=%s B=%s C=%s D=%s audit_rows=%s real_untouched_IN before=%s after=%s', coalesce((SELECT address_state FROM public.profiles WHERE id=v_a),'<NULL>'),
     (SELECT address_state FROM public.profiles WHERE id=v_b), (SELECT address_state FROM public.profiles WHERE id=v_c), (SELECT address_state FROM public.profiles WHERE id=v_d), v_audit, v_real_in_before, v_real_in_after);

  EXECUTE v_rb;
  v_report := v_report || format(E'\nROLLBACK: A=%s B=%s C=%s D=%s audit_table_exists=%s', (SELECT address_state FROM public.profiles WHERE id=v_a),
     (SELECT address_state FROM public.profiles WHERE id=v_b), (SELECT address_state FROM public.profiles WHERE id=v_c), (SELECT address_state FROM public.profiles WHERE id=v_d),
     to_regclass('public.gh2431_profiles_state_backfill_audit') IS NOT NULL);

  SELECT count(*) INTO v_n_inside FROM public.profiles;
  v_report := v_report || format(E'\nprofiles rows: before=%s inside_block=%s (4 fixtures expected)', v_n_before, v_n_inside);
  RAISE EXCEPTION 'GH2431_BACKFILL_PROOF_FORCED_ROLLBACK%', v_report;
END
$proof$;
