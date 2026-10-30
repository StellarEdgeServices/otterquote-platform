-- gh-3257 proof: get_my_referrals() returns no progress status for an opted-out referral, no job_value for any row, and
-- keeps the partner's own fee fields (opted out or not).
-- THROWAWAY Postgres only, after gh3241_get_my_referrals_opt_out_scratch_setup.sql, the gh3217a live body and the gh3241
-- forward (the state this migration is applied on). Run with `psql -1`: the fixtures are inserted here and the last
-- statement is a deliberate RAISE, so every phase starts empty.
-- Report: 'PROOF-OK all 19 checks passed', or 'PROOF-FAIL' and one 'FAIL <check> got=... want=...' line per failure.
--   BEFORE (gh3241 body, the negative control): P1-P4 and J1-J3 fail (opted-out status and job_value returned); the opted-in
--   control P5, the fee checks C1-C3, the names N1-N2 and S/G pass.
-- Fixtures (all is_test, mirroring the closes-on; every row has a job_value so a leak is visible): partner A owns
--   r1 'Ann Optout'     claims.referral_id = r1, opt_out TRUE, fee EARNED and PAID       -> status NULL, fee shown
--   r2 'Bea Keepme'     claim opt_out FALSE (NEGATIVE CONTROL), fee earned                 -> status kept, fee shown
--   r3 'Cal Viaclaim'   r3.claim_id = c3, opt_out TRUE, no fee yet                         -> status NULL, fee NULL
--   r4 'Dee Neverasked' claim opt_out NULL                                                 -> status kept (NULL is not an opt-out)
--   r5 'Eve Twoclaims'  claims FALSE + TRUE, fee earned, not paid                          -> status NULL, fee shown, paid_at NULL
--   r6 'Fay Metaonly'   metadata.referrer_updates_opt_out = true                           -> status NULL
--   r7 'Gus Noclaim'    no claim, metadata false                                           -> status kept
-- partner B owns r8 'Hal Other' (opt_out TRUE, fee earned). Partner A must never see r8.
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
  ('a3257000-0000-4000-8000-00000000000a', 'gh3257-a@example.invalid'),
  ('a3257000-0000-4000-8000-00000000000b', 'gh3257-b@example.invalid'),
  ('a3257000-0000-4000-8000-0000000000ff', 'gh3257-h@example.invalid');
INSERT INTO public.referral_agents(id, user_id, agent_type, is_test) VALUES
  ('b3257000-0000-4000-8000-00000000000a', 'a3257000-0000-4000-8000-00000000000a', 're_agent', true),
  ('b3257000-0000-4000-8000-00000000000b', 'a3257000-0000-4000-8000-00000000000b', 're_agent', true);
INSERT INTO public.referrals(id, referral_agent_id, homeowner_name, homeowner_email, status, job_value, commission_amount, commission_paid_at,
                             recruit_commission_amount, recruit_paid_at, created_at, metadata, claim_id, is_test) VALUES
  ('c3257000-0000-4000-8000-000000000001', 'b3257000-0000-4000-8000-00000000000a', 'Ann Optout',     'ann@example.invalid', 'commission_paid', 18001, 201, '2026-10-01 12:00:00+00', 51, '2026-10-02 12:00:00+00', now() - interval '1 min', NULL, NULL, true),
  ('c3257000-0000-4000-8000-000000000002', 'b3257000-0000-4000-8000-00000000000a', 'Bea Keepme',     'bea@example.invalid', 'job_completed',   18002, 202, NULL, NULL, NULL, now() - interval '2 min', NULL, NULL, true),
  ('c3257000-0000-4000-8000-000000000003', 'b3257000-0000-4000-8000-00000000000a', 'Cal Viaclaim',   'cal@example.invalid', 'contract_signed', 18003, NULL, NULL, NULL, NULL, now() - interval '3 min', NULL, 'd3257000-0000-4000-8000-000000000003', true),
  ('c3257000-0000-4000-8000-000000000004', 'b3257000-0000-4000-8000-00000000000a', 'Dee Neverasked', 'dee@example.invalid', 'claim_submitted', 18004, NULL, NULL, NULL, NULL, now() - interval '4 min', NULL, NULL, true),
  ('c3257000-0000-4000-8000-000000000005', 'b3257000-0000-4000-8000-00000000000a', 'Eve Twoclaims',  'eve@example.invalid', 'job_completed',   18005, 205, NULL, NULL, NULL, now() - interval '5 min', NULL, NULL, true),
  ('c3257000-0000-4000-8000-000000000006', 'b3257000-0000-4000-8000-00000000000a', 'Fay Metaonly',   'fay@example.invalid', 'bid_received',    18006, NULL, NULL, NULL, NULL, now() - interval '6 min', '{"referrer_updates_opt_out": true}', NULL, true),
  ('c3257000-0000-4000-8000-000000000007', 'b3257000-0000-4000-8000-00000000000a', 'Gus Noclaim',    'gus@example.invalid', 'clicked',         18007, NULL, NULL, NULL, NULL, now() - interval '7 min', '{"referrer_updates_opt_out": false}', NULL, true),
  ('c3257000-0000-4000-8000-000000000008', 'b3257000-0000-4000-8000-00000000000b', 'Hal Other',      'hal@example.invalid', 'job_completed',   18008, 208, NULL, NULL, NULL, now() - interval '8 min', NULL, NULL, true);
