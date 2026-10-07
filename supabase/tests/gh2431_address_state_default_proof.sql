-- gh-2431 proof: forward and rollback of gh2431_profiles_address_state_default, on production, in ONE statement.
-- Run against production (yeszghaspzwwstvsrioa). It is a single DO block whose last action is a deliberate
-- RAISE EXCEPTION, so every fixture row and both DDL changes roll back whatever the client does; the findings
-- are the exception text. The statements between the dollar-quote markers are the bodies of the forward and
-- rollback files with their header comments and BEGIN/COMMIT lines removed (regenerate if those files change).
-- Each phase signs up a fixture homeowner through the real auth.users trigger and reads profiles.address_state:
--   BEFORE   (live)            expect IN
--   FORWARD  (after forward)   expect NULL; an explicit state written after signup is kept
--   ROLLBACK (after rollback)  expect IN again (the negative control)
-- Fixtures use the otterquote-internal.test domain (is_test is set by the existing profile trigger). No real
-- identifiers appear here; fixture ids are generated at run time and never printed.
DO $proof$
DECLARE
  v_report text := '';
  v_id uuid;
  v_state text;
  v_def text;
  v_md5 text;
  v_after_explicit text;
  v_n_before bigint;
  v_n_inside bigint;
  v_fwd text := $fwd$
ALTER TABLE public.profiles ALTER COLUMN address_state DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NULL),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;
$fwd$;
  v_rb text := $rb$
ALTER TABLE public.profiles ALTER COLUMN address_state SET DEFAULT 'IN'::text;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, address_state, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NULL),
    'IN',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;
$rb$;
BEGIN
  SET LOCAL lock_timeout = '3s';
  SELECT count(*) INTO v_n_before FROM public.profiles;

  FOR i IN 1..3 LOOP
    IF i = 2 THEN EXECUTE v_fwd; END IF;
    IF i = 3 THEN EXECUTE v_rb; END IF;

    SELECT column_default INTO v_def FROM information_schema.columns
     WHERE table_schema='public' AND table_name='profiles' AND column_name='address_state';
    v_md5 := md5(pg_get_functiondef('public.handle_new_user()'::regprocedure));

    v_id := gen_random_uuid();
    INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (v_id, 'authenticated', 'authenticated', 'gh2431-proof-' || i || '@otterquote-internal.test',
            jsonb_build_object('full_name', 'Proof Fixture'), now(), now());
    SELECT address_state INTO v_state FROM public.profiles WHERE id = v_id;

    UPDATE public.profiles SET address_state = 'WA' WHERE id = v_id;
    SELECT address_state INTO v_after_explicit FROM public.profiles WHERE id = v_id;

    v_report := v_report || format(E'\n%s: column_default=%s fn_md5=%s signup_state=%s explicit_WA_kept=%s',
      (ARRAY['BEFORE  ','FORWARD ','ROLLBACK'])[i], coalesce(v_def,'<none>'), v_md5,
      coalesce(v_state,'<NULL>'), (v_after_explicit = 'WA'));
  END LOOP;

  SELECT count(*) INTO v_n_inside FROM public.profiles;
  v_report := v_report || format(E'\nprofiles rows: before=%s inside_block=%s (3 fixtures expected)', v_n_before, v_n_inside);
  RAISE EXCEPTION 'GH2431_PROOF_FORCED_ROLLBACK%', v_report;
END
$proof$;
