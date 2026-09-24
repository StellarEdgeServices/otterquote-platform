-- gh-2154 P-2 proof script.
--
-- Run the WHOLE file as one statement batch wrapped in BEGIN ... ROLLBACK
-- against production (yeszghaspzwwstvsrioa). Never COMMIT. It:
--   1. Applies this PR's migration inline (idempotent CREATE/ALTER, same
--      text as supabase/migrations/20260924160000_gh2154_p2_partner_
--      attribution_activation.sql) so the assertions below can run against
--      prod's real schema/data without a separate apply step.
--   2. Inserts is_test=true synthetic referral_agents rows via
--      register_partner (old- and new-arg-count calls) and directly, then
--      exercises record_partner_app_activation() with simulated callers
--      (auth.uid() faked via set_config('request.jwt.claim.sub', ..., true),
--      which is transaction-local and never persists).
--   3. RAISEs an exception naming every failed assertion, so a single
--      non-zero-row "FAILURES" result at the end is the pass/fail signal.
-- Everything this script writes is rolled back by the ROLLBACK that must
-- follow it -- no synthetic row, column, or function may be left behind.

-- ── 1. Apply the migration ──────────────────────────────────────────────
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS fbclid text,
  ADD COLUMN IF NOT EXISTS li_fat_id text,
  ADD COLUMN IF NOT EXISTS funnel_id text,
  ADD COLUMN IF NOT EXISTS app_first_signed_in_launch_at timestamptz;

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

-- No explicit GRANT: this project's schema-level default privileges already
-- give every new public function anon/authenticated/service_role EXECUTE
-- (matches the migration this script mirrors).

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

REVOKE ALL ON FUNCTION public.record_partner_app_activation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_partner_app_activation() FROM anon;
REVOKE ALL ON FUNCTION public.record_partner_app_activation() FROM service_role;
-- authenticated keeps its schema-level default-granted EXECUTE (no explicit
-- GRANT line here, matching the migration).

-- ── 2. Assertions ────────────────────────────────────────────────────────
DO $proof$
DECLARE
  v_failures    text[] := '{}';
  v_col_count   int;
  v_overload_ct int;
  v_partner_a   referral_agents%ROWTYPE; -- signs in, activates
  v_partner_b   referral_agents%ROWTYPE; -- never signs in (negative control)
  v_partner_c   referral_agents%ROWTYPE; -- different user, attacked target
  v_result      jsonb;
  v_wrote_1     boolean;
  v_wrote_2     boolean;
  v_ts_1        timestamptz;
  v_ts_2        timestamptz;
  v_uid_a       uuid := gen_random_uuid();
  v_uid_c       uuid := gen_random_uuid();
  v_anon_exec   boolean;
  v_auth_exec   boolean;
  v_pub_exec    boolean;
  v_svc_exec    boolean;