INSERT INTO public.claims(id, user_id, referral_id, referrer_updates_opt_out, is_test, created_at) VALUES
  ('d3257000-0000-4000-8000-000000000001', 'a3257000-0000-4000-8000-0000000000ff', 'c3257000-0000-4000-8000-000000000001', true,  true, now()),
  ('d3257000-0000-4000-8000-000000000002', 'a3257000-0000-4000-8000-0000000000ff', 'c3257000-0000-4000-8000-000000000002', false, true, now()),
  ('d3257000-0000-4000-8000-000000000003', 'a3257000-0000-4000-8000-0000000000ff', NULL,                                   true,  true, now()),
  ('d3257000-0000-4000-8000-000000000004', 'a3257000-0000-4000-8000-0000000000ff', 'c3257000-0000-4000-8000-000000000004', NULL,  true, now()),
  ('d3257000-0000-4000-8000-00000000005a', 'a3257000-0000-4000-8000-0000000000ff', 'c3257000-0000-4000-8000-000000000005', false, true, now()),
  ('d3257000-0000-4000-8000-00000000005b', 'a3257000-0000-4000-8000-0000000000ff', 'c3257000-0000-4000-8000-000000000005', true,  true, now() - interval '1 day'),
  ('d3257000-0000-4000-8000-000000000008', 'a3257000-0000-4000-8000-0000000000ff', 'c3257000-0000-4000-8000-000000000008', true,  true, now());

