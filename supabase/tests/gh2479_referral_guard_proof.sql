-- gh-2479 proof: claims referral_id/completion_date guard + apply_referral_commission checks.
-- Run against production (yeszghaspzwwstvsrioa) in ONE transaction that is forced to roll back.
--   BEFORE the fix : run this file alone.
--   AFTER the fix  : run the migration body (20261003193000_gh2479_referral_guard_and_commission_checks.sql
--                    with its own BEGIN; / COMMIT; lines removed, so nothing can commit) followed by this file,
--                    in the same single statement batch.
-- Everything is is_test: claim 4d764e19 (is_test, owner is_test profile, selected quote >= 10000) and
-- six is_test referrals on is_test re_agent agents. The last statement is a deliberate RAISE EXCEPTION, so the
-- whole batch (migration DDL included) rolls back; the raw findings are the exception text.
-- Expected BEFORE: S1 owner steps ACCEPTED and two accruals; S5/S6/S7 accrue (the bugs); S4/S8 accrue.
-- Expected AFTER : S1 owner steps REJECTED 42501, no accrual; S5/S6/S7 no accrual; S4/S8 still accrue (is_test row).
-- Review round (PR #2502, REVIEW: FAIL 5972835774), cases N1-N5:
--   N1 owner UPDATE that re-sends the UNCHANGED stored referral_id plus a trades change: ACCEPTED before and after, trades persisted.
--   N2 owner backdates claims.created_at: BEFORE accepted, AFTER REJECTED 42501 (window anchor frozen).
--   N3 service_role completes after the N2 attempt, referral 45d older than the claim: BEFORE accrues 200 (reviewer's X3), AFTER no accrual.
--   N4 owner UPDATE that CHANGES referral_id on an existing claim (the trade-selector UPDATE branch with a new cookie): AFTER REJECTED (kept strict, see QUESTIONS).
--   N5 owner INSERT of a claim with a browser-supplied backdated created_at: AFTER created_at is server time (now()), BEFORE it is the backdated value.

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2479-proof@example.invalid')::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row changed)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 90);
  END;
END $f$;

CREATE FUNCTION pg_temp.acc(p_ref uuid) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE r record; n int; s numeric; t text;
BEGIN
  SELECT status, commission_amount INTO r FROM public.referrals WHERE id = p_ref;
  SELECT count(*), COALESCE(sum(amount), 0), string_agg(DISTINCT is_test::text, ',')
    INTO n, s, t FROM public.payout_approvals WHERE referral_id = p_ref;
  RETURN format('referral %s status=%s commission=%s | payout_approvals rows=%s sum=%s is_test=%s',
                left(p_ref::text, 8), r.status, COALESCE(r.commission_amount::text, 'null'), n, s, COALESCE(t, '-'));
END $f$;

DO $proof$
DECLARE
  c_claim  constant uuid := '4d764e19-0549-43db-a967-9ab564f05f23';
  r1 constant uuid := '542e4374-40ef-497e-ad75-083ec981d2c5';
  r2 constant uuid := '81c587fc-8dd0-4fac-a203-70f57f08d2b2';
  r3 constant uuid := '94471cc8-4f59-487c-87ec-8d4b3bd9db92';
  r4 constant uuid := '976bac64-f6b3-4e61-b818-a721cd4aa482';
  r5 constant uuid := '770c7bd8-532b-4f75-8a82-dfca275fcd98';
  r6 constant uuid := '0cf7eeeb-62cd-4eeb-9354-db98889bcd32';
  r7 constant uuid := 'dd14c823-1edb-4cd1-90f1-aaa8ea5273b1';
  v_owner uuid; v_created timestamptz; v_stranger uuid := gen_random_uuid();
  v_out text := ''; v_fx text;
BEGIN
  SELECT user_id, created_at INTO v_owner, v_created FROM public.claims WHERE id = c_claim AND is_test;
  SELECT format('claim_is_test=%s owner_profile_is_test=%s referrals_is_test=%s agents_is_test=%s open_commission=%s',
    (SELECT is_test FROM public.claims WHERE id = c_claim),
    (SELECT is_test FROM public.profiles WHERE id = v_owner),
    (SELECT bool_and(is_test) FROM public.referrals WHERE id IN (r1,r2,r3,r4,r5,r6,r7)),
    (SELECT bool_and(a.is_test) FROM public.referrals r JOIN public.referral_agents a ON a.id = r.referral_agent_id WHERE r.id IN (r1,r2,r3,r4,r5,r6,r7)),
    (SELECT count(*) FROM public.referrals WHERE id IN (r1,r2,r3,r4,r5,r6,r7) AND COALESCE(commission_amount,0) > 0))
    INTO v_fx;
  v_out := v_out || E'\nFIXTURES ' || v_fx;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'GH2479_FIXTURE_MISSING'; END IF;

  -- age the two attack referrals 45 days before the claim, status clicked (expired + unattributed)
  UPDATE public.referrals SET created_at = v_created - interval '45 days', status = 'clicked' WHERE id IN (r1, r2);
  UPDATE public.claims SET completion_date = NULL, referral_id = NULL WHERE id = c_claim;

  -- S3 control: a different authenticated user
  v_out := v_out || E'\nS3 CONTROL stranger UPDATE referral_id: ' ||
    pg_temp.try_as('authenticated', v_stranger, format('UPDATE public.claims SET referral_id = %L WHERE id = %L', r1, c_claim));
  v_out := v_out || E'\nS3 CONTROL stranger UPDATE completion_date: ' ||
    pg_temp.try_as('authenticated', v_stranger, format('UPDATE public.claims SET completion_date = now() WHERE id = %L', c_claim));

  -- S1: the claim owner (role authenticated) attaches a stale referral, completes, re-opens, swaps, completes again
  v_out := v_out || E'\nS1 OWNER set referral_id=R1: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.claims SET referral_id = %L WHERE id = %L', r1, c_claim));
  v_out := v_out || E'\nS1 OWNER set completion_date: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.claims SET completion_date = now() WHERE id = %L', c_claim));
  v_out := v_out || E'\nS1 OWNER null completion_date: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.claims SET completion_date = NULL WHERE id = %L', c_claim));
  v_out := v_out || E'\nS1 OWNER swap referral_id=R2: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.claims SET referral_id = %L WHERE id = %L', r2, c_claim));
  v_out := v_out || E'\nS1 OWNER complete again: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.claims SET completion_date = now() WHERE id = %L', c_claim));
  v_out := v_out || E'\nS1 RESULT ' || pg_temp.acc(r1);
  v_out := v_out || E'\nS1 RESULT ' || pg_temp.acc(r2);

  -- scenarios driven as service_role (the legitimate writer: mark-job-complete) so the guard is not what is tested
  -- S4 legit: R3 clicked 10 days before the claim, attributed (claim_submitted)
  UPDATE public.claims SET completion_date = NULL, referral_id = NULL WHERE id = c_claim;
  UPDATE public.referrals SET created_at = v_created - interval '10 days' WHERE id = r3;
  PERFORM pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET referral_id = %L WHERE id = %L', r3, c_claim));
  UPDATE public.referrals SET status = 'claim_submitted' WHERE id = r3;
  v_out := v_out || E'\nS4 LEGIT service_role complete, in-window attributed: ' ||
    pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET completion_date = now() WHERE id = %L', c_claim));
  v_out := v_out || E'\nS4 RESULT ' || pg_temp.acc(r3);

  -- S5: R4 clicked 45 days before the claim but status claim_submitted (window is the only failing check)
  UPDATE public.claims SET completion_date = NULL, referral_id = NULL WHERE id = c_claim;
  UPDATE public.referrals SET created_at = v_created - interval '45 days' WHERE id = r4;
  PERFORM pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET referral_id = %L WHERE id = %L', r4, c_claim));
  UPDATE public.referrals SET status = 'claim_submitted' WHERE id = r4;
  v_out := v_out || E'\nS5 service_role complete, referral 45d before claim: ' ||
    pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET completion_date = now() WHERE id = %L', c_claim));
  v_out := v_out || E'\nS5 RESULT ' || pg_temp.acc(r4);

  -- S6: R5 in window but status clicked (status is the only failing check)
  UPDATE public.claims SET completion_date = NULL, referral_id = NULL WHERE id = c_claim;
  UPDATE public.referrals SET created_at = v_created - interval '10 days' WHERE id = r5;
  PERFORM pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET referral_id = %L WHERE id = %L', r5, c_claim));
  UPDATE public.referrals SET status = 'clicked' WHERE id = r5;
  v_out := v_out || E'\nS6 service_role complete, in-window but status=clicked: ' ||
    pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET completion_date = now() WHERE id = %L', c_claim));
  v_out := v_out || E'\nS6 RESULT ' || pg_temp.acc(r5);

  -- S7: R6 in window, attributed, but referral.is_test=false against a test claim (is_test is the only failing check)
  UPDATE public.claims SET completion_date = NULL, referral_id = NULL WHERE id = c_claim;
  UPDATE public.referrals SET created_at = v_created - interval '10 days' WHERE id = r6;
  PERFORM pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET referral_id = %L WHERE id = %L', r6, c_claim));
  UPDATE public.referrals SET status = 'claim_submitted', is_test = false WHERE id = r6;
  v_out := v_out || E'\nS7 service_role complete, referral is_test=false vs test claim: ' ||
    pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET completion_date = now() WHERE id = %L', c_claim));
  v_out := v_out || E'\nS7 RESULT ' || pg_temp.acc(r6);

  -- S8 trap: claim created 70 days ago, referral clicked 5 days before the claim, completion today
  UPDATE public.claims SET completion_date = NULL, referral_id = NULL, created_at = now() - interval '70 days' WHERE id = c_claim;
  UPDATE public.referrals SET created_at = now() - interval '75 days' WHERE id = r7;
  PERFORM pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET referral_id = %L WHERE id = %L', r7, c_claim));
  UPDATE public.referrals SET status = 'claim_submitted' WHERE id = r7;
  v_out := v_out || E'\nS8 TRAP service_role complete 70d after claim, referral 5d before claim: ' ||
    pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET completion_date = now() WHERE id = %L', c_claim));
  v_out := v_out || E'\nS8 RESULT ' || pg_temp.acc(r7);


  -- ===== review round: N1-N5 =====
  UPDATE public.claims SET completion_date = NULL, referral_id = NULL, created_at = v_created WHERE id = c_claim;
  -- N1: stored referral_id = R3; owner re-sends the SAME value together with a trades change (trade-selector existing-claim save)
  UPDATE public.claims SET referral_id = r3, trades = ARRAY['gh2479_before']::text[] WHERE id = c_claim;
  v_out := v_out || E'\nN1 OWNER save: unchanged referral_id + trades change: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.claims SET referral_id = %L, trades = ARRAY[''gh2479_after'']::text[], updated_at = now() WHERE id = %L', r3, c_claim));
  v_out := v_out || E'\nN1 RESULT trades persisted=' || (SELECT (trades = ARRAY['gh2479_after']::text[])::text FROM public.claims WHERE id = c_claim)
    || ' referral_id still R3=' || (SELECT (referral_id = r3)::text FROM public.claims WHERE id = c_claim);
  -- N4: owner CHANGES referral_id on the existing claim (R3 -> R1)
  v_out := v_out || E'\nN4 OWNER change referral_id R3->R1 on existing claim: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.claims SET referral_id = %L, updated_at = now() WHERE id = %L', r1, c_claim));
  -- N2/N3: attributed referral 45d older than the claim; owner tries to backdate created_at 40d; then service_role completes
  UPDATE public.claims SET completion_date = NULL, referral_id = NULL, created_at = v_created WHERE id = c_claim;
  UPDATE public.referrals SET created_at = v_created - interval '45 days', status = 'claim_submitted', commission_amount = NULL, job_value = NULL WHERE id = r4;
  DELETE FROM public.payout_approvals WHERE referral_id = r4;
  PERFORM pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET referral_id = %L WHERE id = %L', r4, c_claim));
  UPDATE public.referrals SET status = 'claim_submitted' WHERE id = r4;
  v_out := v_out || E'\nN2 OWNER backdates claims.created_at by 40 days: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.claims SET created_at = created_at - interval ''40 days'' WHERE id = %L', c_claim));
  v_out := v_out || E'\nN2 RESULT claims.created_at moved=' || (SELECT (created_at <> v_created)::text FROM public.claims WHERE id = c_claim);
  v_out := v_out || E'\nN3 service_role complete after the backdate attempt, referral 45d before claim: ' ||
    pg_temp.try_as('service_role', v_owner, format('UPDATE public.claims SET completion_date = now() WHERE id = %L', c_claim));
  v_out := v_out || E'\nN3 RESULT ' || pg_temp.acc(r4);
  -- N5: owner INSERT with a browser-supplied backdated created_at
  v_out := v_out || E'\nN5 OWNER INSERT claim with created_at = now() - 40 days: ' ||
    pg_temp.try_as('authenticated', v_owner, format('INSERT INTO public.claims (user_id, is_test, created_at) VALUES (%L, true, now() - interval ''40 days'')', v_owner));
  v_out := v_out || E'\nN5 RESULT newest owner claim created within 1 minute of now()=' ||
    (SELECT (created_at > now() - interval '1 minute')::text FROM public.claims WHERE user_id = v_owner AND id <> c_claim ORDER BY updated_at DESC LIMIT 1);

  RAISE EXCEPTION E'GH2479_FORCED_ROLLBACK%', v_out;
END
$proof$;