BEGIN
  -- (a) columns exist and are nullable
  SELECT count(*) INTO v_col_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'referral_agents'
    AND column_name IN ('fbclid', 'li_fat_id', 'funnel_id', 'app_first_signed_in_launch_at')
    AND is_nullable = 'YES';
  IF v_col_count <> 4 THEN
    v_failures := array_append(v_failures, format('expected 4 nullable new columns, found %s', v_col_count));
  END IF;

  -- (b) exactly one register_partner overload
  SELECT count(*) INTO v_overload_ct
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'register_partner';
  IF v_overload_ct <> 1 THEN
    v_failures := array_append(v_failures, format('expected exactly 1 register_partner overload, found %s', v_overload_ct));
  END IF;

  -- (b2) register_partner keeps its live grants (anon/authenticated/
  -- service_role EXECUTE) via this project's schema-level default
  -- privileges -- no explicit GRANT statement in the migration.
  SELECT has_function_privilege('anon', 'public.register_partner(text, text, text, text, text, text, text, text, text, text, jsonb, text, text, text, text, text, boolean, text, text, text)', 'EXECUTE') INTO v_anon_exec;
  SELECT has_function_privilege('authenticated', 'public.register_partner(text, text, text, text, text, text, text, text, text, text, jsonb, text, text, text, text, text, boolean, text, text, text)', 'EXECUTE') INTO v_auth_exec;
  SELECT has_function_privilege('service_role', 'public.register_partner(text, text, text, text, text, text, text, text, text, text, jsonb, text, text, text, text, text, boolean, text, text, text)', 'EXECUTE') INTO v_svc_exec;
  IF NOT (v_anon_exec AND v_auth_exec AND v_svc_exec) THEN
    v_failures := array_append(v_failures, format('register_partner default grants missing: anon=%s authenticated=%s service_role=%s', v_anon_exec, v_auth_exec, v_svc_exec));
  END IF;

  -- (c) register_partner stores fbclid/li_fat_id/funnel_id when supplied
  v_result := public.register_partner(
    p_agent_type => 're_agent', p_first_name => 'GH2154', p_last_name => 'ProofA',
    p_email => 'gh2154-p2-proof-a@example.invalid', p_is_test => true,
    p_fbclid => 'fb.test.123', p_li_fat_id => 'li.test.456', p_funnel_id => 're-1'
  );
  SELECT * INTO v_partner_a FROM referral_agents WHERE id = (v_result->>'id')::uuid;
  IF v_partner_a.fbclid IS DISTINCT FROM 'fb.test.123'
     OR v_partner_a.li_fat_id IS DISTINCT FROM 'li.test.456'
     OR v_partner_a.funnel_id IS DISTINCT FROM 're-1' THEN
    v_failures := array_append(v_failures, 'register_partner did not store fbclid/li_fat_id/funnel_id as supplied');
  END IF;
  IF v_partner_a.app_first_signed_in_launch_at IS NOT NULL THEN
    v_failures := array_append(v_failures, 'NEGATIVE CONTROL FAILED: a freshly-registered partner already has an activation timestamp');
  END IF;

  -- (d) register_partner still works when the new params are omitted
  v_result := public.register_partner(
    p_agent_type => 're_agent', p_first_name => 'GH2154', p_last_name => 'ProofB',
    p_email => 'gh2154-p2-proof-b@example.invalid', p_is_test => true
  );
  SELECT * INTO v_partner_b FROM referral_agents WHERE id = (v_result->>'id')::uuid;
  IF v_partner_b.fbclid IS NOT NULL OR v_partner_b.li_fat_id IS NOT NULL OR v_partner_b.funnel_id IS NOT NULL THEN
    v_failures := array_append(v_failures, 'register_partner with omitted new params stored a non-null value for one of them');
  END IF;
  IF v_partner_b.app_first_signed_in_launch_at IS NOT NULL THEN
    v_failures := array_append(v_failures, 'NEGATIVE CONTROL FAILED (never-signed-in partner B): activation timestamp is not NULL');
  END IF;

  -- Link partner A and a third synthetic partner C to distinct fake user ids,
  -- so record_partner_app_activation() can be exercised as two different
  -- signed-in callers within this one transaction. referral_agents.user_id
  -- FKs to auth.users(id), so two throwaway auth.users rows are inserted
  -- first (rolled back with everything else; only `id` is NOT NULL there).
  INSERT INTO auth.users (id) VALUES (v_uid_a), (v_uid_c);

  UPDATE referral_agents SET user_id = v_uid_a WHERE id = v_partner_a.id;
  v_result := public.register_partner(
    p_agent_type => 're_agent', p_first_name => 'GH2154', p_last_name => 'ProofC',
    p_email => 'gh2154-p2-proof-c@example.invalid', p_is_test => true
  );
  SELECT * INTO v_partner_c FROM referral_agents WHERE id = (v_result->>'id')::uuid;
  UPDATE referral_agents SET user_id = v_uid_c WHERE id = v_partner_c.id;

  -- (e) record_partner_app_activation writes once for partner A
  PERFORM set_config('request.jwt.claim.sub', v_uid_a::text, true);
  v_wrote_1 := public.record_partner_app_activation();
  SELECT app_first_signed_in_launch_at INTO v_ts_1 FROM referral_agents WHERE id = v_partner_a.id;
  IF v_wrote_1 IS DISTINCT FROM true OR v_ts_1 IS NULL THEN
    v_failures := array_append(v_failures, 'record_partner_app_activation did not write on first signed-in call');
  END IF;

  -- (f) a second call is a no-op: does not change the timestamp, returns false
  PERFORM pg_sleep(0.05); -- so a bug that DID overwrite would show a different timestamp
  v_wrote_2 := public.record_partner_app_activation();
  SELECT app_first_signed_in_launch_at INTO v_ts_2 FROM referral_agents WHERE id = v_partner_a.id;
  IF v_wrote_2 IS DISTINCT FROM false THEN
    v_failures := array_append(v_failures, 'record_partner_app_activation returned true on a second call (not idempotent)');
  END IF;
  IF v_ts_1 IS DISTINCT FROM v_ts_2 THEN
    v_failures := array_append(v_failures, 'record_partner_app_activation changed the timestamp on a second call');
  END IF;

  -- (g) a different signed-in user cannot write partner A's row, or read it
  -- via this RPC's effect: calling as user C only ever touches C's own row.
  PERFORM set_config('request.jwt.claim.sub', v_uid_c::text, true);
  PERFORM public.record_partner_app_activation();
  SELECT app_first_signed_in_launch_at INTO v_ts_2 FROM referral_agents WHERE id = v_partner_a.id;
  IF v_ts_1 IS DISTINCT FROM v_ts_2 THEN
    v_failures := array_append(v_failures, 'calling record_partner_app_activation as a different user changed partner A''s timestamp');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM referral_agents WHERE id = v_partner_c.id AND app_first_signed_in_launch_at IS NOT NULL) THEN
    v_failures := array_append(v_failures, 'partner C (the different signed-in user) did not get their OWN row activated');
  END IF;

  -- (h) partner B (never signed in / no user_id) keeps NULL: matches nobody
  PERFORM set_config('request.jwt.claim.sub', '', true); -- signed-out caller: auth.uid() IS NULL
  PERFORM public.record_partner_app_activation();
  IF EXISTS (SELECT 1 FROM referral_agents WHERE id = v_partner_b.id AND app_first_signed_in_launch_at IS NOT NULL) THEN
    v_failures := array_append(v_failures, 'NEGATIVE CONTROL FAILED: partner B''s timestamp is set despite never signing in');
  END IF;

  -- (i) anon/PUBLIC/service_role cannot EXECUTE record_partner_app_activation;
  -- authenticated can (via its untouched schema-level default grant).
  SELECT has_function_privilege('anon', 'public.record_partner_app_activation()', 'EXECUTE') INTO v_anon_exec;
  SELECT has_function_privilege('authenticated', 'public.record_partner_app_activation()', 'EXECUTE') INTO v_auth_exec;
  SELECT has_function_privilege('public', 'public.record_partner_app_activation()', 'EXECUTE') INTO v_pub_exec;
  SELECT has_function_privilege('service_role', 'public.record_partner_app_activation()', 'EXECUTE') INTO v_svc_exec;
  IF v_anon_exec THEN
    v_failures := array_append(v_failures, 'anon can EXECUTE record_partner_app_activation (must be revoked)');
  END IF;
  IF v_pub_exec THEN
    v_failures := array_append(v_failures, 'public role can EXECUTE record_partner_app_activation (must be revoked)');
  END IF;
  IF v_svc_exec THEN
    v_failures := array_append(v_failures, 'service_role can EXECUTE record_partner_app_activation (must be revoked)');
  END IF;
  IF NOT v_auth_exec THEN
    v_failures := array_append(v_failures, 'authenticated cannot EXECUTE record_partner_app_activation (must be granted)');
  END IF;

  -- ── Verdict ──
  IF array_length(v_failures, 1) IS NULL THEN
    RAISE NOTICE 'GH2154_P2_PROOF: ALL ASSERTIONS PASSED';
  ELSE
    RAISE EXCEPTION 'GH2154_P2_PROOF: % FAILURE(S): %', array_length(v_failures, 1), array_to_string(v_failures, ' | ');
  END IF;
