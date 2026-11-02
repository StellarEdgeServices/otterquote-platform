-- gh-3330 proof: the $50 recruit bonus is gated on the RECRUITER holding Partner Agreement v4, withheld rather than dropped.
-- THROWAWAY Postgres only (see the _run.sh). Phase-aware: BEFORE = the live apply_referral_commission() (the gh3245 body; BASELINE /
-- ROLLBACK), AFTER = the gh3330 body (AFTER / REAPPLIED). The BEFORE rows are the negative controls: a recruiter with no v4 is paid $50.
-- Runs inside BEGIN ... ROLLBACK. Output: "name|phase|expected|actual|PASS or FAIL" per check, then "FAILING=<n> of <m>".
\set ON_ERROR_STOP on
BEGIN;
SELECT (position('gh-3330' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure)) > 0)::text AS after \gset
CREATE TEMP TABLE proof_r (n serial, name text, expected text, actual text);
CREATE FUNCTION pg_temp.chk(p_name text, p_before text, p_after text, p_actual text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO proof_r (name, expected, actual)
  VALUES (p_name, CASE WHEN current_setting('proof.after') = 'true' THEN p_after ELSE p_before END, COALESCE(p_actual, '<null>'));
$f$;
SELECT set_config('proof.after', :'after', true);
-- completion is stamped by the service role in production; the recruit branch updates referral_agents.recruit_earnings,
-- which referral_agents_guard_payout_columns() allows only for service_role or an admin
SELECT set_config('request.jwt.claims', '{"role": "service_role"}', true);
-- the customer-referrer cutoff (gh3245) is pinned so it is out of the way: every referrer below is a re_agent, never gated
INSERT INTO public.platform_settings (key, value) VALUES ('partner_agreement_v4_published_at', to_jsonb('2026-10-30T14:00:00Z'::text))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- recruiters: V holds v4 (attestation), VF holds v4 only through the flat columns, N never accepted (v3), C a CUSTOMER recruiter with no v4,
-- I a home_inspector recruiter with no v4 (D-333), L accepts v4 LATER (stamped between the two referrals below)
INSERT INTO public.referral_agents (id, agent_type, first_name, last_name, email, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation) VALUES
  ('dddddddd-0000-0000-0000-0000000000a1', 're_agent',       'Rec', 'V4Att',  'v@proof.invalid',  'v4-2026-10', '2026-10-31T00:00:00Z', '{"v4-2026-10": {"accepted_at": "2026-10-31T00:00:00+00:00"}}'),
  ('dddddddd-0000-0000-0000-0000000000a2', 'insurance_agent','Rec', 'V4Flat', 'vf@proof.invalid', 'v4-2026-10', '2026-10-31T00:00:00Z', '{}'),
  ('dddddddd-0000-0000-0000-0000000000a3', 're_agent',       'Rec', 'NoV4',   'n@proof.invalid',  'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}}'),
  ('dddddddd-0000-0000-0000-0000000000a4', 'customer',       'Rec', 'Cust',   'c@proof.invalid',  NULL, NULL, '{}'),
  ('dddddddd-0000-0000-0000-0000000000a5', 'home_inspector', 'Rec', 'Insp',   'i@proof.invalid',  'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}}'),
  ('dddddddd-0000-0000-0000-0000000000a6', 're_agent',       'Rec', 'Later',  'l@proof.invalid',  'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}}');
-- one referrer per recruiter (re_agent on v3, never gated), recruited 2026-10-01
INSERT INTO public.referral_agents (id, agent_type, first_name, last_name, email, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation, recruited_by_id, recruited_at)
SELECT ('eeeeeeee-0000-0000-0000-0000000000' || right(r.id::text, 2))::uuid, 're_agent', 'Ref', 'of ' || right(r.id::text, 2), 'ref' || right(r.id::text, 2) || '@proof.invalid',
       'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}}', r.id, '2026-10-01T00:00:00Z'
  FROM public.referral_agents r WHERE r.id::text LIKE 'dddddddd-%';

CREATE FUNCTION pg_temp.mk(p_case text, p_recruiter_suffix text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_ref uuid; v_claim uuid; v_ctr uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.referrals (referral_agent_id, status, created_at)
  VALUES (('eeeeeeee-0000-0000-0000-0000000000' || p_recruiter_suffix)::uuid, 'claim_submitted', '2026-11-01T12:00:00Z') RETURNING id INTO v_ref;
  INSERT INTO public.claims (referral_id, selected_contractor_id, created_at) VALUES (v_ref, v_ctr, '2026-11-01T13:00:00Z') RETURNING id INTO v_claim;
  INSERT INTO public.quotes (claim_id, contractor_id, status, total_price) VALUES (v_claim, v_ctr, 'selected', 15000);
  UPDATE public.claims SET completion_date = now() WHERE id = v_claim;
  PERFORM set_config('proof.ref_' || p_case, v_ref::text, true);
  RETURN v_ref;
END $f$;
-- outcome: referrer $200 | recruit amount on the referral | recruit payout rows | recruiter's recruit_earnings
CREATE FUNCTION pg_temp.outcome(p_case text, p_recruiter_suffix text) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE(r.commission_amount::int::text, 'none') || '|' || COALESCE(r.recruit_commission_amount, 0)::int::text || '|'
      || (SELECT count(*) FROM public.payout_approvals p WHERE p.referral_id = r.id AND p.payout_type = 'commission_recruit')::text || '|'
      || (SELECT COALESCE(a.recruit_earnings, 0)::int::text FROM public.referral_agents a WHERE a.id = ('dddddddd-0000-0000-0000-0000000000' || p_recruiter_suffix)::uuid)
    FROM public.referrals r WHERE r.id = current_setting('proof.ref_' || p_case)::uuid
$f$;

SELECT pg_temp.mk('v',  'a1');  -- recruiter holds v4 (attestation)
SELECT pg_temp.mk('vf', 'a2');  -- recruiter holds v4 (flat columns only)
SELECT pg_temp.mk('n',  'a3');  -- recruiter never accepted
SELECT pg_temp.mk('c',  'a4');  -- customer recruiter, no v4
SELECT pg_temp.mk('i',  'a5');  -- home_inspector recruiter, no v4
SELECT pg_temp.mk('l1', 'a6');  -- recruiter L has no v4 yet
UPDATE public.referral_agents SET partner_agreement_version = 'v4-2026-10', partner_agreement_accepted_at = now(),
       partner_agreement_attestation = jsonb_build_object('v4-2026-10', jsonb_build_object('accepted_at', now()))
 WHERE id = 'dddddddd-0000-0000-0000-0000000000a6';
SELECT pg_temp.mk('l2', 'a6');  -- the same recruiter L, after accepting v4

SELECT pg_temp.chk('A recruiter holds v4: $200 to the referrer and $50 to the recruiter (control)', '200|50|1|50', '200|50|1|50', pg_temp.outcome('v', 'a1'));
SELECT pg_temp.chk('B recruiter holds v4 through the flat columns only: $50 (control)', '200|50|1|50', '200|50|1|50', pg_temp.outcome('vf', 'a2'));
SELECT pg_temp.chk('C recruiter never accepted v4: $50 withheld (nothing accrued, no payout row); referrer''s $200 untouched', '200|50|1|50', '200|0|0|0', pg_temp.outcome('n', 'a3'));
SELECT pg_temp.chk('D customer recruiter without v4: $50 withheld', '200|50|1|50', '200|0|0|0', pg_temp.outcome('c', 'a4'));
SELECT pg_temp.chk('E home_inspector recruiter, no v4: no bonus before or after (D-333, unchanged)', '200|0|0|0', '200|0|0|0', pg_temp.outcome('i', 'a5'));
SELECT pg_temp.chk('F recruiter L, referral completed BEFORE accepting v4: withheld, and NOT released by the later acceptance (L''s earnings are only the later paid referral)', '200|50|1|100', '200|0|0|50', pg_temp.outcome('l1', 'a6'));
SELECT pg_temp.chk('G recruiter L, referral completed AFTER accepting v4: $50 (earnings count only the paid one)', '200|50|1|100', '200|50|1|50', pg_temp.outcome('l2', 'a6'));
SELECT pg_temp.chk('H the withheld referrals are recoverable by query W (pre-flight): C, D, F listed (n, c, l1); A, B, E, G not', '0|', '3|c,l1,n',
  (SELECT count(*)::text || '|' || COALESCE(string_agg(k, ',' ORDER BY k), '') FROM (
     SELECT x.k FROM (VALUES ('v'),('vf'),('n'),('c'),('i'),('l1'),('l2')) x(k)
       JOIN public.referrals r ON r.id = current_setting('proof.ref_' || x.k)::uuid
       JOIN public.referral_agents rf ON rf.id = r.referral_agent_id
       JOIN public.referral_agents rc ON rc.id = rf.recruited_by_id
      WHERE r.status = 'job_completed' AND r.commission_amount = 200 AND COALESCE(r.recruit_commission_amount, 0) = 0
        AND r.created_at >= rf.recruited_at AND rc.agent_type IS DISTINCT FROM 'home_inspector'
   ) q(k)));
SELECT pg_temp.chk('I fee email (send-partner-status-email) still sent for the withheld case: the referrer''s $200 is real', '1', '1',
  (SELECT count(*)::text FROM net.proof_calls c WHERE c.url LIKE '%/send-partner-status-email' AND c.body ->> 'referral_id' = current_setting('proof.ref_n')));
SELECT pg_temp.chk('J apply_referral_commission body md5', '2eba9b9601c731cb20f45ef5a18c742b', '82c4f0a13589236016b4ec4e1a22d428',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure));
SELECT pg_temp.chk('K still SECURITY DEFINER with search_path public, pg_temp', 'true|search_path=public, pg_temp', 'true|search_path=public, pg_temp',
  (SELECT prosecdef::text || '|' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure));

SELECT name || '|' || CASE WHEN current_setting('proof.after') = 'true' THEN 'after' ELSE 'before' END || '|' || expected || '|' || actual || '|'
       || CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END
  FROM proof_r ORDER BY n;
SELECT 'FAILING=' || count(*) FILTER (WHERE expected IS DISTINCT FROM actual) || ' of ' || count(*) FROM proof_r;
ROLLBACK;
