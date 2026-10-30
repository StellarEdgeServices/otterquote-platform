-- gh-3241 proof: get_my_referrals() keeps an opted-out homeowner's row and status but returns no name for it.
-- THROWAWAY Postgres only, after gh3241_get_my_referrals_opt_out_scratch_setup.sql and the live function (gh3217a). Run with
-- `psql -1`: the fixtures are inserted here and the last statement is a deliberate RAISE, so every phase starts empty.
-- Report: 'PROOF-OK all 12 checks passed', or 'PROOF-FAIL' and one 'FAIL <check> got=... want=...' line per failure.
--   BEFORE the forward (negative control, the live function): O1, O2, O4, O5, O6, S3 fail (opted-out names shown); O3 passes.
-- Fixtures (all is_test, mirroring the closes-on): partner A owns
--   r1 'Ann Optout'   claim c1 (claims.referral_id = r1) opt_out TRUE           -> no name
--   r2 'Bea Keepme'   claim c2 (claims.referral_id = r2) opt_out FALSE          -> 'Bea K.'   (negative control)
--   r3 'Cal Viaclaim' r3.claim_id = c3 (c3.referral_id NULL) opt_out TRUE       -> no name   (link from the referrals side)
--   r4 'Dee Neverasked' claim c4 opt_out NULL                                  -> 'Dee N.'   (NULL is not an opt-out)
--   r5 'Eve Twoclaims' claims c5a FALSE and c5b TRUE                            -> no name   (any linked claim wins)
--   r6 'Fay Metaonly' no claim, metadata.referrer_updates_opt_out = true        -> no name   (EF fallback source)
--   r7 'Gus Noclaim'  no claim                                                  -> 'Gus N.'
-- partner B owns r8 'Hal Other' (claim opt_out TRUE). Partner A must never see r8.
CREATE TEMP TABLE _r(k text, got text, want text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.as_sess(p_role text, p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := 'ERR ' || SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN coalesce(v, '<NULL>');
END $f$;

INSERT INTO auth.users(id, email) VALUES
  ('a3241000-0000-4000-8000-00000000000a', 'gh3241-a@example.invalid'),
  ('a3241000-0000-4000-8000-00000000000b', 'gh3241-b@example.invalid'),
  ('a3241000-0000-4000-8000-0000000000ff', 'gh3241-h@example.invalid');
INSERT INTO public.referral_agents(id, user_id, agent_type, is_test) VALUES
  ('b3241000-0000-4000-8000-00000000000a', 'a3241000-0000-4000-8000-00000000000a', 're_agent', true),
  ('b3241000-0000-4000-8000-00000000000b', 'a3241000-0000-4000-8000-00000000000b', 're_agent', true);
INSERT INTO public.referrals(id, referral_agent_id, homeowner_name, homeowner_email, status, commission_amount, created_at, metadata, claim_id, is_test) VALUES
  ('c3241000-0000-4000-8000-000000000001', 'b3241000-0000-4000-8000-00000000000a', 'Ann Optout',     'ann@example.invalid', 'claim_submitted', 101, now() - interval '1 min', NULL, NULL, true),
  ('c3241000-0000-4000-8000-000000000002', 'b3241000-0000-4000-8000-00000000000a', 'Bea Keepme',     'bea@example.invalid', 'contract_signed', 102, now() - interval '2 min', NULL, NULL, true),
  ('c3241000-0000-4000-8000-000000000003', 'b3241000-0000-4000-8000-00000000000a', 'Cal Viaclaim',   'cal@example.invalid', 'registered',      103, now() - interval '3 min', NULL, 'd3241000-0000-4000-8000-000000000003', true),
  ('c3241000-0000-4000-8000-000000000004', 'b3241000-0000-4000-8000-00000000000a', 'Dee Neverasked', 'dee@example.invalid', 'claim_submitted', 104, now() - interval '4 min', NULL, NULL, true),
  ('c3241000-0000-4000-8000-000000000005', 'b3241000-0000-4000-8000-00000000000a', 'Eve Twoclaims',  'eve@example.invalid', 'job_completed',   105, now() - interval '5 min', NULL, NULL, true),
  ('c3241000-0000-4000-8000-000000000006', 'b3241000-0000-4000-8000-00000000000a', 'Fay Metaonly',   'fay@example.invalid', 'registered',      106, now() - interval '6 min', '{"referrer_updates_opt_out": true}', NULL, true),
  ('c3241000-0000-4000-8000-000000000007', 'b3241000-0000-4000-8000-00000000000a', 'Gus Noclaim',    'gus@example.invalid', 'clicked',         107, now() - interval '7 min', '{"referrer_updates_opt_out": false}', NULL, true),
  ('c3241000-0000-4000-8000-000000000008', 'b3241000-0000-4000-8000-00000000000b', 'Hal Other',      'hal@example.invalid', 'registered',      108, now() - interval '8 min', NULL, NULL, true);
INSERT INTO public.claims(id, user_id, referral_id, referrer_updates_opt_out, is_test, created_at) VALUES
  ('d3241000-0000-4000-8000-000000000001', 'a3241000-0000-4000-8000-0000000000ff', 'c3241000-0000-4000-8000-000000000001', true,  true, now()),
  ('d3241000-0000-4000-8000-000000000002', 'a3241000-0000-4000-8000-0000000000ff', 'c3241000-0000-4000-8000-000000000002', false, true, now()),
  ('d3241000-0000-4000-8000-000000000003', 'a3241000-0000-4000-8000-0000000000ff', NULL,                                   true,  true, now()),
  ('d3241000-0000-4000-8000-000000000004', 'a3241000-0000-4000-8000-0000000000ff', 'c3241000-0000-4000-8000-000000000004', NULL,  true, now()),
  ('d3241000-0000-4000-8000-00000000005a', 'a3241000-0000-4000-8000-0000000000ff', 'c3241000-0000-4000-8000-000000000005', false, true, now()),
  ('d3241000-0000-4000-8000-00000000005b', 'a3241000-0000-4000-8000-0000000000ff', 'c3241000-0000-4000-8000-000000000005', true,  true, now() - interval '1 day'),
  ('d3241000-0000-4000-8000-000000000008', 'a3241000-0000-4000-8000-0000000000ff', 'c3241000-0000-4000-8000-000000000008', true,  true, now());

-- partner A, the closes-on: opted-out rows have no name, the same shape with opt-out false keeps its name
CREATE FUNCTION pg_temp.a_name(p_ref text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_sess('authenticated', 'a3241000-0000-4000-8000-00000000000a',
    format('select coalesce(display_name, ''<NULL>'') from get_my_referrals() where id = %L', p_ref))
$f$;
INSERT INTO _r SELECT 'O1 opted out via claims.referral_id: name',   pg_temp.a_name('c3241000-0000-4000-8000-000000000001'), '<NULL>';
INSERT INTO _r SELECT 'O2 opted out via referrals.claim_id: name',   pg_temp.a_name('c3241000-0000-4000-8000-000000000003'), '<NULL>';
INSERT INTO _r SELECT 'O3 NEGATIVE CONTROL opt-out false: name',     pg_temp.a_name('c3241000-0000-4000-8000-000000000002'), 'Bea K.';
INSERT INTO _r SELECT 'O4 one of two linked claims opted out: name', pg_temp.a_name('c3241000-0000-4000-8000-000000000005'), '<NULL>';
INSERT INTO _r SELECT 'O5 metadata opt-out true: name',              pg_temp.a_name('c3241000-0000-4000-8000-000000000006'), '<NULL>';
INSERT INTO _r SELECT 'O6 any opted-out name text in A''s result (want 0)',
  pg_temp.as_sess('authenticated', 'a3241000-0000-4000-8000-00000000000a',
    'select count(*) from get_my_referrals() g where to_jsonb(g)::text ~* ''Ann|Cal|Eve|Fay|Optout|Viaclaim|Twoclaims|Metaonly'''), '0';
INSERT INTO _r SELECT 'O7 never asked (NULL) and no-claim rows keep names',
  pg_temp.a_name('c3241000-0000-4000-8000-000000000004') || ',' || pg_temp.a_name('c3241000-0000-4000-8000-000000000007'), 'Dee N.,Gus N.';
-- the status stays: every row is still returned, with its status and the partner's own commission, newest first
INSERT INTO _r SELECT 'S1 A rows: id suffix|status|commission, newest first',
  pg_temp.as_sess('authenticated', 'a3241000-0000-4000-8000-00000000000a',
    'select string_agg(right(id::text, 1) || ''|'' || status || ''|'' || commission_amount, '','' order by created_at desc) from get_my_referrals()'),
  '1|claim_submitted|101,2|contract_signed|102,3|registered|103,4|claim_submitted|104,5|job_completed|105,6|registered|106,7|clicked|107';
INSERT INTO _r SELECT 'S2 A sees partner B''s referral (want 0)',
  pg_temp.as_sess('authenticated', 'a3241000-0000-4000-8000-00000000000a', 'select count(*) from get_my_referrals() where id = ''c3241000-0000-4000-8000-000000000008'''), '0';
INSERT INTO _r SELECT 'S3 B: own opted-out row count / name',
  pg_temp.as_sess('authenticated', 'a3241000-0000-4000-8000-00000000000b', 'select count(*) || ''/'' || coalesce(max(display_name), ''<NULL>'') from get_my_referrals()'), '1/<NULL>';
-- the contract is unchanged: same result columns, EXECUTE for authenticated and service_role only, still SECURITY DEFINER
INSERT INTO _r SELECT 'G1 result signature',
  pg_get_function_result('public.get_my_referrals()'::regprocedure),
  'TABLE(id uuid, status text, created_at timestamp with time zone, display_name text, job_value numeric, commission_amount numeric, commission_paid_at timestamp with time zone, recruit_commission_amount numeric, recruit_paid_at timestamp with time zone, is_test boolean, referral_agent_id uuid)';
INSERT INTO _r SELECT 'G2 EXECUTE anon,authenticated,service_role / secdef',
  has_function_privilege('anon', 'public.get_my_referrals()', 'EXECUTE')::text || ',' ||
  has_function_privilege('authenticated', 'public.get_my_referrals()', 'EXECUTE')::text || ',' ||
  has_function_privilege('service_role', 'public.get_my_referrals()', 'EXECUTE')::text || ' / ' ||
  (SELECT prosecdef::text FROM pg_proc WHERE oid = 'public.get_my_referrals()'::regprocedure), 'false,true,true / true';

DO $f$
DECLARE s text; nfail int; ncheck int;
BEGIN
  SELECT count(*) FILTER (WHERE got IS DISTINCT FROM want), count(*) INTO nfail, ncheck FROM _r;
  SELECT string_agg(CASE WHEN got IS DISTINCT FROM want THEN 'FAIL ' || k || ' got=' || coalesce(got,'NULL') || ' want=' || want
                         ELSE 'ok   ' || k || ' => ' || got END, E'\n' ORDER BY k) INTO s FROM _r;
  IF nfail = 0 AND ncheck = 12 THEN
    RAISE EXCEPTION E'GH3241 PROOF (forced rollback) PROOF-OK all % checks passed\n%', ncheck, s USING ERRCODE = 'P0U01';
  ELSE
    RAISE EXCEPTION E'GH3241 PROOF (forced rollback) PROOF-FAIL % of % checks failed\n%', nfail, ncheck, s USING ERRCODE = 'P0U01';
  END IF;
END $f$;
