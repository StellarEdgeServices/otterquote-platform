-- gh-3321 proof: no $200 Job Referral Fee and no $50 Recruit Bonus on a claim in OK, AR, KS, NE or MS; a blank or NULL state accrues; an allowed state earns both.
-- THROWAWAY Postgres only (see the _run.sh). Phase-aware: BEFORE = the gh3330 body (PR #3337; BASELINE / ROLLBACK), AFTER = the gh3321 body (AFTER / REAPPLIED).
-- The BEFORE rows are the negative controls: today a job in OK earns $200 and $50. Needs -v wfile= -v efile= -v bfile= -v cfile= -v afile= (the pre-flight query files the runner
-- extracts verbatim). Runs inside BEGIN ... ROLLBACK. Output: "name|phase|expected|actual|PASS or FAIL" per check, then "FAILING=<n> of <m>".
\set ON_ERROR_STOP on
BEGIN;
SELECT (position('gh-3321' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure)) > 0)::text AS after \gset
CREATE TEMP TABLE proof_r (n serial, name text, expected text, actual text);
CREATE FUNCTION pg_temp.chk(p_name text, p_before text, p_after text, p_actual text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO proof_r (name, expected, actual)
  VALUES (p_name, CASE WHEN current_setting('proof.after') = 'true' THEN p_after ELSE p_before END, COALESCE(p_actual, '<null>'));
$f$;
SELECT set_config('proof.after', :'after', true);
-- completion is stamped by the service role; the recruit branch updates referral_agents.recruit_earnings, which referral_agents_guard_payout_columns() allows only for service_role or an admin
SELECT set_config('request.jwt.claims', '{"role": "service_role"}', true);
-- the customer-referrer cutoff (gh3245) is pinned out of the way: no referrer below is a customer
INSERT INTO public.platform_settings (key, value) VALUES ('partner_agreement_v4_published_at', to_jsonb('2026-10-30T14:00:00Z'::text))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- one case = one recruiter (R) + one recruited referrer (F) + one referral + one claim in the given state. R holds v4 unless p_recruiter_v4 is false (then the gh3330 gate withholds the $50).
CREATE FUNCTION pg_temp.mk(p_case text, p_idx int, p_state text, p_referrer_type text DEFAULT 're_agent', p_recruiter_v4 boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_r uuid := ('dddddddd-0000-0000-0000-' || lpad(p_idx::text, 12, '0'))::uuid; v_f uuid := ('eeeeeeee-0000-0000-0000-' || lpad(p_idx::text, 12, '0'))::uuid;
        v_ref uuid; v_claim uuid; v_ctr uuid := gen_random_uuid();
BEGIN
  IF p_recruiter_v4 THEN
    INSERT INTO public.referral_agents (id, agent_type, first_name, last_name, email, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation)
    VALUES (v_r, 're_agent', 'Rec', p_case, 'r' || p_idx || '@proof.invalid', 'v4-2026-10', '2026-10-31T00:00:00Z', '{"v4-2026-10": {"accepted_at": "2026-10-31T00:00:00+00:00"}}');
  ELSE
    INSERT INTO public.referral_agents (id, agent_type, first_name, last_name, email, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation)
    VALUES (v_r, 're_agent', 'Rec', p_case, 'r' || p_idx || '@proof.invalid', 'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}}');
  END IF;
  INSERT INTO public.referral_agents (id, agent_type, first_name, last_name, email, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation, recruited_by_id, recruited_at)
  VALUES (v_f, p_referrer_type, 'Ref', p_case, 'f' || p_idx || '@proof.invalid', 'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}}', v_r, '2026-10-01T00:00:00Z');
  INSERT INTO public.referrals (referral_agent_id, status, created_at) VALUES (v_f, 'claim_submitted', '2026-11-01T12:00:00Z') RETURNING id INTO v_ref;
  INSERT INTO public.claims (referral_id, selected_contractor_id, created_at, property_state) VALUES (v_ref, v_ctr, '2026-11-01T13:00:00Z', p_state) RETURNING id INTO v_claim;
  INSERT INTO public.quotes (claim_id, contractor_id, status, total_price) VALUES (v_claim, v_ctr, 'selected', 15000);
  UPDATE public.claims SET completion_date = now() WHERE id = v_claim;
  PERFORM set_config('proof.ref_' || p_case, v_ref::text, true);
  PERFORM set_config('proof.idx_' || p_case, p_idx::text, true);
  RETURN v_ref;
END $f$;
-- outcome: commission_amount | recruit amount | referral payout rows | recruit payout rows | recruiter's recruit_earnings
CREATE FUNCTION pg_temp.outcome(p_case text) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE(r.commission_amount::int::text, 'none') || '|' || COALESCE(r.recruit_commission_amount, 0)::int::text
      || '|' || (SELECT count(*) FROM public.payout_approvals p WHERE p.referral_id = r.id AND p.payout_type = 'commission_referral')::text
      || '|' || (SELECT count(*) FROM public.payout_approvals p WHERE p.referral_id = r.id AND p.payout_type = 'commission_recruit')::text
      || '|' || (SELECT COALESCE(a.recruit_earnings, 0)::int::text FROM public.referral_agents a
                  WHERE a.id = ('dddddddd-0000-0000-0000-' || lpad(current_setting('proof.idx_' || p_case), 12, '0'))::uuid)
    FROM public.referrals r WHERE r.id = current_setting('proof.ref_' || p_case)::uuid
$f$;

SELECT pg_temp.mk('ok', 1, 'OK');
SELECT pg_temp.mk('ar', 2, 'AR');
SELECT pg_temp.mk('ks', 3, 'KS');
SELECT pg_temp.mk('ne', 4, 'NE');
SELECT pg_temp.mk('ms', 5, 'MS');
SELECT pg_temp.mk('okpad', 6, ' ok ');                   -- lower case and padded: upper(btrim()) still excludes it
SELECT pg_temp.mk('in', 7, 'IN');                        -- allowed state (negative control)
SELECT pg_temp.mk('tx', 8, 'TX');                        -- another allowed state
SELECT pg_temp.mk('blank', 9, '   ');                    -- blank: accrues (Dustin)
SELECT pg_temp.mk('null', 10, NULL);                     -- NULL: accrues (Dustin)
SELECT pg_temp.mk('insp_ok', 11, 'OK', 'home_inspector'); -- inspector referrer in OK: no $200 (D-333); the recruiter's $50 is now withheld too
SELECT pg_temp.mk('insp_in', 12, 'IN', 'home_inspector'); -- inspector referrer in IN: no $200, recruiter's $50 as today (control)
SELECT pg_temp.mk('wi_ok', 13, 'OK', 'home_inspector', false);  -- recruiter without v4, inspector referrer, OK: not a release candidate (excluded by the agreement)
SELECT pg_temp.mk('wi_in', 14, 'IN', 'home_inspector', false);  -- recruiter without v4, inspector referrer, IN: a gh3330 withhold, a release candidate
SELECT pg_temp.mk('filled', 15, NULL);                   -- completed with a NULL state (accrues), then the state is filled in as OK: LEGAL-READ 6667606960, query B must still list it
UPDATE public.claims SET property_state = 'OK' WHERE referral_id = current_setting('proof.ref_filled')::uuid;

SELECT pg_temp.chk('A Oklahoma: no $200 fee and no $50 bonus (nothing accrued, no payout rows, no earnings); before: $200 and $50', '200|50|1|1|50', 'none|0|0|0|0', pg_temp.outcome('ok'));
SELECT pg_temp.chk('B Arkansas: no fee and no bonus', '200|50|1|1|50', 'none|0|0|0|0', pg_temp.outcome('ar'));
SELECT pg_temp.chk('C Kansas: no fee and no bonus', '200|50|1|1|50', 'none|0|0|0|0', pg_temp.outcome('ks'));
SELECT pg_temp.chk('D Nebraska: no fee and no bonus', '200|50|1|1|50', 'none|0|0|0|0', pg_temp.outcome('ne'));
SELECT pg_temp.chk('E Mississippi: no fee and no bonus', '200|50|1|1|50', 'none|0|0|0|0', pg_temp.outcome('ms'));
SELECT pg_temp.chk('F '' ok '' (lower case, padded): excluded like OK', '200|50|1|1|50', 'none|0|0|0|0', pg_temp.outcome('okpad'));
SELECT pg_temp.chk('G NEGATIVE CONTROL, Indiana: $200 and $50 both earned', '200|50|1|1|50', '200|50|1|1|50', pg_temp.outcome('in'));
SELECT pg_temp.chk('H NEGATIVE CONTROL, Texas: $200 and $50 both earned', '200|50|1|1|50', '200|50|1|1|50', pg_temp.outcome('tx'));
SELECT pg_temp.chk('I blank state ''   '': accrues $200 and $50 (Dustin: blank accrues, checked at batch review)', '200|50|1|1|50', '200|50|1|1|50', pg_temp.outcome('blank'));
SELECT pg_temp.chk('J NULL state: accrues $200 and $50', '200|50|1|1|50', '200|50|1|1|50', pg_temp.outcome('null'));
SELECT pg_temp.chk('K home_inspector referrer in OK: no $200 (D-333) and the recruiter''s $50 withheld too (before: $50 paid)', 'none|50|0|1|50', 'none|0|0|0|0', pg_temp.outcome('insp_ok'));
SELECT pg_temp.chk('L home_inspector referrer in IN: no $200 and the recruiter''s $50 as today (control)', 'none|50|0|1|50', 'none|50|0|1|50', pg_temp.outcome('insp_in'));
SELECT pg_temp.chk('M the excluded referral is ledgered like the other no-fee branches: status job_completed, job_value set (OK, AR, KS, NE, MS)', '5|job_completed', '5|job_completed',
  (SELECT count(*)::text || '|' || COALESCE(min(r.status), '') FROM public.referrals r
    WHERE r.job_value = 15000 AND r.id IN (SELECT current_setting('proof.ref_' || k)::uuid FROM unnest(ARRAY['ok','ar','ks','ne','ms']) k)));
SELECT pg_temp.chk('N fee email (send-partner-status-email): none for Oklahoma, one for Indiana (the fee is real only there)', '1|1', '0|1',
  (SELECT (SELECT count(*) FROM net.proof_calls c WHERE c.url LIKE '%/send-partner-status-email' AND c.body ->> 'referral_id' = current_setting('proof.ref_ok'))::text || '|'
       || (SELECT count(*) FROM net.proof_calls c WHERE c.url LIKE '%/send-partner-status-email' AND c.body ->> 'referral_id' = current_setting('proof.ref_in'))::text));
-- pre-flight queries, extracted verbatim by the runner: A pre-apply count, B blank-state batch review, C excluded-state ledger, W2 withheld-bonus release candidates
\i :afile
SELECT pg_temp.chk('O pre-apply count A (pre-flight, verbatim): unpaid commission rows attached to claims in the five states (rows|dollars); before: the 6 excluded cases paid $250 each, plus the inspector case''s $50 (wi_ok has none: its recruiter has no v4), plus the blank-then-filled case''s $250; after: only that one, accrued while blank', '15|1800', '2|250',
  (SELECT rows_unpaid::text || '|' || dollars_unpaid::int::text FROM a_rows));
\i :bfile
SELECT pg_temp.chk('P query B (pre-flight, verbatim): pending commission rows on blank or NULL state claims, the batch-review list: blank, NULL and blank-then-filled-as-OK ($200 + $50 each); before the gate a claim in OK is listed too, after it earns nothing and drops off', '8|blank,filled,null,ok', '6|blank,filled,null',
  (SELECT count(*)::text || '|' || COALESCE(string_agg(DISTINCT x.k, ',' ORDER BY x.k), '')
     FROM b_rows b JOIN (VALUES ('blank'),('null'),('filled'),('in'),('ok')) x(k) ON b.referral = current_setting('proof.ref_' || x.k)::uuid));
\i :cfile
SELECT pg_temp.chk('Q query C (pre-flight, verbatim): completed referrals ledgered with no fee in the five states', '2|insp_ok,wi_ok', '8|ar,insp_ok,ks,ms,ne,ok,okpad,wi_ok',
  (SELECT count(*)::text || '|' || COALESCE(string_agg(x.k, ',' ORDER BY x.k), '')
     FROM c_rows c JOIN (VALUES ('ok'),('ar'),('ks'),('ne'),('ms'),('okpad'),('in'),('insp_ok'),('wi_ok'),('wi_in')) x(k) ON c.referral = current_setting('proof.ref_' || x.k)::uuid));
\i :wfile
SELECT pg_temp.chk('R query W2 (pre-flight, verbatim) lists only the gh3330 withhold that is a release candidate (wi_in); wi_ok is excluded by state, and the v4 holders are not withheld', '1|wi_in', '1|wi_in',
  (SELECT count(*)::text || '|' || COALESCE(string_agg(x.k, ',' ORDER BY x.k), '')
     FROM w_rows w JOIN (VALUES ('wi_ok'),('wi_in'),('insp_in'),('insp_ok'),('in')) x(k) ON w.referral = current_setting('proof.ref_' || x.k)::uuid));
SELECT pg_temp.chk('S apply_referral_commission body md5', '7b9bc6957cb15534514f1e1ab9e32bbf', 'fed947cd0851aa492e9217c1f9855597',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure));
SELECT pg_temp.chk('T still SECURITY DEFINER with search_path public, pg_temp', 'true|search_path=public, pg_temp', 'true|search_path=public, pg_temp',
  (SELECT prosecdef::text || '|' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure));

SELECT name || '|' || CASE WHEN current_setting('proof.after') = 'true' THEN 'after' ELSE 'before' END || '|' || expected || '|' || actual || '|'
       || CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END
  FROM proof_r ORDER BY n;
SELECT 'FAILING=' || count(*) FILTER (WHERE expected IS DISTINCT FROM actual) || ' of ' || count(*) FROM proof_r;
ROLLBACK;