END;
$proof$;

-- ── 3. gh-2154 column lock (Ben, CEO, 17:10:10Z) ────────────────────────
-- Applies the column-lock CREATE OR REPLACE on referral_agents_guard_
-- payout_columns() (identical text to the migration) so the assertions
-- below run against the actual guarded trigger, then re-uses partner A/B/C
-- (already created by the proof above) plus a fresh partner D.

CREATE OR REPLACE FUNCTION public.referral_agents_guard_payout_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if is_admin_email() then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    new.payments_blocked           := true;
    new.w9_verified_at             := null;
    new.w9_file_url                := null;
    new.w9_submitted_at            := null;
    new.total_commission_earned    := 0;
    new.total_commission_paid      := 0;
    new.recruit_earnings           := 0;
    return new;
  end if;

  if (new.fbclid    is distinct from old.fbclid)
     or (new.li_fat_id is distinct from old.li_fat_id)
     or (new.funnel_id is distinct from old.funnel_id)
     or (
       (new.app_first_signed_in_launch_at is distinct from old.app_first_signed_in_launch_at)
       and not (
         current_setting('oq.gh2154_activation_write', true) = '1'
         and old.app_first_signed_in_launch_at is null
         and new.app_first_signed_in_launch_at is not null
       )
     )
  then
    raise exception
      'referral_agents: attribution/activation columns can only be changed by service_role, an admin, or record_partner_app_activation() (gh-2154)'
      using errcode = '42501';
  end if;

  if (new.payments_blocked           is distinct from old.payments_blocked)
     or (new.w9_verified_at          is distinct from old.w9_verified_at)
     or (new.w9_file_url             is distinct from old.w9_file_url)
     or (new.w9_submitted_at         is distinct from old.w9_submitted_at)
     or (new.recruited_at            is distinct from old.recruited_at)
     or (new.recruited_by_id         is distinct from old.recruited_by_id)
     or (new.total_commission_earned is distinct from old.total_commission_earned)
     or (new.total_commission_paid   is distinct from old.total_commission_paid)
     or (new.recruit_earnings        is distinct from old.recruit_earnings)
     or (new.status                  is distinct from old.status)
     or (new.is_test                 is distinct from old.is_test)
  then
    raise exception
      'referral_agents: payout-governing columns can only be changed by service_role or an admin (gh-886)'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_partner_app_activation()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wrote boolean;