CREATE FUNCTION pg_temp.a_col(p_ref text, p_expr text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_sess('authenticated', 'a3257000-0000-4000-8000-00000000000a',
    format('select coalesce((%s)::text, ''<NULL>'') from get_my_referrals() where id = %L', p_expr, p_ref))
$f$;
-- opted-out rows: no progress status
INSERT INTO _r SELECT 'P1 opted out via claims.referral_id: status',   pg_temp.a_col('c3257000-0000-4000-8000-000000000001', 'status'), '<NULL>';
INSERT INTO _r SELECT 'P2 opted out via referrals.claim_id: status',   pg_temp.a_col('c3257000-0000-4000-8000-000000000003', 'status'), '<NULL>';
INSERT INTO _r SELECT 'P3 one of two linked claims opted out: status', pg_temp.a_col('c3257000-0000-4000-8000-000000000005', 'status'), '<NULL>';
INSERT INTO _r SELECT 'P4 metadata opt-out true: status',              pg_temp.a_col('c3257000-0000-4000-8000-000000000006', 'status'), '<NULL>';
-- NEGATIVE CONTROL: opted-in rows keep their status
INSERT INTO _r SELECT 'P5 NEGATIVE CONTROL opt-out false: status',     pg_temp.a_col('c3257000-0000-4000-8000-000000000002', 'status'), 'job_completed';
INSERT INTO _r SELECT 'P6 never asked (NULL) / no claim: status',
  pg_temp.a_col('c3257000-0000-4000-8000-000000000004', 'status') || ',' || pg_temp.a_col('c3257000-0000-4000-8000-000000000007', 'status'), 'claim_submitted,clicked';
-- job_value: NULL on every row, opted in or out, for every partner
INSERT INTO _r SELECT 'J1 A rows with a non-NULL job_value (want 0 of 7)',
  pg_temp.as_sess('authenticated', 'a3257000-0000-4000-8000-00000000000a', 'select count(*) filter (where job_value is not null) || '' of '' || count(*) from get_my_referrals()'), '0 of 7';
INSERT INTO _r SELECT 'J2 B rows with a non-NULL job_value (want 0 of 1)',
  pg_temp.as_sess('authenticated', 'a3257000-0000-4000-8000-00000000000b', 'select count(*) filter (where job_value is not null) || '' of '' || count(*) from get_my_referrals()'), '0 of 1';
INSERT INTO _r SELECT 'J3 opted-in control job_value',                 pg_temp.a_col('c3257000-0000-4000-8000-000000000002', 'job_value'), '<NULL>';
-- the partner's own fee stays, opted out or not (shown only once earned = non-NULL)
INSERT INTO _r SELECT 'C1 opted out, fee earned+paid: commission|paid_at|recruit|recruit_paid_at',
  pg_temp.a_col('c3257000-0000-4000-8000-000000000001',
    $$commission_amount || '|' || (commission_paid_at at time zone 'UTC') || '|' || recruit_commission_amount || '|' || (recruit_paid_at at time zone 'UTC')$$),
  '201|2026-10-01 12:00:00|51|2026-10-02 12:00:00';
INSERT INTO _r SELECT 'C2 opted out, fee earned not paid / not earned',
  pg_temp.a_col('c3257000-0000-4000-8000-000000000005', $$commission_amount || '|' || coalesce(commission_paid_at::text, 'unpaid')$$) || ',' ||
  pg_temp.a_col('c3257000-0000-4000-8000-000000000003', 'commission_amount'), '205|unpaid,<NULL>';
INSERT INTO _r SELECT 'C3 opted-in control fee',                       pg_temp.a_col('c3257000-0000-4000-8000-000000000002', 'commission_amount'), '202';
-- gh3241 kept: opted-out rows have no name; the opted-in control does
INSERT INTO _r SELECT 'N1 opted-out names (r1,r3,r5,r6)',
  pg_temp.a_col('c3257000-0000-4000-8000-000000000001', 'display_name') || ',' || pg_temp.a_col('c3257000-0000-4000-8000-000000000003', 'display_name') || ',' ||
  pg_temp.a_col('c3257000-0000-4000-8000-000000000005', 'display_name') || ',' || pg_temp.a_col('c3257000-0000-4000-8000-000000000006', 'display_name'),
  '<NULL>,<NULL>,<NULL>,<NULL>';
INSERT INTO _r SELECT 'N2 NEGATIVE CONTROL opted-in name',             pg_temp.a_col('c3257000-0000-4000-8000-000000000002', 'display_name'), 'Bea K.';
-- every row is still returned, newest first; scope unchanged
INSERT INTO _r SELECT 'S1 A rows: id suffix, newest first',
  pg_temp.as_sess('authenticated', 'a3257000-0000-4000-8000-00000000000a', 'select string_agg(right(id::text, 1), '','') from get_my_referrals()'), '1,2,3,4,5,6,7';
INSERT INTO _r SELECT 'S2 A sees partner B''s referral (want 0)',
  pg_temp.as_sess('authenticated', 'a3257000-0000-4000-8000-00000000000a', 'select count(*) from get_my_referrals() where id = ''c3257000-0000-4000-8000-000000000008'''), '0';
INSERT INTO _r SELECT 'S3 B: own opted-out row status / fee',
  pg_temp.as_sess('authenticated', 'a3257000-0000-4000-8000-00000000000b', 'select coalesce(max(status), ''<NULL>'') || ''/'' || max(commission_amount) from get_my_referrals()'), '<NULL>/208';
-- the contract is unchanged
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
  IF nfail = 0 AND ncheck = 19 THEN
    RAISE EXCEPTION E'GH3257 PROOF (forced rollback) PROOF-OK all % checks passed\n%', ncheck, s USING ERRCODE = 'P0U01';
  ELSE
    RAISE EXCEPTION E'GH3257 PROOF (forced rollback) PROOF-FAIL % of % checks failed\n%', nfail, ncheck, s USING ERRCODE = 'P0U01';
  END IF;
END $f$;
