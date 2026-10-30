-- gh-3245 proof: the customer $200 is gated on Partner Agreement v4 acceptance. THROWAWAY Postgres only (see the _run.sh).
-- Phase-aware: BEFORE = the audited apply_referral_commission() (BASELINE / ROLLBACK), AFTER = the gh3245 body (AFTER / REAPPLIED).
-- The BEFORE rows are the negative controls: every customer referral pays $200 regardless of acceptance.
-- Runs inside BEGIN ... ROLLBACK. Output: "name|phase|expected|actual|PASS or FAIL" per check, then "FAILING=<n> of <m>".
\set ON_ERROR_STOP on
BEGIN;
SELECT (position('gh-3245' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure)) > 0)::text AS after \gset
CREATE TEMP TABLE proof_r (n serial, name text, expected text, actual text);
CREATE FUNCTION pg_temp.chk(p_name text, p_before text, p_after text, p_actual text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO proof_r (name, expected, actual)
  VALUES (p_name, CASE WHEN current_setting('proof.after') = 'true' THEN p_after ELSE p_before END, COALESCE(p_actual, '<null>'));
$f$;
SELECT set_config('proof.after', :'after', true);
-- completion is stamped by the service role in production (admin tools / edge functions); the recruit-bonus branch updates
-- referral_agents.recruit_earnings, which referral_agents_guard_payout_columns() allows only for service_role or an admin
SELECT set_config('request.jwt.claims', '{"role": "service_role"}', true);

-- the cutoff is pinned for the proof (the forward seeds now(); BASELINE has no key, which the old body never reads)
INSERT INTO public.platform_settings (key, value) VALUES ('partner_agreement_v4_published_at', to_jsonb('2026-10-30T14:00:00Z'::text))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- agents: C1 customer accepted v4 before its referral, C2 customer never accepted, C3 customer accepted after its referral,
-- RA re_agent on v3 (non-customer: never gated), RC recruiter of C2 (recruit bonus control)
INSERT INTO public.referral_agents (id, agent_type, first_name, last_name, email, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation, recruited_by_id, recruited_at) VALUES
  ('cccccccc-0000-0000-0000-0000000000c1', 'customer', 'C', 'One',   'c1@proof.invalid', 'v4-2026-10', '2026-10-30T15:00:00Z', '{"v4-2026-10": {"accepted_at": "2026-10-30T15:00:00+00:00"}}', NULL, NULL),
  ('cccccccc-0000-0000-0000-0000000000a9', 're_agent', 'R', 'Cruit', 'rc@proof.invalid', 'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}}', NULL, NULL),
  ('cccccccc-0000-0000-0000-0000000000c2', 'customer', 'C', 'Two',   'c2@proof.invalid', NULL, NULL, '{}', 'cccccccc-0000-0000-0000-0000000000a9', '2026-10-01T00:00:00Z'),
  ('cccccccc-0000-0000-0000-0000000000c3', 'customer', 'C', 'Three', 'c3@proof.invalid', 'v4-2026-10', '2026-11-05T00:00:00Z', '{"v4-2026-10": {"accepted_at": "2026-11-05T00:00:00+00:00"}}', NULL, NULL),
  ('cccccccc-0000-0000-0000-0000000000a1', 're_agent', 'R', 'Agent', 'ra@proof.invalid', 'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}}', NULL, NULL);

-- one referral -> claim -> selected $15,000 bid per case; completing the claim fires after_claim_completed
CREATE FUNCTION pg_temp.mk(p_case text, p_agent uuid, p_ref_at timestamptz) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_ref uuid; v_claim uuid; v_ctr uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.referrals (referral_agent_id, status, created_at) VALUES (p_agent, 'claim_submitted', p_ref_at) RETURNING id INTO v_ref;
  INSERT INTO public.claims (referral_id, selected_contractor_id, created_at) VALUES (v_ref, v_ctr, p_ref_at + interval '1 day') RETURNING id INTO v_claim;
  INSERT INTO public.quotes (claim_id, contractor_id, status, total_price) VALUES (v_claim, v_ctr, 'selected', 15000);
  UPDATE public.claims SET completion_date = now() WHERE id = v_claim;
  PERFORM set_config('proof.ref_' || p_case, v_ref::text, true);
  RETURN v_ref;
END $f$;
CREATE FUNCTION pg_temp.outcome(p_case text) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE(r.commission_amount::int::text, 'none') || '|' || r.status || '|'
      || (SELECT count(*) FROM public.payout_approvals p WHERE p.referral_id = r.id AND p.payout_type = 'commission_referral')::text
    FROM public.referrals r WHERE r.id = current_setting('proof.ref_' || p_case)::uuid
$f$;

SELECT pg_temp.mk('a', 'cccccccc-0000-0000-0000-0000000000c2', '2026-10-29T12:00:00Z');   -- C2, before the cutoff
SELECT pg_temp.mk('b', 'cccccccc-0000-0000-0000-0000000000c2', '2026-11-01T12:00:00Z');   -- C2, after the cutoff, never accepted
SELECT pg_temp.mk('c', 'cccccccc-0000-0000-0000-0000000000c1', '2026-11-01T12:00:00Z');   -- C1, accepted before the referral
SELECT pg_temp.mk('d', 'cccccccc-0000-0000-0000-0000000000c3', '2026-11-01T12:00:00Z');   -- C3, accepted after the referral
SELECT pg_temp.mk('e', 'cccccccc-0000-0000-0000-0000000000a1', '2026-11-01T12:00:00Z');   -- re_agent on v3 (not a customer)
SELECT pg_temp.mk('f', 'cccccccc-0000-0000-0000-0000000000c1', '2026-10-30T15:00:00Z');   -- C1, referral at the exact acceptance instant

SELECT pg_temp.chk('A customer referral before the cutoff is honoured under the old program', '200|job_completed|1', '200|job_completed|1', pg_temp.outcome('a'));
SELECT pg_temp.chk('B customer never accepted v4, referral after the cutoff: no fee, ledgered job_completed', '200|job_completed|1', 'none|job_completed|0', pg_temp.outcome('b'));
SELECT pg_temp.chk('B2 no recruit bonus to C2''s recruiter on the gated referral', '50', '0',
  (SELECT COALESCE(recruit_commission_amount, 0)::int::text FROM public.referrals WHERE id = current_setting('proof.ref_b')::uuid));
SELECT pg_temp.chk('C customer accepted v4 before the referral: $200', '200|job_completed|1', '200|job_completed|1', pg_temp.outcome('c'));
SELECT pg_temp.chk('D customer accepted v4 only after the referral: no fee', '200|job_completed|1', 'none|job_completed|0', pg_temp.outcome('d'));
SELECT pg_temp.chk('E non-customer (re_agent, v3) is untouched by the customer gate', '200|job_completed|1', '200|job_completed|1', pg_temp.outcome('e'));
SELECT pg_temp.chk('F acceptance at the same instant as the referral counts (<=)', '200|job_completed|1', '200|job_completed|1', pg_temp.outcome('f'));

-- G: the cutoff key missing fails closed for customers (even a pre-cutoff referral), never for others
DELETE FROM public.platform_settings WHERE key = 'partner_agreement_v4_published_at';
SELECT pg_temp.mk('g', 'cccccccc-0000-0000-0000-0000000000c2', '2026-10-29T12:00:00Z');
SELECT pg_temp.mk('h', 'cccccccc-0000-0000-0000-0000000000a1', '2026-10-29T12:00:00Z');
SELECT pg_temp.chk('G cutoff missing: customer referral gated (fails closed)', '200|job_completed|1', 'none|job_completed|0', pg_temp.outcome('g'));
SELECT pg_temp.chk('H cutoff missing: non-customer still paid', '200|job_completed|1', '200|job_completed|1', pg_temp.outcome('h'));
-- I: an unreadable cutoff also fails closed
INSERT INTO public.platform_settings (key, value) VALUES ('partner_agreement_v4_published_at', to_jsonb('not a date'::text));
SELECT pg_temp.mk('i', 'cccccccc-0000-0000-0000-0000000000c2', '2026-10-29T12:00:00Z');
SELECT pg_temp.chk('I cutoff unreadable: customer referral gated (fails closed), trigger did not error', 'none-or-200', 'none|job_completed|0',
  CASE WHEN current_setting('proof.after') = 'true' THEN pg_temp.outcome('i') ELSE 'none-or-200' END);

-- J/K: function shape
SELECT pg_temp.chk('J apply_referral_commission body md5', '7f7d0419c59b9853d4082a713258ddd6', '5bf776f5add118541a8a26200b313444',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure));
SELECT pg_temp.chk('K still SECURITY DEFINER with search_path public, pg_temp', 'true|search_path=public, pg_temp', 'true|search_path=public, pg_temp',
  (SELECT prosecdef::text || '|' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure));

SELECT name || '|' || CASE WHEN current_setting('proof.after') = 'true' THEN 'after' ELSE 'before' END || '|' || expected || '|' || actual || '|'
       || CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END
  FROM proof_r ORDER BY n;
SELECT 'FAILING=' || count(*) FILTER (WHERE expected IS DISTINCT FROM actual) || ' of ' || count(*) FROM proof_r;
ROLLBACK;