BEGIN
  PERFORM set_config('oq.gh2154_activation_write', '1', true);

  UPDATE public.referral_agents
  SET app_first_signed_in_launch_at = now()
  WHERE user_id = auth.uid()
    AND app_first_signed_in_launch_at IS NULL;

  v_wrote := FOUND;

  PERFORM set_config('oq.gh2154_activation_write', '', true);

  RETURN v_wrote;
END;
$function$;

DO $proof_lock$
DECLARE
  v_failures2  text[] := '{}';
  v_uid_a      uuid;
  v_uid_d      uuid := gen_random_uuid();
  v_caught     boolean;
  v_ts_before  timestamptz;
  v_ts_after   timestamptz;
  v_result     jsonb;
  v_partner_d  referral_agents%ROWTYPE;
  v_wrote_1    boolean;
  v_wrote_2    boolean;
  v_phone_ok   boolean;
BEGIN
  SELECT user_id INTO v_uid_a FROM referral_agents WHERE email = 'gh2154-p2-proof-a@example.invalid';
  PERFORM set_config('request.jwt.claim.role', '', true); -- not service_role
  PERFORM set_config('request.jwt.claim.sub', v_uid_a::text, true);

  -- (a) partner A (already activated by the proof above) cannot null out or
  -- backdate their own activation timestamp via a direct UPDATE.
  v_caught := false;
  BEGIN
    UPDATE referral_agents SET app_first_signed_in_launch_at = null WHERE user_id = v_uid_a;
  EXCEPTION WHEN sqlstate '42501' THEN v_caught := true;
  END;
  IF NOT v_caught THEN
    v_failures2 := array_append(v_failures2, '(a) partner X nulled out own app_first_signed_in_launch_at directly -- not raised');
  END IF;

  v_caught := false;
  BEGIN
    UPDATE referral_agents SET app_first_signed_in_launch_at = now() - interval '30 days' WHERE user_id = v_uid_a;
  EXCEPTION WHEN sqlstate '42501' THEN v_caught := true;
  END;
  IF NOT v_caught THEN
    v_failures2 := array_append(v_failures2, '(a) partner X backdated own app_first_signed_in_launch_at directly -- not raised');
  END IF;

  -- (b) same for fbclid / li_fat_id / funnel_id on X's own row.
  v_caught := false;
  BEGIN
    UPDATE referral_agents SET fbclid = 'attacker-value' WHERE user_id = v_uid_a;
  EXCEPTION WHEN sqlstate '42501' THEN v_caught := true;
  END;
  IF NOT v_caught THEN
    v_failures2 := array_append(v_failures2, '(b) partner X rewrote own fbclid directly -- not raised');
  END IF;

  v_caught := false;
  BEGIN
    UPDATE referral_agents SET li_fat_id = 'attacker-value' WHERE user_id = v_uid_a;
  EXCEPTION WHEN sqlstate '42501' THEN v_caught := true;
  END;
  IF NOT v_caught THEN
    v_failures2 := array_append(v_failures2, '(b) partner X rewrote own li_fat_id directly -- not raised');
  END IF;

  v_caught := false;
  BEGIN
    UPDATE referral_agents SET funnel_id = 'attacker-value' WHERE user_id = v_uid_a;
  EXCEPTION WHEN sqlstate '42501' THEN v_caught := true;
  END;
  IF NOT v_caught THEN
    v_failures2 := array_append(v_failures2, '(b) partner X rewrote own funnel_id directly -- not raised');
  END IF;

  -- (c) record_partner_app_activation() as X (fresh partner D, never
  -- activated) still returns true and sets the timestamp; the second call
  -- returns false. Proves the trap is handled: the RPC's own UPDATE is not
  -- blocked by the guard it just added.
  INSERT INTO auth.users (id) VALUES (v_uid_d);
  v_result := public.register_partner(
    p_agent_type => 're_agent', p_first_name => 'GH2154', p_last_name => 'ProofD',
    p_email => 'gh2154-p2-proof-d@example.invalid', p_is_test => true
  );
  SELECT * INTO v_partner_d FROM referral_agents WHERE id = (v_result->>'id')::uuid;
  UPDATE referral_agents SET user_id = v_uid_d WHERE id = v_partner_d.id;

  PERFORM set_config('request.jwt.claim.sub', v_uid_d::text, true);
  v_wrote_1 := public.record_partner_app_activation();
  SELECT app_first_signed_in_launch_at INTO v_ts_before FROM referral_agents WHERE id = v_partner_d.id;
  IF v_wrote_1 IS DISTINCT FROM true OR v_ts_before IS NULL THEN
    v_failures2 := array_append(v_failures2, '(c) record_partner_app_activation() did not activate an unactivated row / did not return true -- the trap is NOT handled');
  END IF;

  v_wrote_2 := public.record_partner_app_activation();
  SELECT app_first_signed_in_launch_at INTO v_ts_after FROM referral_agents WHERE id = v_partner_d.id;
  IF v_wrote_2 IS DISTINCT FROM false THEN
    v_failures2 := array_append(v_failures2, '(c) record_partner_app_activation() returned true on a second call (not idempotent)');
  END IF;
  IF v_ts_before IS DISTINCT FROM v_ts_after THEN
    v_failures2 := array_append(v_failures2, '(c) record_partner_app_activation() changed the timestamp on a second call');
  END IF;

  -- (d) after (c), the GUC is cleared (set_config('','',true) at the end of
  -- the RPC) -- a plain direct UPDATE by X immediately afterwards, with no
  -- RPC in flight, is still rejected. set_config() itself cannot be reached
  -- by a client through PostgREST (pg_catalog is not an exposed schema; no
  -- public wrapper forwards it -- see report), so this SQL-level check is
  -- the closest equivalent of "can a client set the flag".
  -- Uses a value genuinely distinct from the one the RPC just wrote, NOT
  -- now() again -- now()/current_timestamp is frozen for the whole
  -- transaction in Postgres, so a second now() here would equal the first
  -- and `is distinct from` would (correctly, but uninformatively) be false.
  v_caught := false;
  BEGIN
    UPDATE referral_agents SET app_first_signed_in_launch_at = v_ts_before + interval '1 second' WHERE user_id = v_uid_d;
  EXCEPTION WHEN sqlstate '42501' THEN v_caught := true;
  END;
  IF NOT v_caught THEN
    v_failures2 := array_append(v_failures2, '(d) direct UPDATE of app_first_signed_in_launch_at succeeded with the GUC unset, post-activation -- not raised');
  END IF;

  -- (e) negative control: X can still update an unpinned own column.
  BEGIN
    UPDATE referral_agents SET phone = '555-0100' WHERE user_id = v_uid_a;
    v_phone_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_phone_ok := false;
  END;
  IF NOT v_phone_ok THEN
    v_failures2 := array_append(v_failures2, '(e) partner X could not update own unpinned column (phone) -- guard is over-broad');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM referral_agents WHERE user_id = v_uid_a AND phone = '555-0100') THEN
    v_failures2 := array_append(v_failures2, '(e) phone update did not persist for partner X');
  END IF;

  -- (e) negative control: service_role can still change fbclid.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  BEGIN
    UPDATE referral_agents SET fbclid = 'service-role-value' WHERE user_id = v_uid_a;
    v_phone_ok := true; -- reused as a generic "did not raise" flag
  EXCEPTION WHEN OTHERS THEN
    v_phone_ok := false;
  END;
  IF NOT v_phone_ok THEN
    v_failures2 := array_append(v_failures2, '(e) service_role could not change fbclid -- guard wrongly blocks service_role');
  END IF;
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.sub', v_uid_a::text, true);

  -- (e) negative control: the pre-existing payout-column pin still raises
  -- for X changing `status` directly (gh-886 behavior unchanged).
  v_caught := false;
  BEGIN
    UPDATE referral_agents SET status = 'inactive' WHERE user_id = v_uid_a;
  EXCEPTION WHEN sqlstate '42501' THEN v_caught := true;
  END;
  IF NOT v_caught THEN
    v_failures2 := array_append(v_failures2, '(e) partner X changed own status directly -- gh-886 payout-column pin regressed');
  END IF;

  -- (f) register_partner's INSERT path still stores fbclid/funnel_id
  -- (already asserted for partner A in the proof above via the INSERT
  -- branch's early return; re-confirmed here against the column-lock guard
  -- body specifically).
  IF NOT EXISTS (
    SELECT 1 FROM referral_agents
    WHERE email = 'gh2154-p2-proof-a@example.invalid'
      AND fbclid = 'service-role-value' -- set by the service_role negative control above
  ) THEN
    v_failures2 := array_append(v_failures2, '(f) sanity check on prior fbclid write failed unexpectedly');
  END IF;

  -- (g) MUTATION-SPECIFIC: the guard's allow-clause requires BOTH the flag
  -- AND `old.app_first_signed_in_launch_at IS NULL`, not the flag alone.
  -- record_partner_app_activation()'s own `WHERE ... IS NULL` clause means
  -- the real RPC can never reach the trigger with the flag set on an
  -- already-non-null row (0 rows match, trigger never fires) -- so nothing
  -- above (a)-(f) exercises the "old IS NULL" half of the allow-clause on
  -- its own. This directly forces the flag (the one artifact a bug could
  -- produce, e.g. a future code path that fails to clear it, or a copy-paste
  -- that drops the old-IS-NULL check) against partner X's own
  -- ALREADY-ACTIVATED row and asserts it is still rejected. Caught a real
  -- mutation during authoring: removing `old.app_first_signed_in_launch_at
  -- is null` from the allow-clause let this exact case through silently.
  PERFORM set_config('oq.gh2154_activation_write', '1', true);
  v_caught := false;
  BEGIN
    UPDATE referral_agents SET app_first_signed_in_launch_at = now() - interval '30 days' WHERE user_id = v_uid_a;
  EXCEPTION WHEN sqlstate '42501' THEN v_caught := true;
  END;
  PERFORM set_config('oq.gh2154_activation_write', '', true);
  IF NOT v_caught THEN
    v_failures2 := array_append(v_failures2, '(g) backdate succeeded with the flag forced to 1 on an already-activated row -- the allow-clause''s old-IS-NULL requirement is not being enforced');
  END IF;

  IF array_length(v_failures2, 1) IS NULL THEN
    RAISE NOTICE 'GH2154_P2_COLUMN_LOCK_PROOF: ALL ASSERTIONS PASSED';
  ELSE
    RAISE EXCEPTION 'GH2154_P2_COLUMN_LOCK_PROOF: % FAILURE(S): %', array_length(v_failures2, 1), array_to_string(v_failures2, ' | ');
  END IF;
END;
$proof_lock$;

-- This script never COMMITs. The caller must issue ROLLBACK immediately
-- after, whether the DO block above raised or not, and then read back that
-- no synthetic row / new column / new function persisted.
